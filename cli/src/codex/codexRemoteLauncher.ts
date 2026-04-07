import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { join } from 'node:path';

import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import type { CodexSessionConfig } from './types';
import { getYohoRemoteCliCommand } from '@/utils/spawnYohoRemoteCLI';
import { startYohoRemoteServer } from '@/claude/utils/startYohoRemoteServer';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { restoreTerminalState } from '@/ui/terminalState';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexStartConfig, TITLE_INSTRUCTION } from './utils/codexStartConfig';
import { convertCodexEvent } from './utils/codexEventConverter';
import { getYohoAuxMcpServers, MEMORY_HTTP_PORT, CREDENTIALS_HTTP_PORT } from '@/utils/yohoMcpServers';

const INIT_PROMPT_PREFIX = '#InitPrompt-';

function isInitPromptMessage(message: string): boolean {
    return message.trimStart().startsWith(INIT_PROMPT_PREFIX);
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    // Warn if CLI args were passed that won't apply in remote mode
    if (session.codexArgs && session.codexArgs.length > 0) {
        if (hasCodexCliOverrides(session.codexCliOverrides)) {
            logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                `are ignored in remote mode.`);
        } else {
            logger.debug(`[codex-remote] Warning: CLI args [${session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
        }
    }

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    const messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    let exitReason: 'switch' | 'exit' | null = null;
    let shouldExit = false;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
                exitReason = 'exit';
                shouldExit = true;
                await handleAbort();
            },
            onSwitchToLocal: async () => {
                logger.debug('[codex-remote]: Switching to local mode via double space');
                exitReason = 'switch';
                shouldExit = true;
                await handleAbort();
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

    const client = new CodexMcpClient();

    function findCodexResumeFile(sessionId: string | null): string | null {
        if (!sessionId) return null;
        try {
            const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
            const rootDir = join(codexHomeDir, 'sessions');

            function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return acc;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        collectFilesRecursive(full, acc);
                    } else if (entry.isFile()) {
                        acc.push(full);
                    }
                }
                return acc;
            }

            const candidates = collectFilesRecursive(rootDir)
                .filter((full) => full.endsWith(`-${sessionId}.jsonl`))
                .filter((full) => {
                    try { return fs.statSync(full).isFile(); } catch { return false; }
                })
                .sort((a, b) => {
                    const sa = fs.statSync(a).mtimeMs;
                    const sb = fs.statSync(b).mtimeMs;
                    return sb - sa;
                });
            return candidates[0] || null;
        } catch {
            return null;
        }
    }

    const RESUME_CONTEXT_MAX_ITEMS = 40;
    const RESUME_CONTEXT_MAX_CHARS = 16000;
    const RESUME_CONTEXT_TOOL_MAX_CHARS = 2000;
    const RESUME_CONTEXT_REASONING_MAX_CHARS = 2000;

    function readResumeFileContent(resumeFile: string): { content: string; truncated: boolean } | null {
        try {
            const stat = fs.statSync(resumeFile);
            if (!stat.isFile()) {
                return null;
            }
            return { content: fs.readFileSync(resumeFile, 'utf8'), truncated: false };
        } catch (error) {
            logger.debug('[Codex] Failed to read resume file:', error);
            return null;
        }
    }

    function safeStringify(value: unknown): string | null {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === 'string') {
            return value;
        }
        try {
            return JSON.stringify(value);
        } catch {
            return null;
        }
    }

    function formatResumeValue(value: unknown, maxChars: number, singleLine = false): string | null {
        const raw = safeStringify(value);
        if (!raw) {
            return null;
        }
        const normalized = singleLine ? raw.replace(/\s+/g, ' ').trim() : raw;
        if (!normalized) {
            return null;
        }
        if (normalized.length <= maxChars) {
            return normalized;
        }
        return `${normalized.slice(0, maxChars)}...`;
    }

    function buildResumeInstructionsFromFile(resumeFile: string): string | undefined {
        const result = readResumeFileContent(resumeFile);
        if (!result) {
            return undefined;
        }

        const items: { role: 'user' | 'assistant' | 'tool'; text: string }[] = [];
        let truncated = result.truncated;

        const lines = result.content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed);
                const converted = convertCodexEvent(parsed);
                if (converted?.userMessage) {
                    items.push({ role: 'user', text: converted.userMessage });
                }
                if (converted?.message?.type === 'message') {
                    items.push({ role: 'assistant', text: converted.message.message });
                }
                if (converted?.message?.type === 'reasoning') {
                    const reasoning = formatResumeValue(converted.message.message, RESUME_CONTEXT_REASONING_MAX_CHARS);
                    if (reasoning) {
                        items.push({ role: 'assistant', text: `Reasoning: ${reasoning}` });
                    }
                }
                if (converted?.message?.type === 'tool-call') {
                    const input = formatResumeValue(converted.message.input, RESUME_CONTEXT_TOOL_MAX_CHARS, true);
                    const text = input
                        ? `Call ${converted.message.name} ${input}`
                        : `Call ${converted.message.name}`;
                    items.push({ role: 'tool', text });
                }
                if (converted?.message?.type === 'tool-call-result') {
                    const output = formatResumeValue(converted.message.output, RESUME_CONTEXT_TOOL_MAX_CHARS, true);
                    if (output) {
                        items.push({ role: 'tool', text: `Result ${output}` });
                    }
                }
            } catch {
                continue;
            }
        }

        if (items.length === 0) {
            return undefined;
        }

        if (items.length > RESUME_CONTEXT_MAX_ITEMS) {
            items.splice(0, items.length - RESUME_CONTEXT_MAX_ITEMS);
            truncated = true;
        }

        const rendered = items.map((item) => {
            if (item.role === 'user') {
                return `User: ${item.text}`;
            }
            if (item.role === 'tool') {
                return `Tool: ${item.text}`;
            }
            return `Assistant: ${item.text}`;
        });
        let totalChars = rendered.reduce((sum, line) => sum + line.length + 1, 0);
        while (rendered.length > 1 && totalChars > RESUME_CONTEXT_MAX_CHARS) {
            const removed = rendered.shift();
            totalChars -= (removed?.length ?? 0) + 1;
            truncated = true;
        }

        if (rendered.length === 0) {
            return undefined;
        }

        const header = truncated
            ? 'Continue from the prior session context below (transcript truncated):'
            : 'Continue from the prior session context below:';
        return `${header}\n${rendered.join('\n')}`;
    }

    function parseTimeoutEnv(name: string, fallback: number): number {
        const raw = process.env[name];
        if (!raw) {
            return fallback;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) {
            logger.warn(`[Codex] Invalid ${name}=${raw}; using ${fallback}`);
            return fallback;
        }
        return parsed;
    }

    function parseBooleanEnv(name: string, fallback: boolean): boolean {
        const raw = process.env[name];
        if (!raw) {
            return fallback;
        }
        const normalized = raw.trim().toLowerCase();
        if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
            return true;
        }
        if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
            return false;
        }
        logger.warn(`[Codex] Invalid ${name}=${raw}; using ${fallback}`);
        return fallback;
    }

    function parseSampleRateEnv(name: string): number | null {
        const raw = process.env[name];
        if (!raw) {
            return null;
        }
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
            logger.warn(`[Codex] Invalid ${name}=${raw}; expected 0..1`);
            return null;
        }
        return parsed;
    }

    const TURN_TIMEOUT_MS = parseTimeoutEnv('YR_CODEX_TURN_TIMEOUT_MS', 3 * 60 * 60 * 1000);
    const TURN_COMPLETE_GRACE_MS = parseTimeoutEnv('YR_CODEX_TURN_COMPLETE_GRACE_MS', 15000);
    const mcpLogEnabled = parseBooleanEnv('YR_MCP_EVENT_LOG', true);
    const mcpLogSampleRate = parseSampleRateEnv('YR_MCP_EVENT_LOG_SAMPLE')
        ?? parseSampleRateEnv('YR_MCP_EVENT_LOG_SAMPLE_RATE')
        ?? 1;

    const permissionHandler = new CodexPermissionHandler(session.client, {
        getPermissionMode: () => session.getPermissionMode()
    });
    const reasoningProcessor = new ReasoningProcessor((message) => {
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        session.sendCodexMessage(message);
    });
    let loggedReasoningDelta = false;

    logger.debug(`[Codex] MCP event logging ${mcpLogEnabled ? 'enabled' : 'disabled'} (sample=${mcpLogSampleRate})`);

    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        if (mcpLogEnabled && (mcpLogSampleRate >= 1 || Math.random() < mcpLogSampleRate)) {
            const serialized = safeStringify(msg) ?? String(msg);
            logger.debug(`[Codex] MCP message: ${serialized}`);
        }
        const converted = convertCodexEvent(msg);
        if (converted?.modelInfo) {
            session.updateRuntimeModel(converted.modelInfo.model, converted.modelInfo.reasoningEffort ?? null);
        }
        recordInFlightEvent(msg.type);
        if (inFlight) {
            if (msg.type === 'exec_command_begin') {
                inFlight.commandCount += 1;
            }
            if (msg.type === 'patch_apply_begin') {
                inFlight.patchCount += 1;
            }
            if (msg.type === 'token_count') {
                inFlight.tokenCountEvents += 1;
            }
            if (msg.type === 'task_started' && !inFlight.taskStartedAt) {
                inFlight.taskStartedAt = Date.now();
            }
            if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                inFlight.completedAt = Date.now();
                inFlight.completedType = msg.type;
                logInFlightSummary();
            }
        }

        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            if (typeof msg.delta === 'string' && msg.delta.length > 0) {
                if (!loggedReasoningDelta) {
                    logger.debug('[Codex] Streaming agent_reasoning_delta to UI');
                    loggedReasoningDelta = true;
                }
                session.sendCodexMessage({
                    type: 'reasoning-delta',
                    delta: msg.delta
                });
            }
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
            scheduleCompletionAbort('task_complete');
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
            scheduleCompletionAbort('turn_aborted');
        }

        if (msg.type === 'task_started') {
            if (!session.thinking) {
                logger.debug('thinking started');
                session.onThinkingChange(true);
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (session.thinking) {
                logger.debug('thinking completed');
                session.onThinkingChange(false);
            }
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            const { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            const { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            const { call_id, auto_approved, changes } = msg;

            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            const { call_id, stdout, stderr, success } = msg;

            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }

            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });

    const yohoRemoteServer = await startYohoRemoteServer(session.client, {
        apiClient: session.api,
        yohoRemoteSessionId: session.client.sessionId,
    });
    const bridgeCommand = getYohoRemoteCliCommand(['mcp', '--url', yohoRemoteServer.url]);
    const mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }> = {
        yoho_remote: {
            command: bridgeCommand.command,
            args: bridgeCommand.args
        },
        ...getYohoAuxMcpServers('codex')
    };

    // Add stdio bridges for remote aux MCP servers when local files are absent
    const auxServers = getYohoAuxMcpServers('codex');
    if (!auxServers.yoho_memory) {
        try {
            const host = new URL(process.env.YOHO_REMOTE_URL || '').hostname;
            if (host) {
                const memBridge = getYohoRemoteCliCommand(['mcp', '--url', `http://${host}:${MEMORY_HTTP_PORT}/mcp`]);
                mcpServers.yoho_memory = { command: memBridge.command, args: memBridge.args };
            }
        } catch { /* invalid URL, skip */ }
    }
    if (!auxServers.yoho_credentials) {
        try {
            const host = new URL(process.env.YOHO_REMOTE_URL || '').hostname;
            if (host) {
                const credBridge = getYohoRemoteCliCommand(['mcp', '--url', `http://${host}:${CREDENTIALS_HTTP_PORT}/mcp`]);
                mcpServers.yoho_credentials = { command: credBridge.command, args: credBridge.args };
            }
        } catch { /* invalid URL, skip */ }
    }

    let abortController = new AbortController();
    let storedSessionIdForResume: string | null = null;

    type InFlightTurn = {
        kind: 'start' | 'continue';
        message: string;
        hash: string;
        startedAt: number;
        rpcCompletedAt?: number;
        firstEventAt?: number;
        firstEventType?: string;
        taskStartedAt?: number;
        completedAt?: number;
        completedType?: 'task_complete' | 'turn_aborted';
        lastEventAt?: number;
        eventCount: number;
        commandCount: number;
        patchCount: number;
        tokenCountEvents: number;
        summaryLogged: boolean;
        abortReason?: string;
    };

    let inFlight: InFlightTurn | null = null;
    let inFlightTimeout: NodeJS.Timeout | null = null;
    let inFlightCompletionTimer: NodeJS.Timeout | null = null;
    let inFlightAbortRequested = false;
    let lastAbortReason: string | null = null;

    function clearInFlightTimers(): void {
        if (inFlightTimeout) {
            clearTimeout(inFlightTimeout);
            inFlightTimeout = null;
        }
        if (inFlightCompletionTimer) {
            clearTimeout(inFlightCompletionTimer);
            inFlightCompletionTimer = null;
        }
    }

    function logPerf(label: string, data: Record<string, unknown>): void {
        logger.debug(`[CodexPerf] ${label} ${JSON.stringify(data)}`);
    }

    function recordInFlightEvent(eventType: string): void {
        if (!inFlight) {
            return;
        }
        const now = Date.now();
        if (!inFlight.firstEventAt) {
            inFlight.firstEventAt = now;
            inFlight.firstEventType = eventType;
        }
        inFlight.lastEventAt = now;
        inFlight.eventCount += 1;
    }

    function logInFlightSummary(reason?: string): void {
        if (!inFlight || inFlight.summaryLogged) {
            return;
        }
        const now = Date.now();
        const endAt = inFlight.completedAt ?? inFlight.lastEventAt ?? now;
        const summary = {
            kind: inFlight.kind,
            hash: inFlight.hash,
            messageLength: inFlight.message.length,
            reason: reason ?? inFlight.completedType ?? inFlight.abortReason ?? 'unknown',
            rpcMs: inFlight.rpcCompletedAt ? inFlight.rpcCompletedAt - inFlight.startedAt : undefined,
            firstEventMs: inFlight.firstEventAt ? inFlight.firstEventAt - inFlight.startedAt : undefined,
            taskStartedMs: inFlight.taskStartedAt ? inFlight.taskStartedAt - inFlight.startedAt : undefined,
            totalMs: endAt - inFlight.startedAt,
            eventCount: inFlight.eventCount,
            commandCount: inFlight.commandCount,
            patchCount: inFlight.patchCount,
            tokenCountEvents: inFlight.tokenCountEvents,
            firstEventType: inFlight.firstEventType
        };
        logPerf('turn_summary', summary);
        inFlight.summaryLogged = true;
    }

    function clearInFlight(): void {
        if (inFlight) {
            logInFlightSummary('cleared');
        }
        clearInFlightTimers();
        inFlight = null;
        inFlightAbortRequested = false;
    }

    function startInFlightWatchdog(kind: InFlightTurn['kind'], message: string, hash: string): void {
        clearInFlight();
        inFlight = {
            kind,
            message,
            hash,
            startedAt: Date.now(),
            eventCount: 0,
            commandCount: 0,
            patchCount: 0,
            tokenCountEvents: 0,
            summaryLogged: false
        };
        logPerf('turn_start', {
            kind: inFlight.kind,
            hash: inFlight.hash,
            messageLength: inFlight.message.length
        });
        if (TURN_TIMEOUT_MS <= 0) {
            return;
        }
        inFlightTimeout = setTimeout(() => {
            requestInFlightAbort('timeout');
        }, TURN_TIMEOUT_MS);
    }

    function scheduleCompletionAbort(reason: string): void {
        if (!inFlight || inFlightAbortRequested || inFlightCompletionTimer) {
            return;
        }
        if (TURN_COMPLETE_GRACE_MS <= 0) {
            requestInFlightAbort(reason);
            return;
        }
        inFlightCompletionTimer = setTimeout(() => {
            requestInFlightAbort(reason);
        }, TURN_COMPLETE_GRACE_MS);
    }

    function requestInFlightAbort(reason: string): void {
        if (!inFlight || inFlightAbortRequested) {
            return;
        }
        inFlightAbortRequested = true;
        inFlight.abortReason = reason;
        clearInFlightTimers();
        const ageSeconds = Math.round((Date.now() - inFlight.startedAt) / 1000);
        logger.warn(`[Codex] ${reason} - aborting in-flight ${inFlight.kind} turn (hash=${inFlight.hash}, age=${ageSeconds}s)`);
        void handleAbort({ preserveQueue: true, reason });
    }

    async function handleAbort(options: { preserveQueue?: boolean; reason?: string } = {}) {
        lastAbortReason = options.reason ?? null;
        if (inFlight) {
            inFlightAbortRequested = true;
            clearInFlightTimers();
        }
        const reasonSuffix = options.reason ? ` (${options.reason})` : '';
        logger.debug(`[Codex] Abort requested${reasonSuffix} - stopping current task`);
        try {
            if (client.hasActiveSession()) {
                storedSessionIdForResume = client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', storedSessionIdForResume);
            }

            abortController.abort();
            if (!options.preserveQueue) {
                session.queue.reset();
            }
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    session.client.rpcHandlerManager.registerHandler('abort', async () => {
        await handleAbort();
    });

    session.client.rpcHandlerManager.registerHandler('switch', async () => {
        exitReason = 'switch';
        shouldExit = true;
        await handleAbort();
    });

    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch {}
    }

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const syncSessionId = () => {
        const clientSessionId = client.getSessionId();
        if (clientSessionId && clientSessionId !== session.sessionId) {
            session.onSessionFound(clientSessionId);
        }
    };

    try {
        await client.connect();

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let nextExperimentalResume: string | null = null;
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

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = abortController.signal;
                console.error('[YR codex] Waiting for messages...');
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                console.error('[YR codex] Got batch:', batch ? 'yes' : 'no', 'shouldExit:', shouldExit);
                if (!batch) {
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        console.error('[YR codex] Wait aborted while idle, continuing...');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (error) {
                    logger.debug('[Codex] Error while searching resume file', error);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;
            console.error('[YR codex] Processing message:', message.message.slice(0, 50));
            const outgoingMessage = appendTitleInstructionIfNeeded(message.message);

            try {
                if (!wasCreated) {
                    let resumeFile: string | null = null;
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null;
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    } else if (storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        }
                        storedSessionIdForResume = null;
                    } else if (first && session.sessionId) {
                        const localResumeFile = findCodexResumeFile(session.sessionId);
                        if (localResumeFile) {
                            resumeFile = localResumeFile;
                            logger.debug('[Codex] Using resume file from local session:', resumeFile);
                            messageBuffer.addMessage('Resuming from local session log...', 'status');
                        }
                    }

                    const developerInstructions = resumeFile
                        ? buildResumeInstructionsFromFile(resumeFile)
                        : undefined;
                    const startConfig: CodexSessionConfig = buildCodexStartConfig({
                        message: outgoingMessage,
                        mode: message.mode,
                        first,
                        mcpServers,
                        cliOverrides: session.codexCliOverrides,
                        developerInstructions,
                        includeTitleInstruction: false
                    });

                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }

                    startInFlightWatchdog('start', message.message, message.hash);
                    const startResponse = await client.startSession(startConfig, { signal: abortController.signal });
                    if (inFlight) {
                        inFlight.rpcCompletedAt = Date.now();
                        logPerf('turn_rpc', {
                            kind: inFlight.kind,
                            hash: inFlight.hash,
                            rpcMs: inFlight.rpcCompletedAt - inFlight.startedAt,
                            error: startResponse.error ?? null
                        });
                    }
                    if (startResponse.error) {
                        if (inFlight) {
                            inFlight.abortReason = 'start_response_error';
                        }
                        messageBuffer.addMessage(startResponse.error, 'status');
                        session.sendSessionEvent({ type: 'message', message: startResponse.error });
                        continue;
                    }
                    wasCreated = true;
                    first = false;
                    syncSessionId();
                } else {
                    startInFlightWatchdog('continue', message.message, message.hash);
                    const continueResponse = await client.continueSession(outgoingMessage, { signal: abortController.signal });
                    if (inFlight) {
                        inFlight.rpcCompletedAt = Date.now();
                        logPerf('turn_rpc', {
                            kind: inFlight.kind,
                            hash: inFlight.hash,
                            rpcMs: inFlight.rpcCompletedAt - inFlight.startedAt,
                            error: continueResponse.error ?? null
                        });
                    }
                    if (continueResponse.error) {
                        if (inFlight) {
                            inFlight.abortReason = 'continue_response_error';
                        }
                        messageBuffer.addMessage(continueResponse.error, 'status');
                        session.sendSessionEvent({ type: 'message', message: continueResponse.error });
                        continue;
                    }
                    syncSessionId();
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                const isAbortRequested = inFlightAbortRequested || lastAbortReason !== null;
                const isCompletionAbort = lastAbortReason === 'task_complete' || lastAbortReason === 'turn_aborted';
                const shouldPreserveSession = isCompletionAbort && client.hasActiveSession();
                if (inFlight && !inFlight.abortReason) {
                    inFlight.abortReason = isAbortError ? 'abort_error' : 'exception';
                }

                if (isAbortError || isAbortRequested) {
                    if (!isCompletionAbort) {
                        const abortMessage = lastAbortReason
                            ? `Aborted (${lastAbortReason})`
                            : 'Aborted by user';
                        messageBuffer.addMessage(abortMessage, 'status');
                        session.sendSessionEvent({ type: 'message', message: abortMessage });
                    }
                    if (!shouldPreserveSession) {
                        wasCreated = false;
                        currentModeHash = null;
                        logger.debug('[Codex] Marked session as not created after abort for proper resume');
                    } else {
                        logger.debug('[Codex] Completion abort; keeping session for next turn');
                    }
                } else {
                    // Unexpected error - try to recover
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const displayMessage = `Process error: ${errorMessage.slice(0, 100)}`;
                    messageBuffer.addMessage(displayMessage, 'status');
                    session.sendSessionEvent({ type: 'message', message: displayMessage });

                    // Store session for resume before clearing
                    if (client.hasActiveSession()) {
                        storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', storedSessionIdForResume);
                    }

                    // Reset session state to allow fresh start on next message
                    wasCreated = false;
                    currentModeHash = null;
                    client.clearSession();
                    logger.debug('[Codex] Reset session state after unexpected error for recovery');

                    // Reconnect MCP client for next attempt
                    try {
                        await client.disconnect();
                        await client.connect();
                        logger.debug('[Codex] Reconnected MCP client after error');
                    } catch (reconnectError) {
                        logger.warn('[Codex] Failed to reconnect MCP client:', reconnectError);
                    }
                }
            } finally {
                clearInFlight();
                lastAbortReason = null;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit,
                    sendReady
                });
                logActiveHandles('after-turn');
            }
        }
    } finally {
        logger.debug('[codex-remote]: cleanup start');
        try {
            await client.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        yohoRemoteServer.stop();
        permissionHandler.reset();
        reasoningProcessor.abort();
        diffProcessor.reset();

        restoreTerminalState();
        if (hasTTY) {
            try { process.stdin.pause(); } catch {}
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();
        logger.debug('[codex-remote]: cleanup done');
    }

    return exitReason || 'exit';
}
