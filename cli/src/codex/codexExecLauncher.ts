/**
 * Codex Exec Launcher
 *
 * Replaces codexRemoteLauncher (which used the broken `mcp-server` mode) with
 * `codex exec --json` subprocess spawning.  Each user turn spawns a new process
 * and parses the JSONL event stream.  Subsequent turns resume the previous
 * session via `codex exec resume <thread_id> --json '<prompt>'`.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { getYohoRemoteCliCommand } from '@/utils/spawnYohoRemoteCLI';
import { startYohoRemoteServer } from '@/claude/utils/startYohoRemoteServer';
import { resolveFileReferences } from '@/claude/utils/fileMessage';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import { restoreTerminalState } from '@/ui/terminalState';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexServiceTierArgs } from './utils/codexServiceTier';
import { buildCodexStartConfig, TITLE_INSTRUCTION } from './utils/codexStartConfig';
import { buildCommandExecutionResult, getCommandExecutionPreview } from './utils/commandExecutionResult';
import { normalizeCodexToolReferences } from './utils/normalizeCodexToolReferences';
import { resolveCodexBinary } from './codexBinary';
import { getYohoAuxMcpServers, VAULT_HTTP_PORT } from '@/utils/yohoMcpServers';
import type { CodexSession } from './session';
import type { EnhancedMode, PermissionMode } from './loop';

const INIT_PROMPT_PREFIX = '#InitPrompt-';

function isInitPromptMessage(message: string): boolean {
    return message.trimStart().startsWith(INIT_PROMPT_PREFIX);
}

// ---------------------------------------------------------------------------
// Codex exec --json event types
// ---------------------------------------------------------------------------

interface ExecItemBase {
    id: string;
    type: string;
    status?: string;
}

interface ExecAgentMessageItem extends ExecItemBase {
    type: 'agent_message';
    text: string;
}

interface ExecMcpToolCallItem extends ExecItemBase {
    type: 'mcp_tool_call';
    server: string;
    tool: string;
    arguments: unknown;
    result: unknown;
}

interface ExecCommandExecutionItem extends ExecItemBase {
    type: 'command_execution';
    command: string;
    output?: unknown;
    exit_code?: number;
    [key: string]: unknown;
}

interface ExecFileEditItem extends ExecItemBase {
    type: 'file_edit';
    file_path?: string;
    diff?: string;
}

interface ExecReasoningItem extends ExecItemBase {
    type: 'reasoning';
    text: string;
}

type ExecItem = ExecAgentMessageItem | ExecMcpToolCallItem | ExecCommandExecutionItem | ExecFileEditItem | ExecReasoningItem | ExecItemBase;

type ExecEvent =
    | { type: 'thread.started'; thread_id: string }
    | { type: 'turn.started' }
    | { type: 'item.started'; item: ExecItem }
    | { type: 'item.completed'; item: ExecItem }
    | { type: 'turn.completed'; usage?: { input_tokens?: number; output_tokens?: number } }
    | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// MCP server config → codex `-c` flags
// ---------------------------------------------------------------------------

function buildMcpConfigFlags(
    mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }>
): string[] {
    const flags: string[] = [];
    for (const [name, cfg] of Object.entries(mcpServers)) {
        flags.push('-c', `mcp_servers.${name}.command="${cfg.command}"`);
        const argsToml = `[${cfg.args.map((a) => `"${a}"`).join(', ')}]`;
        flags.push('-c', `mcp_servers.${name}.args=${argsToml}`);
        if (cfg.cwd) {
            flags.push('-c', `mcp_servers.${name}.cwd="${cfg.cwd}"`);
        }
        if (cfg.env) {
            for (const [k, v] of Object.entries(cfg.env)) {
                flags.push('-c', `mcp_servers.${name}.env.${k}="${v}"`);
            }
        }
    }
    return flags;
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

export async function codexExecLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    if (session.codexArgs && session.codexArgs.length > 0) {
        if (hasCodexCliOverrides(session.codexCliOverrides)) {
            logger.debug(`[codex-exec] CLI args include supported sandbox/approval/service-tier overrides; other args ignored in remote mode.`);
        } else {
            logger.debug(`[codex-exec] Warning: CLI args [${session.codexArgs.join(', ')}] are ignored in remote mode.`);
        }
    }

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    const messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    let exitReason: 'switch' | 'exit' | null = null;
    let shouldExit = false;
    let activeChild: ChildProcess | null = null;
    let activeChildExited = false;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                logger.debug('[codex-exec]: Exiting via Ctrl-C');
                exitReason = 'exit';
                shouldExit = true;
                killActiveChild();
            },
            onSwitchToLocal: async () => {
                logger.debug('[codex-exec]: Switching to local mode');
                exitReason = 'switch';
                shouldExit = true;
                killActiveChild();
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
        process.stdin.setEncoding('utf8');
    }

    function killActiveChild(): void {
        if (activeChild && !activeChildExited) {
            logger.debug('[codex-exec] Killing active child process');
            activeChild.kill('SIGTERM');
            const ref = activeChild;
            setTimeout(() => {
                if (!activeChildExited) {
                    logger.debug('[codex-exec] SIGTERM did not work, sending SIGKILL');
                    ref.kill('SIGKILL');
                }
            }, 3000);
        }
    }

    // ----- MCP servers setup -----
    const yohoRemoteServer = await startYohoRemoteServer(session.client, {
        apiClient: session.api,
        machineId: session.machineId ?? undefined,
        sessionSource: session.sessionSource ?? undefined,
        yohoRemoteSessionId: session.client.sessionId,
        workingDirectory: session.path,
    });
    const bridgeCommand = getYohoRemoteCliCommand(['mcp', '--url', yohoRemoteServer.url]);
    const auxServers = await getYohoAuxMcpServers('codex', {
        apiClient: session.api,
        sessionId: session.client.sessionId,
        orgId: session.client.orgId,
    });
    const mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }> = {
        yoho_remote: {
            command: bridgeCommand.command,
            args: bridgeCommand.args
        },
        ...auxServers
    };

    // Add stdio bridge for remote vault MCP server when local files are absent
    if (!auxServers.yoho_vault) {
        try {
            const host = new URL(process.env.YOHO_REMOTE_URL || '').hostname;
            if (host) {
                const vaultBridge = getYohoRemoteCliCommand(['mcp', '--url', `http://${host}:${VAULT_HTTP_PORT}/mcp`]);
                const vaultBridgeEnv: Record<string, string> = {};
                if (session.client.orgId) vaultBridgeEnv.YOHO_ORG_ID = session.client.orgId;
                mcpServers.yoho_vault = { command: vaultBridge.command, args: vaultBridge.args, env: vaultBridgeEnv };
            }
        } catch { /* invalid URL, skip */ }
    }

    logger.debug('[codex-exec] MCP servers configured', {
        servers: Object.keys(mcpServers),
        details: Object.fromEntries(
            Object.entries(mcpServers).map(([k, v]) => [k, { command: v.command, args: v.args, cwd: v.cwd }])
        )
    });

    // ----- Resolve codex binary -----
    const codexBin = resolveCodexBinary();
    logger.debug(`[codex-exec] Resolved codex binary: ${codexBin.command} (version=${codexBin.version})`);

    // ----- RPC handlers -----
    session.client.rpcHandlerManager.registerHandler('abort', async () => {
        killActiveChild();
    });
    session.client.rpcHandlerManager.registerHandler('switch', async () => {
        exitReason = 'switch';
        shouldExit = true;
        killActiveChild();
    });

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    // ----- Timeout settings -----
    const TURN_TIMEOUT_MS = parseTimeoutEnv('YR_CODEX_TURN_TIMEOUT_MS', 3 * 60 * 60 * 1000);

    // ----- State -----
    let threadId: string | null = null;
    let currentModeHash: string | null = null;
    let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
    let first = true;
    let titleInstructionPending = true;

    const appendTitleInstructionIfNeeded = (messageText: string): string => {
        if (!titleInstructionPending) {
            return messageText;
        }
        if (isInitPromptMessage(messageText)) {
            return messageText;
        }
        titleInstructionPending = false;
        return `${messageText}\n\n${TITLE_INSTRUCTION}`;
    };

    // ----- Main loop -----
    try {
        while (!shouldExit) {
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                console.error('[YR codex-exec] Waiting for messages...');
                const batch = await session.queue.waitForMessagesAndGetAsString();
                console.error('[YR codex-exec] Got batch:', batch ? 'yes' : 'no', 'shouldExit:', shouldExit);
                if (!batch) {
                    if (!shouldExit) {
                        logger.debug('[codex-exec]: Wait returned null while idle; continuing');
                        continue;
                    }
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            // Mode change → reset thread so we start a fresh codex session
            if (threadId && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[codex-exec] Mode changed – will start new codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                threadId = null;
                currentModeHash = null;
                pending = message;
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;
            const resolvedMessage = await resolveFileReferences(message.message, session.path);
            const outgoingPrompt = normalizeCodexToolReferences(
                appendTitleInstructionIfNeeded(resolvedMessage)
            );

            console.error('[YR codex-exec] Processing message:', message.message.slice(0, 50));

            try {
                // Build codex start config to get resolved model/prompt
                const startConfig = buildCodexStartConfig({
                    message: outgoingPrompt,
                    mode: message.mode,
                    first,
                    mcpServers,
                    cliOverrides: session.codexCliOverrides,
                    includeTitleInstruction: false
                });

                // Spawn codex exec process
                const childResult = await spawnCodexExec({
                    codexBin,
                    startConfig,
                    permissionMode: message.mode.permissionMode,
                    mcpServers,
                    threadId,
                    prompt: startConfig.prompt,
                    session,
                    messageBuffer,
                    turnTimeoutMs: TURN_TIMEOUT_MS,
                    onThreadId: (id) => { threadId = id; },
                    onChildSpawned: (child) => {
                        activeChild = child;
                        activeChildExited = false;
                    },
                    shouldExit: () => shouldExit,
                });

                if (childResult.threadId) {
                    threadId = childResult.threadId;
                }

                first = false;
                sendReady();
            } catch (error) {
                logger.warn('[codex-exec] Error in exec turn', {
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    threadId,
                    first,
                    permissionMode: message.mode.permissionMode,
                    messagePreview: message.message.slice(0, 200),
                });
                const errorMessage = error instanceof Error ? error.message : String(error);
                const displayMessage = `Process error: ${errorMessage.slice(0, 200)}`;
                messageBuffer.addMessage(displayMessage, 'status');
                session.sendSessionEvent({ type: 'message', message: displayMessage });

                // On error, clear thread to allow fresh start
                threadId = null;
                currentModeHash = null;
            } finally {
                activeChild = null;
                activeChildExited = true;
                session.onThinkingChange(false);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit,
                    sendReady
                });
            }
        }
    } finally {
        logger.debug('[codex-exec]: cleanup start');
        killActiveChild();
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        yohoRemoteServer.stop();
        restoreTerminalState();
        if (hasTTY) {
            try { process.stdin.pause(); } catch {}
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();
        logger.debug('[codex-exec]: cleanup done');
    }

    return exitReason || 'exit';
}

