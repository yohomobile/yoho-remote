import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'

interface ScheduleToolsOptions {
    apiClient: ApiClient
    sessionId: string
}

export function registerScheduleTools(
    mcp: McpServer,
    toolNames: string[],
    options: ScheduleToolsOptions
): void {
    const { apiClient: api, sessionId } = options

    mcp.registerTool<any, any>('schedule_task', {
        title: 'Schedule AI Task',
        description: `Create a scheduled AI task for the current machine-bound session's registered project.

Rules:
- directory must already exist in project_list for this machine.
- cronOrDelay accepts either a 5-field UTC cron (for example "0 9 * * 1") or an ISO-8601 delay (for example "PT30M").
- ISO-8601 delays must use recurring=false.
- recurring=false with a cron means run once at the next matching time, then disable.`,
        inputSchema: z.object({
            cronOrDelay: z.string().min(1).describe('5-field UTC cron like "0 9 * * 1", or ISO-8601 delay like "PT30M".'),
            prompt: z.string().min(1).max(4000).describe('Prompt to send when the schedule fires.'),
            directory: z.string().min(1).describe('Absolute project directory already registered on this machine.'),
            recurring: z.boolean().describe('Whether the schedule repeats. Must be false for ISO-8601 delays.'),
            label: z.string().max(200).optional().describe('Optional human-readable label for the schedule.'),
            agent: z.enum(['claude', 'codex']).describe('Which AI runtime will execute the scheduled task.'),
            mode: z.string().min(1).max(200).optional().describe('Optional model/mode override, such as "sonnet" or "gpt-5.4".'),
        }),
    }, async (args: {
        cronOrDelay: string
        prompt: string
        directory: string
        recurring: boolean
        label?: string
        agent: 'claude' | 'codex'
        mode?: string
    }) => {
        try {
            const result = await api.scheduleTask(sessionId, args)
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[scheduleTools] schedule_task error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to schedule task: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('schedule_task')

    mcp.registerTool<any, any>('list_schedules', {
        title: 'List Scheduled AI Tasks',
        description: 'List scheduled AI tasks for the current machine-bound session.',
        inputSchema: z.object({
            includeDisabled: z.boolean().optional().describe('Whether to include disabled schedules. Default false.'),
        }),
    }, async (args: { includeDisabled?: boolean }) => {
        try {
            const result = await api.listSchedules(sessionId, args)
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[scheduleTools] list_schedules error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to list schedules: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('list_schedules')

    mcp.registerTool<any, any>('cancel_schedule', {
        title: 'Cancel Scheduled AI Task',
        description: 'Disable a scheduled AI task by scheduleId.',
        inputSchema: z.object({
            scheduleId: z.string().min(1).describe('Schedule ID to disable.'),
        }),
    }, async (args: { scheduleId: string }) => {
        try {
            const result = await api.cancelSchedule(sessionId, args.scheduleId)
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            }
        } catch (error: any) {
            logger.debug('[scheduleTools] cancel_schedule error:', error.message)
            return {
                content: [{ type: 'text' as const, text: `Failed to cancel schedule: ${error.response?.data?.error ?? error.message}` }],
                isError: true,
            }
        }
    })
    toolNames.push('cancel_schedule')
}
