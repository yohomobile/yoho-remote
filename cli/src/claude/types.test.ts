import { describe, expect, test } from 'vitest'
import { RawJSONLinesSchema } from './types'

describe('RawJSONLinesSchema', () => {
    test('accepts Claude result messages for local scanner forward-compatibility', () => {
        const parsed = RawJSONLinesSchema.safeParse({
            type: 'result',
            subtype: 'success',
            result: 'done',
            num_turns: 1,
            total_cost_usd: 0.01,
            duration_ms: 200,
            is_error: false,
            session_id: 'claude-session',
            timestamp: '2026-04-17T00:00:00.000Z'
        })

        expect(parsed.success).toBe(true)
    })

    test('accepts Claude tool progress messages for local scanner forward-compatibility', () => {
        const parsed = RawJSONLinesSchema.safeParse({
            type: 'tool_progress',
            tool_use_id: 'tool-1',
            tool_name: 'Bash',
            elapsed_time_seconds: 3,
            timestamp: '2026-04-17T00:00:01.000Z'
        })

        expect(parsed.success).toBe(true)
    })
})