// ---------------------------------------------------------------------------
// Spawn and parse a single `codex exec --json` turn
// ---------------------------------------------------------------------------

interface SpawnCodexExecOptions {
    codexBin: { command: string; version: string | null; env: NodeJS.ProcessEnv };
    startConfig: {
        prompt: string;
        model?: string;
        model_reasoning_effort?: string;
        service_tier?: 'fast' | 'flex';
    };
    permissionMode: PermissionMode;
    mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }>;
    threadId: string | null;
    prompt: string;
    session: CodexSession;
    messageBuffer: MessageBuffer;
    turnTimeoutMs: number;
    onThreadId: (id: string) => void;
    onChildSpawned: (child: ChildProcess) => void;
    shouldExit: () => boolean;
}

interface SpawnCodexExecResult {
    threadId: string | null;
}

async function spawnCodexExec(opts: SpawnCodexExecOptions): Promise<SpawnCodexExecResult> {
    const {
        codexBin, startConfig, mcpServers, threadId, prompt,
        session, messageBuffer, turnTimeoutMs, onThreadId, onChildSpawned,
        shouldExit, permissionMode
    } = opts;

    const args: string[] = [];

    if (threadId) {
        // Resume existing session
        args.push('exec', 'resume', threadId);
    } else {
        args.push('exec');
    }

    args.push('--json');

    // Permission mode → codex exec flags
    // In exec mode without TTY, approval prompts cause "user cancelled" errors.
    // Map yoho permission modes directly to codex exec flags:
    //   yolo       → --dangerously-bypass-approvals-and-sandbox (skip all approvals + no sandbox)
    //   safe-yolo  → --full-auto + --sandbox workspace-write
    //   read-only  → --sandbox read-only
    //   default    → --sandbox workspace-write
    if (permissionMode === 'yolo') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (permissionMode === 'safe-yolo') {
        args.push('--full-auto');
    } else if (permissionMode === 'read-only') {
        args.push('--sandbox', 'read-only');
    } else {
        args.push('--sandbox', 'workspace-write');
    }

    // Model
    if (startConfig.model) {
        args.push('-m', startConfig.model);
    }

    // MCP servers
    args.push(...buildMcpConfigFlags(mcpServers));

    // Model reasoning effort
    if (startConfig.model_reasoning_effort) {
        args.push('-c', `model_reasoning_effort="${startConfig.model_reasoning_effort}"`);
    }

    if (startConfig.service_tier) {
        args.push(...buildCodexServiceTierArgs(startConfig.service_tier));
    }

    // Prompt
    args.push(prompt);

    logger.debug('[codex-exec] Spawning codex exec', {
        command: codexBin.command,
        version: codexBin.version,
        args,
        cwd: session.path,
        permissionMode,
        threadId,
        model: startConfig.model ?? '(default)',
        reasoningEffort: startConfig.model_reasoning_effort ?? '(default)',
        serviceTier: startConfig.service_tier ?? '(default)',
        codexHome: codexBin.env.CODEX_HOME ?? '(not set)',
    });

    let resultThreadId: string | null = threadId;

    // Generate a unique prefix per turn so callIds (item_0, item_1, ...) don't
    // collide across turns in the frontend's toolBlocksById map.
    const turnPrefix = randomUUID().slice(0, 8);

    return new Promise<SpawnCodexExecResult>((resolve, reject) => {
        const child = spawn(codexBin.command, args, {
            cwd: session.path,
            env: codexBin.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        onChildSpawned(child);

        // Close stdin immediately — exec mode reads prompt from args
        child.stdin?.end();

        let stderrChunks: string[] = [];
        let turnTimedOut = false;
        let resolved = false;
        let eventCount = 0;
        const eventTypes: string[] = [];

        const turnTimer = turnTimeoutMs > 0
            ? setTimeout(() => {
                turnTimedOut = true;
                logger.warn(`[codex-exec] Turn timed out after ${turnTimeoutMs}ms — killing child`);
                child.kill('SIGTERM');
            }, turnTimeoutMs)
            : null;

        function finish(error?: Error): void {
            if (resolved) return;
            resolved = true;
            if (turnTimer) clearTimeout(turnTimer);
            if (error) {
                reject(error);
            } else {
                resolve({ threadId: resultThreadId });
            }
        }

        // Mark thinking on turn start
        session.onThinkingChange(true);

        // Stderr — accumulate for error reporting
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderrChunks.push(chunk);
            // Log last bit for debugging
            const trimmed = chunk.trim();
            if (trimmed) {
                logger.debug(`[codex-exec:stderr] ${trimmed.slice(0, 300)}`);
            }
        });

        // Stdout — JSONL event stream
        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

        rl.on('line', (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            let event: ExecEvent;
            try {
                event = JSON.parse(trimmed);
            } catch {
                logger.debug(`[codex-exec] Non-JSON stdout line: ${trimmed.slice(0, 200)}`);
                return;
            }

            eventCount++;
            eventTypes.push(event.type);

            handleExecEvent(event, {
                session,
                messageBuffer,
                turnPrefix,
                onThreadId: (id) => {
                    resultThreadId = id;
                    onThreadId(id);
                }
            });
        });

        child.on('error', (err) => {
            logger.warn('[codex-exec] Child process error:', err);
            finish(err);
        });

        child.on('close', (code, signal) => {
            rl.close();
            session.onThinkingChange(false);

            const stderr = stderrChunks.join('').trim();
            const summary = {
                exitCode: code,
                signal,
                eventCount,
                eventTypes,
                threadId: resultThreadId,
                stderrLength: stderr.length,
                stderr: stderr ? stderr.slice(0, 1000) : '(empty)',
                turnTimedOut,
                permissionMode,
                model: startConfig.model ?? '(default)',
            };

            if (turnTimedOut) {
                logger.warn('[codex-exec] Turn timed out', summary);
                finish(new Error('Turn timed out'));
                return;
            }

            if (code !== 0 && code !== null) {
                const msg = stderr
                    ? `codex exec exited with code ${code}: ${stderr.slice(0, 500)}`
                    : `codex exec exited with code ${code}`;
                logger.warn('[codex-exec] Non-zero exit', summary);
                finish(new Error(msg));
                return;
            }

            logger.debug('[codex-exec] Process exited normally', { exitCode: code, eventCount });
            finish();
        });
    });
}

