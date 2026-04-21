import { describe, expect, test } from 'bun:test'
import type { ChatBlock, NormalizedMessage } from './types'
import type { DecryptedMessage } from '@/types/api'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { renderEventLabel } from './presentation'

const FIXTURE_URL = new URL('./__fixtures__/codex-unified-display.replay.jsonl', import.meta.url)

type ReplaySummaryBlock =
    | {
        kind: 'tool-call'
        id: string
        name: string
        state: 'pending' | 'running' | 'completed' | 'error'
        input: unknown
        result: unknown
        children: ReplaySummaryBlock[]
    }
    | {
        kind: 'agent-text'
        id: string
        text: string
    }
    | {
        kind: 'user-text'
        id: string
        text: string
    }
    | {
        kind: 'cli-output'
        id: string
        source: 'user' | 'assistant'
        text: string
    }
    | {
        kind: 'agent-reasoning'
        id: string
        text: string
    }
    | {
        kind: 'agent-event'
        id: string
        eventType: string
        label: string
    }

async function readReplayFixture(): Promise<DecryptedMessage[]> {
    const text = await Bun.file(FIXTURE_URL).text()
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as DecryptedMessage)
}

function normalizeAll(messages: DecryptedMessage[]): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = []
    for (const message of messages) {
        const value = normalizeDecryptedMessage(message)
        if (!value) continue
        if (Array.isArray(value)) {
            normalized.push(...value)
        } else {
            normalized.push(value)
        }
    }
    return normalized
}

function summarizeBlock(block: ChatBlock): ReplaySummaryBlock {
    switch (block.kind) {
        case 'tool-call':
            return {
                kind: block.kind,
                id: block.id,
                name: block.tool.name,
                state: block.tool.state,
                input: block.tool.input,
                result: block.tool.result,
                children: block.children.map(summarizeBlock)
            }
        case 'agent-text':
            return {
                kind: block.kind,
                id: block.id,
                text: block.text
            }
        case 'user-text':
            return {
                kind: block.kind,
                id: block.id,
                text: block.text
            }
        case 'cli-output':
            return {
                kind: block.kind,
                id: block.id,
                source: block.source,
                text: block.text
            }
        case 'agent-reasoning':
            return {
                kind: block.kind,
                id: block.id,
                text: block.text
            }
        case 'agent-event':
            return {
                kind: block.kind,
                id: block.id,
                eventType: block.event.type,
                label: renderEventLabel(block.event)
            }
    }
}

describe('codex unified replay fixture', () => {
    test('replays Codex, Claude, callback, status, and fallback shapes in a stable order', async () => {
        const normalized = normalizeAll(await readReplayFixture())
        const reduced = reduceChatBlocks(normalized, null)
        const summary = reduced.blocks.map(summarizeBlock)

        expect(summary.map((block) => block.id)).toEqual([
            'codex-call-1',
            'claude-text:0',
            'read-batch:claude-read-1',
            'brain-callback',
            'todo-reminder',
            'status-compacting',
            'codex-fallback:0',
            'claude-fallback:0'
        ])

        expect(summary[0]).toMatchObject({
            kind: 'tool-call',
            id: 'codex-call-1',
            name: 'CodexBash',
            state: 'completed',
            input: {
                command: 'bun test web/src/chat/codexUnifiedReplay.test.ts'
            },
            result: {
                stdout: 'codex ok',
                exit_code: 0
            }
        })

        expect(summary[1]).toMatchObject({
            kind: 'agent-text',
            id: 'claude-text:0',
            text: 'Claude text output'
        })

        expect(summary[2]).toMatchObject({
            kind: 'tool-call',
            id: 'read-batch:claude-read-1',
            name: 'ReadBatch',
            state: 'completed',
            input: {
                count: 1,
                files: ['web/src/chat/reducer.ts']
            },
            result: undefined,
            children: [{
                kind: 'tool-call',
                id: 'claude-read-1',
                name: 'Read',
                state: 'completed',
                input: {
                    file_path: 'web/src/chat/reducer.ts'
                },
                result: {
                    file: {
                        filePath: 'web/src/chat/reducer.ts',
                        content: 'export function reduceChatBlocks() { return true }\n'
                    }
                }
            }]
        })

        expect(summary[3]).toMatchObject({
            kind: 'agent-event',
            id: 'brain-callback',
            eventType: 'brain-child-callback',
            label: '子任务回传 · 修复 Codex 展示'
        })

        expect(summary[4]).toMatchObject({
            kind: 'agent-event',
            id: 'todo-reminder',
            eventType: 'todo-reminder',
            label: 'Plan progress 1/2'
        })

        expect(summary[5]).toMatchObject({
            kind: 'agent-event',
            id: 'status-compacting',
            eventType: 'status',
            label: 'Compacting context...'
        })

        expect(summary[6]).toMatchObject({
            kind: 'agent-text',
            id: 'codex-fallback:0'
        })
        if (!summary[6] || summary[6].kind !== 'agent-text') {
            throw new Error('Expected codex fallback text block')
        }
        expect(summary[6].text).toContain('future_codex_shape')

        expect(summary[7]).toMatchObject({
            kind: 'agent-text',
            id: 'claude-fallback:0'
        })
        if (!summary[7] || summary[7].kind !== 'agent-text') {
            throw new Error('Expected claude fallback text block')
        }
        expect(summary[7].text).toContain('future_claude_shape')
    })
})
