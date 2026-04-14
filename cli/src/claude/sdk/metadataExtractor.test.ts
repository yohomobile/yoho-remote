import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./query', () => ({
    query: vi.fn()
}))

import { query } from './query'
import { extractSDKMetadata } from './metadataExtractor'

function createAsyncIterable(items: unknown[]): AsyncIterable<unknown> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const item of items) {
                yield item
            }
        }
    }
}

describe('extractSDKMetadata', () => {
    const queryMock = vi.mocked(query)

    beforeEach(() => {
        queryMock.mockReset()
    })

    it('passes through MCP config so discovered tools include session MCP servers', async () => {
        queryMock.mockReturnValue(createAsyncIterable([
            {
                type: 'system',
                subtype: 'init',
                tools: ['Bash', 'mcp__yoho-vault__recall'],
                slash_commands: ['compact']
            }
        ]) as ReturnType<typeof query>)

        const mcpServers = {
            'yoho-vault': {
                type: 'http',
                url: 'http://127.0.0.1:3100/mcp'
            }
        }

        const metadata = await extractSDKMetadata({
            cwd: '/tmp/project',
            mcpServers,
        })

        expect(queryMock).toHaveBeenCalledWith({
            prompt: 'hello',
            options: expect.objectContaining({
                allowedTools: ['Bash(echo)'],
                cwd: '/tmp/project',
                maxTurns: 1,
                mcpServers,
            })
        })
        expect(metadata).toEqual({
            tools: ['Bash', 'mcp__yoho-vault__recall'],
            slashCommands: ['compact']
        })
    })

    it('returns empty metadata when no init message is received', async () => {
        queryMock.mockReturnValue(createAsyncIterable([
            { type: 'assistant', message: { content: [] } }
        ]) as ReturnType<typeof query>)

        await expect(extractSDKMetadata()).resolves.toEqual({})
    })
})