// ---------------------------------------------------------------------------
// Handle a single JSONL event from `codex exec --json`
// ---------------------------------------------------------------------------

interface EventHandlerContext {
    session: CodexSession;
    messageBuffer: MessageBuffer;
    turnPrefix: string;
    onThreadId: (id: string) => void;
}

function handleExecEvent(event: ExecEvent, ctx: EventHandlerContext): void {
    const { session, messageBuffer, onThreadId } = ctx;

    logger.debug(`[codex-exec:event] ${event.type} ${JSON.stringify(event).slice(0, 300)}`);

    switch (event.type) {
        case 'thread.started': {
            const threadId = (event as { thread_id: string }).thread_id;
            if (threadId) {
                onThreadId(threadId);
                session.onSessionFound(threadId);
                logger.debug(`[codex-exec] Thread started: ${threadId}`);
            }
            break;
        }

        case 'turn.started': {
            messageBuffer.addMessage('Starting task...', 'status');
            break;
        }

        case 'item.started': {
            const item = (event as { item: ExecItem }).item;
            handleItemStarted(item, ctx);
            break;
        }

        case 'item.completed': {
            const item = (event as { item: ExecItem }).item;
            handleItemCompleted(item, ctx);
            break;
        }

        case 'turn.completed': {
            const usage = (event as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
            messageBuffer.addMessage('Task completed', 'status');

            if (usage) {
                session.sendCodexMessage({
                    type: 'token_count',
                    info: usage,
                    id: randomUUID()
                });
            }
            break;
        }
    }
}

function handleItemStarted(item: ExecItem, ctx: EventHandlerContext): void {
    const { session, messageBuffer, turnPrefix } = ctx;
    const callId = `${turnPrefix}-${item.id}`;

    switch (item.type) {
        case 'mcp_tool_call': {
            const mcpItem = item as ExecMcpToolCallItem;
            messageBuffer.addMessage(`Calling ${mcpItem.server}:${mcpItem.tool}...`, 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                name: `${mcpItem.server}__${mcpItem.tool}`,
                callId,
                input: mcpItem.arguments,
                id: randomUUID()
            });
            break;
        }

        case 'command_execution': {
            const cmdItem = item as ExecCommandExecutionItem;
            messageBuffer.addMessage(`Executing: ${cmdItem.command}`, 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId,
                input: { command: cmdItem.command },
                id: randomUUID()
            });
            break;
        }

        case 'file_edit': {
            const editItem = item as ExecFileEditItem;
            const label = editItem.file_path ? `Editing ${editItem.file_path}...` : 'Editing file...';
            messageBuffer.addMessage(label, 'tool');
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId,
                input: { file_path: editItem.file_path },
                id: randomUUID()
            });
            break;
        }

        case 'reasoning': {
            const reasonItem = item as ExecReasoningItem;
            messageBuffer.addMessage(`[Thinking] ${reasonItem.text?.substring(0, 100) ?? ''}...`, 'system');
            session.sendCodexMessage({
                type: 'reasoning-delta',
                delta: reasonItem.text ?? ''
            });
            break;
        }
    }
}

