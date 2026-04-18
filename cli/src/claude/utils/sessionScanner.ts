import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

const INTERNAL_CLAUDE_METADATA_TYPES = new Set([
    'last-prompt',
    'permission-mode',
    'ai-title',
    'custom-title',
    'agent-name',
]);

const INTERNAL_CLAUDE_ATTACHMENT_TYPES = new Set([
    'skill_listing',
    'hook_success',
    'hook_non_blocking_error',
    'compact_file_reference',
    'command_permissions',
    'nested_memory',
    'deferred_tools_delta',
    'date_change',
    'file',
    'directory',
    'invoked_skills',
]);

function shouldSkipClaudeLogMessage(message: unknown): boolean {
    if (!message || typeof message !== 'object') {
        return false;
    }

    const record = message as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : null;
    if (!type) {
        return false;
    }

    if (INTERNAL_CLAUDE_EVENT_TYPES.has(type) || INTERNAL_CLAUDE_METADATA_TYPES.has(type)) {
        return true;
    }

    if (type !== 'attachment') {
        return false;
    }

    const attachment = record.attachment;
    if (!attachment || typeof attachment !== 'object') {
        return false;
    }

    const attachmentType = typeof (attachment as Record<string, unknown>).type === 'string'
        ? ((attachment as Record<string, unknown>).type as string)
        : null;
    return attachmentType !== null && INTERNAL_CLAUDE_ATTACHMENT_TYPES.has(attachmentType);
}

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();
    let sessionClearAtBySessionId = new Map<string, number>();

    // Mark existing messages as processed and start watching the initial session
    if (opts.sessionId) {
        let messages = await readSessionLog(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${messages.length} existing messages as processed from session ${opts.sessionId}`);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        // logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionMessages = await readSessionLog(projectDir, session);
            let skipped = 0;
            let sent = 0;
            for (let file of sessionMessages) {
                const messageSessionId = getMessageSessionId(file);
                const messageTimestamp = getMessageTimestampMs(file);
                if (messageSessionId) {
                    const clearedAt = sessionClearAtBySessionId.get(messageSessionId);
                    if (clearedAt !== undefined && messageTimestamp !== null && messageTimestamp < clearedAt) {
                        skipped++;
                        continue;
                    }
                }
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    skipped++;
                    continue;
                }
                processedMessageKeys.add(key);
                logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
                opts.onMessage(file);
                sent++;
            }
            if (sessionMessages.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionMessages.length}, skipped=${skipped}, sent=${sent}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            if (!watchers.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(join(projectDir, `${p}.jsonl`), () => { sync.invalidate(); }));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        clearSessionCache: (sessionId: string, clearedAtMs: number = Date.now()) => {
            sessionClearAtBySessionId.set(sessionId, clearedAtMs);
            logger.debug(`[SESSION_SCANNER] Cleared cached transcript state for session ${sessionId}`);
            sync.invalidate();
        },
        onNewSession: (sessionId: string) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    const timestamp = getMessageTimestamp(message);

    if (message.type === 'summary' && typeof message.leafUuid === 'string' && typeof message.summary === 'string') {
        return `summary:${message.leafUuid}:${message.summary}`;
    }

    if (message.type === 'result') {
        const requestId = getStringField(message, ['requestId', 'request_id']);
        if (requestId) {
            return `result:request:${requestId}`;
        }
        const uuid = getStringField(message, ['uuid']);
        if (uuid) {
            return `result:uuid:${uuid}`;
        }
    }

    if (message.type === 'progress') {
        const stepId = getStringField(message, ['step_id', 'stepId']);
        if (stepId) {
            return `progress:step:${stepId}:timestamp:${timestamp}`;
        }
    }

    if (message.type === 'rate_limit_event') {
        const limitType = getStringField(message, ['limit_type', 'limitType']);
        if (limitType) {
            return `rate_limit_event:limit:${limitType}:timestamp:${timestamp}`;
        }
    }

    if (message.type === 'tool_progress') {
        const toolUseId = getStringField(message, ['tool_use_id', 'toolUseId']);
        const seq = getScalarField(message, ['seq', 'sequence']);
        if (toolUseId && seq !== null) {
            return `tool_progress:tool:${toolUseId}:seq:${seq}`;
        }
        if (toolUseId) {
            return `tool_progress:tool:${toolUseId}:timestamp:${timestamp}`;
        }
    }

    if (message.type === 'user' || message.type === 'assistant' || message.type === 'system') {
        const uuid = getStringField(message, ['uuid']);
        if (uuid) {
            return `${message.type}:${uuid}`;
        }
        const requestId = getStringField(message, ['requestId', 'request_id']);
        if (requestId) {
            return `${message.type}:request:${requestId}`;
        }
        if (timestamp !== 'no-timestamp') {
            return `${message.type}:timestamp:${timestamp}`;
        }
    }

    return `${message.type}:timestamp:${timestamp}:hash:${hashNormalizedMessage(message)}`;
}

/**
 * Read and parse session log file
 * Returns only valid conversation messages, silently skipping internal events
 */
async function readSessionLog(projectDir: string, sessionId: string): Promise<RawJSONLines[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let messages: RawJSONLines[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (shouldSkipClaudeLogMessage(message)) {
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return messages;
}

function getMessageTimestamp(message: RawJSONLines): string {
    return 'timestamp' in message && typeof message.timestamp === 'string' && message.timestamp.length > 0
        ? message.timestamp
        : 'no-timestamp';
}

function getMessageTimestampMs(message: RawJSONLines): number | null {
    if (!('timestamp' in message) || typeof message.timestamp !== 'string' || message.timestamp.length === 0) {
        return null;
    }
    const parsed = Date.parse(message.timestamp);
    return Number.isNaN(parsed) ? null : parsed;
}

function getMessageSessionId(message: RawJSONLines): string | null {
    const record = message as Record<string, unknown>;
    const sessionId = record.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
        return sessionId;
    }

    const sessionIdLower = record.session_id;
    if (typeof sessionIdLower === 'string' && sessionIdLower.length > 0) {
        return sessionIdLower;
    }

    return null;
}

function getStringField(message: RawJSONLines, keys: string[]): string | null {
    const record = message as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return null;
}

function getScalarField(message: RawJSONLines, keys: string[]): string | number | null {
    const record = message as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

const VOLATILE_MESSAGE_KEYS = new Set([
    'uuid',
    'timestamp',
    'requestId',
    'request_id',
    'sessionId',
    'session_id',
    'parentUuid',
    'parent_uuid',
    'toolUseResult',
]);

function hashNormalizedMessage(message: RawJSONLines): string {
    const normalized = normalizeForHash(message);
    return createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
}

function normalizeForHash(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeForHash(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
        if (VOLATILE_MESSAGE_KEYS.has(key)) {
            continue;
        }
        const nested = normalizeForHash(record[key]);
        if (nested !== undefined) {
            normalized[key] = nested;
        }
    }

    return normalized;
}
