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
})
