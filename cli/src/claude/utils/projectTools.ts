/**
 * Project MCP Tools
 *
 * Provides project CRUD tools for all sessions (brain and non-brain).
 * Projects are scoped to the session's organization via server-side orgId resolution.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'

interface ProjectToolsOptions {
    apiClient: ApiClient
    sessionId: string
}

export function registerProjectTools(
    mcp: McpServer,
    toolNames: string[],
    options: ProjectToolsOptions
): void {
    const { apiClient: api, sessionId } = options

    // ===== 1. project_list =====
    const listSchema: z.ZodTypeAny = z.object({})

    mcp.registerTool<any, any>('project_list', {
        title: 'List Projects',
        description: 'List all shared projects for the current organization.',
        inputSchema: listSchema,
    }, async (_args: Record<string, never>) => {
        try {
            const projects = await api.getProjects(sessionId)
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[projectTools] project_list error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to list projects: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('project_list')

    // ===== 2. project_create =====
    const createSchema: z.ZodTypeAny = z.object({
        name: z.string().optional().describe('Project name in PascalCase derived from directory basename (e.g. "yoho-remote" → "YohoRemote"). If omitted, auto-derived from path.'),
        path: z.string().describe('Absolute path to the project directory'),
        description: z.string().optional().describe('Human-readable project description (max 500 chars). Use this for any non-ASCII or verbose info.'),
    })

    mcp.registerTool<any, any>('project_create', {
        title: 'Create Project',
        description: `Register a project directory with the organization.

Rules:
- Before creating, call project_list to check if a project with the same path already exists. Do not create duplicates.
- "name" must be PascalCase derived from the directory basename (e.g. "my-cool-app" → "MyCoolApp"). No Chinese characters, no spaces. If omitted, the server auto-derives it.
- Use "description" for human-readable context (Chinese is fine here).
- Only register real project root directories (ones containing git repos, package.json, etc.), not arbitrary paths.`,
        inputSchema: createSchema,
    }, async (args: { name?: string; path: string; description?: string }) => {
        try {
            const project = await api.addProject(sessionId, {
                name: args.name,
                path: args.path,
                description: args.description,
            })
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[projectTools] project_create error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to create project: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('project_create')

    // ===== 3. project_update =====
    const updateSchema: z.ZodTypeAny = z.object({
        id: z.string().describe('Project ID to update'),
        name: z.string().optional().describe('New project name in PascalCase (e.g. "YohoRemote"). If omitted, unchanged.'),
        path: z.string().optional().describe('New absolute path. If omitted, unchanged.'),
        description: z.string().optional().describe('New human-readable description (max 500 chars). If omitted, unchanged.'),
    })

    mcp.registerTool<any, any>('project_update', {
        title: 'Update Project',
        description: `Update an existing project. Only provide the fields you want to change — omitted fields are preserved.

Rules:
- "name" must follow PascalCase convention derived from directory basename. No Chinese characters, no spaces.
- Use "description" for human-readable context (Chinese is fine here).`,
        inputSchema: updateSchema,
    }, async (args: { id: string; name?: string; path?: string; description?: string }) => {
        try {
            const project = await api.updateProject(sessionId, args.id, {
                name: args.name,
                path: args.path,
                description: args.description,
            })
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[projectTools] project_update error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to update project: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('project_update')

    // ===== 4. project_delete =====
    const deleteSchema: z.ZodTypeAny = z.object({
        id: z.string().describe('Project ID to delete'),
    })

    mcp.registerTool<any, any>('project_delete', {
        title: 'Delete Project',
        description: 'Delete a project by ID.',
        inputSchema: deleteSchema,
    }, async (args: { id: string }) => {
        try {
            const success = await api.removeProject(sessionId, args.id)
            if (success) {
                return {
                    content: [{ type: 'text' as const, text: 'Project deleted successfully.' }],
                }
            }
            return {
                content: [{ type: 'text' as const, text: 'Failed to delete project.' }],
                isError: true,
            }
        } catch (error: any) {
            logger.debug('[projectTools] project_delete error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to delete project: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('project_delete')
}
