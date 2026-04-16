import { render } from "ink";
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote, ThinkingTimeoutError } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKSystemMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter, getGitBranchAsync } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { getToolName } from "./utils/getToolName";
import { restoreTerminalState } from "@/ui/terminalState";
import {
    DEFAULT_OPENAI_FALLBACK_MODEL,
    isClaudeOverloadError,
    resolveOpenAiOverloadFallbackMode,
    shouldUseOpenAiOverloadFallback
} from "./utils/overloadFallback";
import { buildClaudeLimitUserMessage, ClaudeLimitError } from "./utils/resultErrorClassifier";
const INIT_PROMPT_PREFIX = '#InitPrompt-';
const TITLE_INSTRUCTION = 'If tool mcp__yoho_remote__change_title is available in this session, call it to set a chat title that represents the current task. If the chat idea changes dramatically, call it again to update the title. If the tool is unavailable in this session, skip title updates.';

function isInitPromptMessage(message: string): boolean {
    return message.trimStart().startsWith(INIT_PROMPT_PREFIX);
}

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'bypassPermissions';
    allowedTools?: string[];
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');
    const sessionSource = process.env.YR_SESSION_SOURCE?.trim() || null;
    const openAiFallbackModel = process.env.YR_CLAUDE_OPENAI_FALLBACK_MODEL?.trim() || DEFAULT_OPENAI_FALLBACK_MODEL;

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let abortFuture: Future<void> | null = null;

    async function abort() {
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        // Reset queue to prevent stale messages from being processed on next launch
        session.queue.reset();
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        // Reset queue to prevent stale messages from being processed on next launch
        session.queue.reset();
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);

    // Create outgoing message queue
    const messageQueue = new OutgoingMessageQueue(
        (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
    );

    // Set up callback to release delayed messages when permission is requested
    permissionHandler.setOnPermissionRequest((toolCallId: string) => {
        messageQueue.releaseToolCall(toolCallId);
    });

    // Resolve git branch async (with timeout) to avoid blocking on NFS openat.
    // Pass it explicitly so the SDKToLogConverter constructor skips its sync detection.
    const gitBranch = await getGitBranchAsync(session.path);
    logger.debug(`[claudeRemoteLauncher] Git branch: ${gitBranch ?? '(none)'}`);

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        gitBranch,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());

    const handleSessionFound = (sessionId: string) => {
        sdkToLogConverter.updateSessionId(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);


    // Handle messages
    let planModeToolCalls = new Set<string>();
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let pendingSidechainStarts = new Map<string, string>();
    let titleInstructionPending = true;

    // Throttle tool_progress messages to avoid flooding the server
    const toolProgressLastSent = new Map<string, number>();
    const TOOL_PROGRESS_THROTTLE_MS = 2000;

    // Merge split assistant messages from OpenAI-style reasoning models.
    // Some backends output two assistant messages with the same response ID:
    //   1st: content=[{type:"thinking",...}]  (reasoning, often empty text)
    //   2nd: content=[{type:"text",...}]       (actual reply)
    // We hold the first message and merge the second's content blocks into it.
    let pendingAssistantMsg: SDKAssistantMessage | null = null;
    let pendingAssistantResponseId: string | null = null;

    const appendTitleInstructionIfNeeded = (messageText: string): string => {
        if (!titleInstructionPending) {
            return messageText;
        }
        if (isInitPromptMessage(messageText)) {
            return messageText;
        }
        const trimmed = messageText.trim();
        if (trimmed === '/clear' || trimmed === '/compact' || trimmed.startsWith('/compact ')) {
            return messageText;
        }
        titleInstructionPending = false;
        return `${messageText}\n\n${TITLE_INSTRUCTION}`;
    };

    function flushPendingAssistant() {
        if (pendingAssistantMsg) {
            const msg = pendingAssistantMsg;
            pendingAssistantMsg = null;
            pendingAssistantResponseId = null;
            processMessage(msg);
        }
    }

    function canBufferAssistantMessage(message: SDKAssistantMessage): boolean {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        if (content.length === 0) {
            return false;
        }

        // Only buffer pure reasoning chunks. Tool calls such as AskUserQuestion
        // must reach PermissionHandler immediately so their tool IDs can be resolved.
        return content.every((block) => block.type === 'thinking');
    }

    function onMessage(message: SDKMessage) {
        // Merge split assistant messages from OpenAI-style reasoning models.
        // Some backends emit two assistant messages with the same message.id:
        //   1st: content=[{type:"thinking",...}]
        //   2nd: content=[{type:"text",...}]
        // We buffer the first and merge the second's content blocks into it.
        if (message.type === 'assistant') {
            const aMsg = message as SDKAssistantMessage;
            const responseId = (aMsg.message as any)?.id as string | undefined;
            if (responseId && pendingAssistantMsg && pendingAssistantResponseId === responseId) {
                // Same response — merge content blocks
                const mergedContent = [
                    ...(pendingAssistantMsg.message.content ?? []),
                    ...(aMsg.message.content ?? [])
                ];
                pendingAssistantMsg = {
                    ...pendingAssistantMsg,
                    message: { ...pendingAssistantMsg.message, content: mergedContent }
                };
                // Flush the merged message now (we've seen both parts)
                flushPendingAssistant();
                return;
            }
            // Different response or first assistant — flush any previous pending
            flushPendingAssistant();
            if (responseId && canBufferAssistantMessage(aMsg)) {
                // Buffer this assistant message in case a continuation follows
                pendingAssistantMsg = aMsg;
                pendingAssistantResponseId = responseId;
                return;
            }
            // No response ID — process immediately (shouldn't happen but be safe)
        } else {
            // Non-assistant message — flush any buffered assistant first
            flushPendingAssistant();
        }

        processMessage(message);
    }

    function processMessage(message: SDKMessage) {

        // Throttle tool_progress to max 1 per 2s per tool_use_id
        if (message.type === 'tool_progress') {
            const toolUseId = (message as any).tool_use_id as string | undefined
            if (toolUseId) {
                const last = toolProgressLastSent.get(toolUseId) ?? 0
                if (Date.now() - last < TOOL_PROGRESS_THROTTLE_MS) return
                toolProgressLastSent.set(toolUseId, Date.now())
            }
        }

        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        if (message.type === 'system') {
            const systemMessage = message as SDKSystemMessage;
            if (typeof systemMessage.model === 'string' && systemMessage.model.trim()) {
                session.updateRuntimeModel(systemMessage.model);
            }
        }

        // Write to permission handler for tool id resolving
        permissionHandler.onMessage(message);

        // Detect plan mode tool call
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            const isSidechain = umessage.parent_tool_use_id !== undefined;
            if (!isSidechain && umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                        logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                        planModeToolCalls.add(c.id! as string);
                    }
                }
            }
        }

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);
                        pendingSidechainStarts.delete(c.tool_use_id);
                        toolProgressLastSent.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        // Convert SDK message to log format and send to client
        let msg = message;

        // Hack plan mode exit
        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                msg = {
                    ...umessage,
                    message: {
                        ...umessage.message,
                        content: umessage.message.content.map((c) => {
                            if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                planModeToolCalls.delete(c.tool_use_id);
                                if (c.content === PLAN_FAKE_REJECT) {
                                    logger.debug('[remote]: hack plan mode exit');
                                    logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                    return {
                                        ...c,
                                        is_error: false,
                                        content: 'Plan approved',
                                        mode: c.mode
                                    }
                                } else {
                                    return c;
                                }
                            }
                            return c;
                        })
                    }
                }
            }
        }

        const parentToolUseId = (message.type === 'assistant' || message.type === 'user')
            ? (message as SDKAssistantMessage | SDKUserMessage).parent_tool_use_id
            : undefined;
        if (parentToolUseId) {
            const pendingSidechainPrompt = pendingSidechainStarts.get(parentToolUseId);
            if (pendingSidechainPrompt) {
                const pendingSidechainMessage = sdkToLogConverter.convertSidechainUserMessage(
                    parentToolUseId,
                    pendingSidechainPrompt
                );
                messageQueue.enqueue(pendingSidechainMessage);
                pendingSidechainStarts.delete(parentToolUseId);
            }
        }

        const logMessage = sdkToLogConverter.convert(msg);

        if (message.type === 'assistant') {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.parent_tool_use_id === undefined && assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent') && block.input && typeof (block.input as any).prompt === 'string') {
                        pendingSidechainStarts.set(block.id!, (block.input as any).prompt);
                    }
                }
            }
        }

        if (logMessage) {
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Check if all tool calls are pre-allowed (e.g. YR MCP tools)
                        // Pre-allowed tools don't need permission delay since they execute immediately
                        const allPreAllowed = assistantMsg.message.content.every((block) => {
                            if (block.type !== 'tool_use') return true;
                            return session.allowedTools?.includes(block.name as string);
                        });

                        if (!allPreAllowed) {
                            // Top-level tool call needing permission - queue with delay
                            messageQueue.enqueue(logMessage, {
                                delay: 250,
                                toolCallIds
                            });
                            return; // Don't queue again below
                        }
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }
    }

    try {
        let pending: {
            message: string;
            mode: EnhancedMode;
        } | null = null;
        let lastKnownMode: EnhancedMode | null = null;
        const lastDispatchedMessageRef: {
            current: {
                message: string;
                mode: EnhancedMode;
            } | null;
        } = {
            current: null
        };

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/claude-code/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(); // Reset permissions before starting new session
                planModeToolCalls.clear();
                ongoingToolCalls.clear();
                pendingSidechainStarts.clear();
                toolProgressLastSent.clear();
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                titleInstructionPending = true;
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    path: session.path,
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    hookSettingsPath: session.hookSettingsPath,
                    executableCommand: session.executableCommand,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (pending) {
                            let p = pending;
                            pending = null;
                            lastDispatchedMessageRef.current = {
                                message: p.message,
                                mode: p.mode
                            };
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            return {
                                ...p,
                                message: appendTitleInstructionIfNeeded(p.message)
                            };
                        }

                        let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                        // Check if mode has changed
                        if (msg) {
                            if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            lastKnownMode = msg.mode;
                            lastDispatchedMessageRef.current = {
                                message: msg.message,
                                mode: msg.mode
                            };
                            permissionHandler.handleModeChange(mode.permissionMode);
                            return {
                                message: appendTitleInstructionIfNeeded(msg.message),
                                mode: msg.mode
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        session.onSessionFound(sessionId);
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                    },
                    onReady: () => {
                        if (!pending && session.queue.size() === 0) {
                            session.client.sendSessionEvent({ type: 'ready' });
                        }
                    },
                    signal: abortController.signal,
                });
                
                // Consume one-time Claude flags after spawn
                session.consumeOneTimeFlags();
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                const errorStack = e instanceof Error ? e.stack : undefined;
                logger.debug('[remote]: launch error -', errorMessage);
                if (errorStack) {
                    logger.debug('[remote]: stack trace:', errorStack);
                }
                console.error('[YohoRemote] Process error:', errorMessage);

                // Handle thinking timeout - restart the process with auto-continue
                if (!exitReason && e instanceof ThinkingTimeoutError) {
                    logger.debug('[remote]: Thinking timeout - restarting Claude process with auto-continue');
                    session.client.sendSessionEvent({
                        type: 'message',
                        message: 'Response timed out. Retrying...'
                    });

                    // Set --resume so the new process picks up conversation history
                    if (session.sessionId) {
                        session.consumeOneTimeFlags();
                        session.claudeArgs = [
                            ...(session.claudeArgs || []),
                            '--resume', session.sessionId
                        ];
                    }

                    // Inject a continue message so the session doesn't block waiting for user input
                    if (lastKnownMode) {
                        session.queue.pushImmediate(
                            'Continue from where you left off. Your previous response timed out.',
                            lastKnownMode
                        );
                    }

                    continue;
                }

                // Handle failed --resume (session file not found / conversation not found)
                if (!exitReason && /no conversation found/i.test(errorMessage)) {
                    logger.debug('[remote]: Resume failed - conversation not found, clearing resume and retrying as new session');
                    session.consumeOneTimeFlags(); // Strip --resume from claudeArgs
                    session.clearSessionId();      // Start fresh
                    session.client.sendSessionEvent({
                        type: 'message',
                        message: 'Previous session not found. Starting a new session...'
                    });
                    continue;
                }

                if (!exitReason && e instanceof ClaudeLimitError) {
                    session.client.sendSessionEvent({
                        type: 'message',
                        message: buildClaudeLimitUserMessage(e)
                    });
                    continue;
                }

                const dispatchedMessage = lastDispatchedMessageRef.current;
                if (
                    !exitReason
                    && dispatchedMessage
                    && shouldUseOpenAiOverloadFallback(sessionSource)
                    && isClaudeOverloadError(errorMessage)
                ) {
                    const overloadFallback = resolveOpenAiOverloadFallbackMode(
                        dispatchedMessage.mode,
                        openAiFallbackModel
                    );

                    if (overloadFallback) {
                        logger.debug(
                            `[remote]: Claude overload detected, applying fallback strategy=${overloadFallback.strategy}, source=${sessionSource}, model=${openAiFallbackModel}`
                        );
                        const retryMessage = overloadFallback.strategy === 'set_fallback_model'
                            ? `Claude 服务过载，正在用备用模型 ${openAiFallbackModel} 重试...`
                            : `Claude 仍然过载，正在切换到 ${openAiFallbackModel} 重试...`;
                        session.client.sendSessionEvent({
                            type: 'message',
                            message: retryMessage
                        });
                        session.queue.pushImmediate(dispatchedMessage.message, overloadFallback.mode);
                        continue;
                    }
                }

                if (!exitReason) {
                    // Truncate long error messages (stderr can be verbose) for the UI
                    const uiMessage = errorMessage.length > 500
                        ? errorMessage.slice(0, 500) + '...'
                        : errorMessage;
                    session.client.sendSessionEvent({ type: 'message', message: `Process exited unexpectedly: ${uiMessage}` });
                    continue;
                }
            } finally {

                logger.debug('[remote]: launch finally');

                // Flush any buffered assistant message from the previous turn
                // Without this, it would leak into the next turn when the first message triggers flushPendingAssistant()
                flushPendingAssistant();

                // Reset thinking state to prevent it from being stuck
                session.onThinkingChange(false);

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();
                pendingSidechainStarts.clear();
                toolProgressLastSent.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                permissionHandler.reset();
                modeHash = null;
                mode = null;
            }
        }
    } finally {

        session.removeSessionFoundCallback(handleSessionFound);

        // Clean up permission handler
        permissionHandler.reset();

        // Reset Terminal
        process.stdin.off('data', abort);
        restoreTerminalState();
        if (hasTTY) {
            try { process.stdin.pause(); } catch {}
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
    }

    return exitReason || 'exit';
}
