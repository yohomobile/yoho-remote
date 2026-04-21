import { describe, expect, it } from 'vitest';
import { convertCodexEvent } from './codexEventConverter';

describe('convertCodexEvent', () => {
    it('extracts session_meta id', () => {
        const result = convertCodexEvent({
            type: 'session_meta',
            payload: { id: 'session-123' }
        });

        expect(result).toEqual({ sessionId: 'session-123' });
    });

    it('extracts session_meta session_id aliases when present', () => {
        const result = convertCodexEvent({
            type: 'session_meta',
            payload: { session_id: 'session-456' }
        });

        expect(result).toEqual({ sessionId: 'session-456' });
    });

    it('extracts model info from turn_context', () => {
        const result = convertCodexEvent({
            type: 'turn_context',
            payload: {
                model: 'gpt-5.2-codex',
                effort: 'xhigh'
            }
        });

        expect(result).toEqual({
            modelInfo: {
                model: 'gpt-5.2-codex',
                reasoningEffort: 'xhigh'
            }
        });
    });

    it('extracts model info from session_configured', () => {
        const result = convertCodexEvent({
            type: 'session_configured',
            model: 'gpt-5.2-codex',
            reasoning_effort: 'xhigh'
        });

        expect(result).toEqual({
            modelInfo: {
                model: 'gpt-5.2-codex',
                reasoningEffort: 'xhigh'
            }
        });
    });

    it('converts agent_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'hello' }
        });

        expect(result?.message).toMatchObject({
            type: 'message',
            message: 'hello'
        });
    });

    it('converts user_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello user' }
        });

        expect(result?.userMessage).toBe('hello user');
    });

    it('converts reasoning events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning', text: 'thinking', item_id: 'reasoning-item-1' }
        });

        expect(result?.message).toEqual({
            type: 'reasoning',
            message: 'thinking',
            id: 'reasoning-item-1'
        });
    });

    it('converts reasoning delta events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step', id: 'reasoning-1' }
        });

        expect(result?.message).toEqual({
            type: 'reasoning-delta',
            delta: 'step',
            id: 'reasoning-1'
        });
    });

    it('uses summary_index as a stable reasoning delta id fallback', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step', summary_index: 2 }
        });

        expect(result?.message).toEqual({
            type: 'reasoning-delta',
            delta: 'step',
            id: 'summary-2'
        });
    });

    it('converts status events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'status', status: 'compacting' }
        });

        expect(result?.message).toMatchObject({
            type: 'status',
            status: 'compacting'
        });
    });

    it('converts function_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'ToolName',
                call_id: 'call-1',
                arguments: '{"foo":"bar"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'ToolName',
            callId: 'call-1',
            input: { foo: 'bar' }
        });
    });

    it('converts function_call_output items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'call-2',
                output: { ok: true }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { ok: true }
        });
    });

    it('converts context compaction items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'context_compaction',
            }
        });

        expect(result?.message).toMatchObject({
            type: 'compact-boundary'
        });
    });

    it('converts item/completed contextCompaction notifications', () => {
        const result = convertCodexEvent({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'contextCompaction',
                    id: 'item-1'
                }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'compact-boundary'
        });
    });

    it('converts item/started contextCompaction notifications into compacting status', () => {
        const result = convertCodexEvent({
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    type: 'contextCompaction',
                    id: 'item-1'
                }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'status',
            status: 'compacting'
        });
    });

    it('converts legacy thread/compacted notifications', () => {
        const result = convertCodexEvent({
            method: 'thread/compacted',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'compact-boundary'
        });
    });
});