function handleItemCompleted(item: ExecItem, ctx: EventHandlerContext): void {
    const { session, messageBuffer, turnPrefix } = ctx;
    const callId = `${turnPrefix}-${item.id}`;

    switch (item.type) {
        case 'agent_message': {
            const msgItem = item as ExecAgentMessageItem;
            messageBuffer.addMessage(msgItem.text, 'assistant');
            session.sendCodexMessage({
                type: 'message',
                message: msgItem.text,
                id: randomUUID()
            });
            break;
        }

        case 'mcp_tool_call': {
            const mcpItem = item as ExecMcpToolCallItem;
            const resultStr = typeof mcpItem.result === 'string'
                ? mcpItem.result
                : JSON.stringify(mcpItem.result);
            const truncated = resultStr?.substring(0, 200) ?? '';
            messageBuffer.addMessage(`Result: ${truncated}${(resultStr?.length ?? 0) > 200 ? '...' : ''}`, 'result');
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: mcpItem.result,
                id: randomUUID()
            });
            break;
        }

        case 'command_execution': {
            const cmdItem = item as ExecCommandExecutionItem;
            const commandResult = buildCommandExecutionResult(cmdItem);
            const output = getCommandExecutionPreview(cmdItem)
                ?? `exit code ${cmdItem.exit_code ?? '?'}`;
            const truncated = output.substring(0, 200);
            messageBuffer.addMessage(`Result: ${truncated}${output.length > 200 ? '...' : ''}`, 'result');
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: commandResult,
                id: randomUUID()
            });
            break;
        }

        case 'file_edit': {
            const editItem = item as ExecFileEditItem;
            messageBuffer.addMessage(
                editItem.file_path ? `Modified: ${editItem.file_path}` : 'File modified',
                'result'
            );
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId,
                output: {
                    file_path: editItem.file_path,
                    diff: editItem.diff,
                    status: 'completed'
                },
                id: randomUUID()
            });
            break;
        }

        case 'reasoning': {
            const reasonItem = item as ExecReasoningItem;
            session.sendCodexMessage({
                type: 'reasoning-delta',
                delta: reasonItem.text ?? ''
            });
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTimeoutEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        logger.warn(`[codex-exec] Invalid ${name}=${raw}; using ${fallback}`);
        return fallback;
    }
    return parsed;
}
