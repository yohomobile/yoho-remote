import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolCallBlock } from '@/chat/types'
import { ReadBatchDisclosure } from './ToolMessage'

describe('ReadBatchDisclosure', () => {
    test('renders a single grouped disclosure without nested search or read cards', () => {
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

        const html = renderToStaticMarkup(<ReadBatchDisclosure block={block} metadata={null} />)

        expect(html).toContain('File read (1)')
        expect(html).toContain('~/.yoho-remote/logs/daemon.log')
        expect(html).not.toContain('Read 1 file')
        expect(html).not.toContain('Search')
        expect(html).not.toContain('Find files')
        expect(html).not.toContain('Read file')
    })
})
