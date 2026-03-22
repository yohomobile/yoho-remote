import { EnhancedMode, PermissionMode } from "./loop";
import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, type SDKResultMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { buildMessageContent } from "./utils/imageMessage";

// Timeout for waiting on Claude API response (10 minutes)
const THINKING_TIMEOUT_MS = 10 * 60 * 1000;

export class ThinkingTimeoutError extends Error {
    constructor() {
        super('Claude API response timed out after 10 minutes of no activity');
        this.name = 'ThinkingTimeoutError';
    }
}

export class HitLimitError extends Error {
    constructor(public readonly resultText: string) {
        super(resultText);
        this.name = 'HitLimitError';
    }
}

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    hookSettingsPath: string,
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }
    process.env.DISABLE_AUTOUPDATER = '1';

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;

    // When allowedTools is set (e.g. Brain sessions), we must NOT pass bypassPermissions
    // to the Claude Code process. If we do, Claude Code may skip the --permission-prompt-tool
    // stdio callback after auto-compact, allowing the AI to use tools outside the whitelist.
    // Instead, we pass 'default' so Claude Code always asks us, and our permissionHandler
    // enforces both the whitelist AND the bypass logic for whitelisted tools.
    const hasToolRestrictions = (initial.mode.allowedTools && initial.mode.allowedTools.length > 0) || opts.allowedTools.length > 0;
    const effectivePermissionMode = hasToolRestrictions && initial.mode.permissionMode === 'bypassPermissions'
        ? 'default'
        : initial.mode.permissionMode;
    if (effectivePermissionMode !== initial.mode.permissionMode) {
        logger.debug(`[claudeRemote] Downgraded permissionMode from '${initial.mode.permissionMode}' to '${effectivePermissionMode}' because allowedTools is set — our permissionHandler will enforce bypass internally`);
    }

    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: effectivePermissionMode,
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        abort: opts.signal,
        pathToClaudeCodeExecutable: 'claude',
        settingsPath: opts.hookSettingsPath,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message with image support
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    const initialContent = await buildMessageContent(initial.message, opts.path);
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initialContent,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    // Thinking timeout: if no messages arrive for THINKING_TIMEOUT_MS, throw
    let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
    let thinkingTimeoutReject: ((err: Error) => void) | null = null;
    const resetThinkingTimeout = () => {
        if (thinkingTimer) clearTimeout(thinkingTimer);
        thinkingTimer = setTimeout(() => {
            logger.debug('[claudeRemote] Thinking timeout reached - no messages for 3 minutes');
            if (thinkingTimeoutReject) {
                thinkingTimeoutReject(new ThinkingTimeoutError());
            }
        }, THINKING_TIMEOUT_MS);
    };
    const clearThinkingTimeout = () => {
        if (thinkingTimer) {
            clearTimeout(thinkingTimer);
            thinkingTimer = null;
        }
        thinkingTimeoutReject = null;
    };

    // Track turn duration
    let turnStartTime = Date.now();

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        // Use manual iteration with Promise.race for timeout support
        const iterator = response[Symbol.asyncIterator]();
        resetThinkingTimeout();

        while (true) {
            const timeoutPromise = new Promise<never>((_, reject) => {
                thinkingTimeoutReject = reject;
            });
            const result = await Promise.race([
                iterator.next(),
                timeoutPromise,
            ]);
            if (result.done) break;
            const message = result.value;

            // Reset timeout on each message
            resetThinkingTimeout();

            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                // Emit turn duration event
                const turnDurationMs = Date.now() - turnStartTime;
                opts.onMessage({
                    type: 'system',
                    subtype: 'turn_duration',
                    durationMs: turnDurationMs,
                } as SDKMessage);

                updateThinking(false);
                clearThinkingTimeout(); // No need for timeout while waiting for user
                const resultMsg = message as SDKResultMessage;
                logger.debug('[claudeRemote] Result received, exiting claudeRemote');

                // If the result is an error and the session never started (0 turns),
                // throw so the launcher catch block can handle it (e.g. retry without --resume)
                if (resultMsg.is_error && resultMsg.num_turns === 0) {
                    const errors = (resultMsg as any).errors;
                    const errorText = Array.isArray(errors) ? errors.join('; ') : 'Session failed to start';
                    throw new Error(errorText);
                }

                // Detect hit limit or auth errors — throw so launcher can auto-rotate account
                const resultText = typeof resultMsg.result === 'string' ? resultMsg.result : '';
                if (resultMsg.is_error && /hit your limit|hit.your.limit/i.test(resultText)) {
                    throw new HitLimitError(resultText);
                }
                if (resultMsg.is_error && /does not have access|authentication.*(?:failed|error|invalid)|Failed to authenticate|\b401\b|Invalid.*credentials/i.test(resultText)) {
                    throw new Error(resultText);
                }

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();

                // Push next message with image support
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                turnStartTime = Date.now(); // Reset turn timer
                const nextContent = await buildMessageContent(next.message, opts.path);
                messages.push({ type: 'user', message: { role: 'user', content: nextContent } });
                resetThinkingTimeout(); // Restart timeout after sending new message
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            clearThinkingTimeout();
                            return;
                        }
                    }
                }
            }
        }
        clearThinkingTimeout();
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        clearThinkingTimeout();
        updateThinking(false);
    }
}
