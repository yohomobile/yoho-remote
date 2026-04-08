/**
 * Machine MCP Tools
 *
 * Provides machine awareness tools for all sessions.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'

interface SessionToolsOptions {
    apiClient: ApiClient
    sessionId: string
}

export function registerSessionTools(
    mcp: McpServer,
    toolNames: string[],
    options: SessionToolsOptions
): void {
    const { apiClient: api } = options

    // ===== machine_list =====
    mcp.registerTool<any, any>('machine_list', {
        title: 'List Machines',
        description: 'List all machines with their online status, host, IP, platform, CLI version, and daemon details.',
        inputSchema: z.object({}),
    }, async () => {
        try {
            const machines = await api.listMachines()
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(machines, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[sessionTools] machine_list error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to list machines: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('machine_list')
}
