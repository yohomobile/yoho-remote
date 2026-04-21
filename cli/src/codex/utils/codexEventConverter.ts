import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/ui/logger';

const CodexSessionEventSchema = z.object({
    timestamp: z.string().optional(),
    type: z.string().optional(),
    method: z.string().optional(),
    payload: z.unknown().optional(),
    params: z.unknown().optional()
}).passthrough().refine((value) => typeof value.type === 'string' || typeof value.method === 'string', {
    message: 'Codex event requires either type or method'
});

export type CodexSessionEvent = z.infer<typeof CodexSessionEventSchema>;

export type CodexMessage = {
    type: 'message';
    message: string;
    id: string;
} | {
    type: 'status';
    status: string;
    id: string;
} | {
    type: 'compact-boundary';
    id: string;
} | {
    type: 'reasoning';
    message: string;
    id: string;
} | {
    type: 'reasoning-delta';
    delta: string;
    id?: string;
} | {
    type: 'token_count';
    info: Record<string, unknown>;
    id: string;
} | {
    type: 'tool-call';
    name: string;
    callId: string;
    input: unknown;
    id: string;
} | {
    type: 'tool-call-result';
    callId: string;
    output: unknown;
    id: string;
};

export type CodexModelInfo = {
    model: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
};

export type CodexConversionResult = {
    sessionId?: string;
    message?: CodexMessage;
    userMessage?: string;
    modelInfo?: CodexModelInfo;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            logger.debug('[codexEventConverter] Failed to parse function_call arguments as JSON:', error);
        }
    }

    return value;
}

function extractCallId(payload: Record<string, unknown>): string | null {
    // These are tool-call identifiers, not session identifiers.
    const candidates = [
        'call_id',
        'callId',
        'tool_call_id',
        'toolCallId',
        'id'
    ];

    for (const key of candidates) {
        const value = payload[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

function extractSessionId(payload: Record<string, unknown>): string | null {
    return asString(payload.session_id)
        ?? asString(payload.sessionId)
        ?? asString(payload.id);
}

export function extractCodexReasoningId(payload: Record<string, unknown>): string | null {
    const stringCandidates = [
        payload.item_id,
        payload.itemId,
        payload.id,
        payload.reasoning_id,
        payload.reasoningId,
    ];
    for (const candidate of stringCandidates) {
        if (typeof candidate === 'string' && candidate.length > 0) {
            return candidate;
        }
    }

    const numericCandidates = [
        payload.summary_index,
        payload.summaryIndex,
    ];
    for (const candidate of numericCandidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return `summary-${candidate}`;
        }
    }

    return null;
}

const MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

function extractModelInfo(payload: Record<string, unknown>): CodexModelInfo | null {
    const model = asString(payload.model)
        ?? asString(payload.model_name)
        ?? asString(payload.modelName)
        ?? asString(payload.model_id)
        ?? asString(payload.modelId);
    if (!model) {
        return null;
    }

    const effortRaw = asString(payload.effort)
        ?? asString(payload.reasoning_effort)
        ?? asString(payload.reasoningEffort);
    const reasoningEffort = effortRaw && MODEL_EFFORTS.has(effortRaw) ? effortRaw as CodexModelInfo['reasoningEffort'] : undefined;

    return { model, reasoningEffort };
}

function isCompactionItemType(itemType: string | null): boolean {
    return itemType === 'contextCompaction' || itemType === 'context_compaction' || itemType === 'compaction';
}

export function convertCodexEvent(rawEvent: unknown): CodexConversionResult | null {
    const parsed = CodexSessionEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
        return null;
    }

    const { type, method, payload, params } = parsed.data;
    const payloadRecord = asRecord(payload);
    const paramsRecord = asRecord(params);
    const eventRecord = asRecord(parsed.data);

    if (method === 'thread/compacted') {
        return {
            message: {
                type: 'compact-boundary',
                id: randomUUID()
            }
        };
    }

    if (method === 'item/started' || method === 'item/completed') {
        const item = asRecord(paramsRecord?.item);
        const itemType = asString(item?.type);
        if (isCompactionItemType(itemType)) {
            if (method === 'item/started') {
                return {
                    message: {
                        type: 'status',
                        status: 'compacting',
                        id: randomUUID()
                    }
                };
            }
            return {
                message: {
                    type: 'compact-boundary',
                    id: randomUUID()
                }
            };
        }
    }

    if (type === 'session_meta') {
        const sessionId = payloadRecord ? extractSessionId(payloadRecord) : null;
        const modelInfo = payloadRecord ? extractModelInfo(payloadRecord) : null;
        if (!sessionId && !modelInfo) {
            return null;
        }
        const result: CodexConversionResult = {};
        if (sessionId) {
            result.sessionId = sessionId;
        }
        if (modelInfo) {
            result.modelInfo = modelInfo;
        }
        return result;
    }

    if (type === 'turn_context' || type === 'session_configured') {
        const modelInfo = extractModelInfo(payloadRecord ?? eventRecord ?? {});
        if (!modelInfo) {
            return null;
        }
        return { modelInfo };
    }

    if (!payloadRecord) {
        return null;
    }

    if (type === 'event_msg') {
        const eventType = asString(payloadRecord.type);
        if (!eventType) {
            return null;
        }

        if (eventType === 'user_message') {
            const message = asString(payloadRecord.message)
                ?? asString(payloadRecord.text)
                ?? asString(payloadRecord.content);
            if (!message) {
                return null;
            }
            return {
                userMessage: message
            };
        }

        if (eventType === 'agent_message') {
            const message = asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: {
                    type: 'message',
                    message,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'status') {
            const status = asString(payloadRecord.status)
                ?? asString(payloadRecord.message)
                ?? asString(payloadRecord.text);
            if (!status) {
                return null;
            }
            return {
                message: {
                    type: 'status',
                    status,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            const reasoningId = extractCodexReasoningId(payloadRecord) ?? randomUUID();
            return {
                message: {
                    type: 'reasoning',
                    message,
                    id: reasoningId
                }
            };
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payloadRecord.delta) ?? asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!delta) {
                return null;
            }
            const reasoningId = extractCodexReasoningId(payloadRecord);
            return {
                message: {
                    type: 'reasoning-delta',
                    delta,
                    ...(reasoningId ? { id: reasoningId } : {})
                }
            };
        }

        if (eventType === 'token_count') {
            const info = asRecord(payloadRecord.info);
            if (!info) {
                return null;
            }
            return {
                message: {
                    type: 'token_count',
                    info,
                    id: randomUUID()
                }
            };
        }

        return null;
    }

    if (type === 'response_item') {
        const itemType = asString(payloadRecord.type);
        if (!itemType) {
            return null;
        }

        if (isCompactionItemType(itemType)) {
            return {
                message: {
                    type: 'compact-boundary',
                    id: randomUUID()
                }
            };
        }

        if (itemType === 'function_call') {
            const name = asString(payloadRecord.name);
            const callId = extractCallId(payloadRecord);
            if (!name || !callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call',
                    name,
                    callId,
                    input: parseArguments(payloadRecord.arguments),
                    id: randomUUID()
                }
            };
        }

        if (itemType === 'function_call_output') {
            const callId = extractCallId(payloadRecord);
            if (!callId) {
                return null;
            }
            return {
                message: {
                    type: 'tool-call-result',
                    callId,
                    output: payloadRecord.output,
                    id: randomUUID()
                }
            };
        }

        return null;
    }

    return null;
}
