import { describe, expect, it, vi } from 'vitest'

import { createYohoRemoteMcpBridgeHandlers, parseArgs, type YohoRemoteBridgeClient } from './yohoRemoteMcpStdioBridge'

describe('yohoRemoteMcpStdioBridge', () => {
    it('parses --url from argv', () => {
        expect(parseArgs(['--url', 'http://127.0.0.1:3456/'])).toEqual({
            url: 'http://127.0.0.1:3456/'
        })
        expect(parseArgs(['foo'])).toEqual({ url: null })
    })

    it('forwards tools/list to remote MCP client', async () => {
        const listTools = vi.fn<YohoRemoteBridgeClient['listTools']>().mockResolvedValue({
            tools: [
                {
                    name: 'environment_info',
                    description: 'Get environment info',
                    inputSchema: { type: 'object', properties: {} }
                },
                {
                    name: 'project_list',
                    description: 'List projects',
                    inputSchema: { type: 'object', properties: {} }
                }
            ]
        })
        const callTool = vi.fn<YohoRemoteBridgeClient['callTool']>()
        const ensureHttpClient = vi.fn(async () => ({ listTools, callTool }))

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient)
        const result = await handlers.listTools({ cursor: 'cursor-1' })

        expect(ensureHttpClient).toHaveBeenCalledTimes(1)
        expect(listTools).toHaveBeenCalledWith({ cursor: 'cursor-1' })
        expect(result.tools.map((tool) => tool.name)).toEqual(['environment_info', 'project_list'])
    })

    it('forwards tools/call to remote MCP client', async () => {
        const listTools = vi.fn<YohoRemoteBridgeClient['listTools']>()
        const callTool = vi.fn<YohoRemoteBridgeClient['callTool']>().mockResolvedValue({
            content: [{ type: 'text', text: '{"ok":true}' }]
        })
        const ensureHttpClient = vi.fn(async () => ({ listTools, callTool }))

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient)
        const result = await handlers.callTool({
            name: 'project_list',
            arguments: { machineId: 'machine-1' }
        })

        expect(ensureHttpClient).toHaveBeenCalledTimes(1)
        expect(callTool).toHaveBeenCalledWith({
            name: 'project_list',
            arguments: { machineId: 'machine-1' }
        })
        expect(result).toEqual({
            content: [{ type: 'text', text: '{"ok":true}' }]
        })
    })

    it('annotates unsafe skill_search tool results before returning them to Codex', async () => {
        const listTools = vi.fn<YohoRemoteBridgeClient['listTools']>()
        const callTool = vi.fn<YohoRemoteBridgeClient['callTool']>().mockResolvedValue({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    suggestedNextAction: 'discover',
                    hasLocalMatch: false,
                    confidence: 0.9,
                }),
            }]
        })
        const ensureHttpClient = vi.fn(async () => ({ listTools, callTool }))

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient)
        const result = await handlers.callTool({
            name: 'skill_search',
            arguments: { query: 'review workflow' }
        })

        const content = result.content as Array<{ type: string; text?: string }>
        expect(content).toHaveLength(2)
        expect(JSON.parse(content[1]?.text as string)).toMatchObject({
            yohoConsumptionGate: {
                kind: 'skill_search',
                directUseAllowed: false,
            },
        })
    })

    it('does not override explicit directUseAllowed=false from skill_search', async () => {
        const listTools = vi.fn<YohoRemoteBridgeClient['listTools']>()
        const callTool = vi.fn<YohoRemoteBridgeClient['callTool']>().mockResolvedValue({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    directUseAllowed: false,
                    suggestedNextAction: 'use_results',
                    hasLocalMatch: true,
                    confidence: 0.99,
                }),
            }]
        })
        const ensureHttpClient = vi.fn(async () => ({ listTools, callTool }))

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient)
        const result = await handlers.callTool({
            name: 'skill_search',
            arguments: { query: 'review workflow' }
        })

        const content = result.content as Array<{ type: string; text?: string }>
        expect(JSON.parse(content[1]?.text as string)).toMatchObject({
            yohoConsumptionGate: {
                kind: 'skill_search',
                directUseAllowed: false,
                reason: expect.stringContaining('directUseAllowed=false'),
            },
        })
    })

    it('blocks skill_search when scope does not match', async () => {
        const listTools = vi.fn<YohoRemoteBridgeClient['listTools']>()
        const callTool = vi.fn<YohoRemoteBridgeClient['callTool']>().mockResolvedValue({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    directUseAllowed: true,
                    suggestedNextAction: 'use_results',
                    hasLocalMatch: true,
                    confidence: 0.99,
                    scope: {
                        matched: false,
                    },
                }),
            }]
        })
        const ensureHttpClient = vi.fn(async () => ({ listTools, callTool }))

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient)
        const result = await handlers.callTool({
            name: 'skill_search',
            arguments: { query: 'review workflow' }
        })

        const content = result.content as Array<{ type: string; text?: string }>
        expect(JSON.parse(content[1]?.text as string)).toMatchObject({
            yohoConsumptionGate: {
                kind: 'skill_search',
                directUseAllowed: false,
                reason: expect.stringContaining('scope.matched=false'),
            },
        })
    })

    it('blocks recall results when the new protocol says unusable, scope mismatches, or result count is missing', async () => {
        const listTools = vi.fn<YohoRemoteBridgeClient['listTools']>()
        const callTool = vi.fn<YohoRemoteBridgeClient['callTool']>()
            .mockResolvedValueOnce({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        isDirectlyUsable: false,
                        answer: 'old answer',
                        filesSearched: 1,
                        confidence: 0.9,
                    }),
                }]
            })
            .mockResolvedValueOnce({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        answer: 'old answer',
                        filesSearched: 1,
                        confidence: 0.9,
                        scope: {
                            matched: false,
                        },
                    }),
                }]
            })
            .mockResolvedValueOnce({
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        answer: 'old answer',
                        confidence: 0.9,
                    }),
                }]
            })
        const ensureHttpClient = vi.fn(async () => ({ listTools, callTool }))
        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient)

        const explicit = await handlers.callTool({ name: 'recall', arguments: { query: 'a' } })
        const scope = await handlers.callTool({ name: 'recall', arguments: { query: 'b' } })
        const missingCount = await handlers.callTool({ name: 'recall', arguments: { query: 'c' } })

        expect(JSON.parse((explicit.content as Array<{ text?: string }>)[1]?.text as string)).toMatchObject({
            yohoConsumptionGate: {
                kind: 'recall',
                directUseAllowed: false,
                reason: expect.stringContaining('isDirectlyUsable=false'),
            },
        })
        expect(JSON.parse((scope.content as Array<{ text?: string }>)[1]?.text as string)).toMatchObject({
            yohoConsumptionGate: {
                kind: 'recall',
                directUseAllowed: false,
                reason: expect.stringContaining('scope.matched=false'),
            },
        })
        expect(JSON.parse((missingCount.content as Array<{ text?: string }>)[1]?.text as string)).toMatchObject({
            yohoConsumptionGate: {
                kind: 'recall',
                directUseAllowed: false,
                reason: expect.stringContaining('缺少 resultCount/filesSearched'),
            },
        })
    })
})
