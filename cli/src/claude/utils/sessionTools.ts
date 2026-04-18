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

    mcp.registerTool<any, any>('session_search', {
        title: 'Search Session History',
        description: 'Search structured session history to find which previous session handled similar work. Returns ranked matches with session metadata and the matched summary/title/path snippet.',
        inputSchema: z.object({
            query: z.string().min(1).describe('搜索关键词，描述要找的任务或上下文。'),
            limit: z.number().int().min(1).max(10).optional().describe('最多返回多少条，默认 5。'),
            includeOffline: z.boolean().optional().describe('是否包含离线 session，默认 true。'),
            mainSessionId: z.string().optional().describe('只搜索某个 Brain 下面的 child session。'),
            directory: z.string().optional().describe('只搜索某个工作目录下的 session。'),
            flavor: z.enum(['claude', 'codex']).optional().describe('按 agent 过滤。'),
            source: z.string().optional().describe('按 session metadata.source 过滤，例如 brain-child。'),
        }),
    }, async (args: {
        query: string
        limit?: number
        includeOffline?: boolean
        mainSessionId?: string
        directory?: string
        flavor?: 'claude' | 'codex'
        source?: string
    }) => {
        try {
            const result = await api.searchSessions(args)
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[sessionTools] session_search error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to search sessions: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('session_search')

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
