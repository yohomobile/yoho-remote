import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentEvent, ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { BrainChildCallbackCard } from './BrainChildCallbackCard'

describe('ReadBatch card rendering', () => {
    test('renders a single grouped card without nested search or read cards', () => {
        const block: ToolCallBlock = {
            kind: 'tool-call',
            id: 'read-batch:1',
            localId: null,
            createdAt: 1,
            seq: null,
            tool: {
                id: 'read-batch-tool:1',
                name: 'ReadBatch',
                state: 'completed',
                input: {
                    count: 1,
                    files: ['~/.yoho-remote/logs/daemon.log']
                },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                parentUUID: null
            },
            children: [{
                kind: 'tool-call',
                id: 'search-tool',
                localId: null,
                createdAt: 1,
                seq: null,
                tool: {
                    id: 'search-tool',
                    name: 'CodexBash',
                    state: 'completed',
                    input: {
                        parsed_cmd: [
                            { type: 'search', query: 'daemon log' },
                            { type: 'list_files', path: '~/.yoho-remote/logs' },
                            { type: 'read', name: '~/.yoho-remote/logs/daemon.log' }
                        ]
                    },
                    createdAt: 1,
                    startedAt: 1,
                    completedAt: 2,
                    description: null,
                    parentUUID: null
                },
                children: []
            }],
            meta: undefined
        }

        const html = renderToStaticMarkup(
            <ToolCard
                api={{} as never}
                sessionId="session-1"
                metadata={null}
                disabled={false}
                onDone={() => undefined}
                block={block}
            />
        )

        expect(html).toContain('Read 1 file')
        expect(html).toContain('daemon.log')
        expect(html).toContain('~/.yoho-remote/logs')
        expect(html).not.toContain('Search')
        expect(html).not.toContain('Find files')
        expect(html).not.toContain('Read file')
    })

    test('renders nested brain-child-callback events with the rich callback card', () => {
        const event: Extract<AgentEvent, { type: 'brain-child-callback' }> = {
            type: 'brain-child-callback',
            title: '子任务完成',
            previousSummary: '之前摘要',
            details: ['消息数: 5'],
            report: undefined
        }

        const html = renderToStaticMarkup(
            <BrainChildCallbackCard api={{} as never} event={event} />
        )

        expect(html).toContain('子任务回传')
        expect(html).toContain('子任务完成')
        expect(html).toContain('之前摘要')
        expect(html).toContain('消息数: 5')
    })
})
