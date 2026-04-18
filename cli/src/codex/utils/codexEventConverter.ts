import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/ui/logger';

const CodexSessionEventSchema = z.object({
    timestamp: z.string().optional(),
    type: z.string(),
    payload: z.unknown().optional()
}).passthrough();

export type CodexSessionEvent = z.infer<typeof CodexSessionEventSchema>;

export type CodexMessage = {
    type: 'message';
    message: string;
    id: string;
} | {
    type: 'reasoning';
    message: string;
    id: string;
} | {
    type: 'reasoning-delta';
    delta: string;
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

export function convertCodexEvent(rawEvent: unknown): CodexConversionResult | null {
    const parsed = CodexSessionEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
        return null;
    }

    const { type, payload } = parsed.data;
    const payloadRecord = asRecord(payload);
    const eventRecord = asRecord(parsed.data);

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

        if (eventType === 'agent_reasoning') {
            const message = asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!message) {
                return null;
            }
            return {
                message: {
                    type: 'reasoning',
                    message,
                    id: randomUUID()
                }
            };
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta = asString(payloadRecord.delta) ?? asString(payloadRecord.text) ?? asString(payloadRecord.message);
            if (!delta) {
                return null;
            }
            return {
                message: {
                    type: 'reasoning-delta',
                    delta
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
