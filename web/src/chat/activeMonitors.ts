import type { ChatBlock, ChatToolCall } from '@/chat/types'
import type { SessionActiveMonitor as ActiveMonitor } from '@/types/api'

export type { ActiveMonitor }

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null
}

function isMonitorToolName(name: string): boolean {
    if (name === 'Monitor') return true
    return name.endsWith('__Monitor')
}

function readMonitorInput(tool: ChatToolCall): {
    description: string
    command: string
    persistent: boolean
    timeoutMs: number | null
} {
    const input = isObject(tool.input) ? tool.input : {}
    return {
        description: typeof input.description === 'string' ? input.description : '',
        command: typeof input.command === 'string' ? input.command : '',
        persistent: input.persistent === true,
        timeoutMs: typeof input.timeout_ms === 'number' ? input.timeout_ms : null
    }
}

function isTerminalTaskStatus(status: string): boolean {
    return status === 'completed' || status === 'failed' || status === 'stopped' || status === 'killed'
}

// Monitor's tool_result fires immediately ("monitor started"), so tool.state reaches
// 'completed' right away. Real background-process liveness is tracked via SDK task
// events: task_started (open bookend) → task_notification with terminal status (close).
// Both events carry tool_use_id matching the Monitor tool call.
//
// Reducer gotcha: task-notification is folded into its matching task-started block
// and dropped from the stream (to avoid a duplicate 🚀/📋 row). The fold copies the
// notification's `status` onto the task-started event, so a "closed" Monitor shows up
// as a task-started event whose status is terminal. We detect both the merged form
// and any stray independent task-notification (in case merge failed).
//
// Fallback: if the CLI didn't include tool_use_id on task events (older SDK) and the
// tool_call is still pending/running, treat it as active — covers permission-prompt
// and pre-start windows.
export function collectActiveMonitors(blocks: ChatBlock[]): ActiveMonitor[] {
    const monitorCalls: Array<{ toolUseId: string; tool: ChatToolCall; createdAt: number }> = []
    const startedByToolUseId = new Map<string, { taskId: string | null; startedAt: number }>()
    const closedToolUseIds = new Set<string>()

    const walk = (list: ChatBlock[]): void => {
        for (const block of list) {
            if (block.kind === 'tool-call') {
                if (isMonitorToolName(block.tool.name)) {
                    monitorCalls.push({
                        toolUseId: block.tool.id,
                        tool: block.tool,
                        createdAt: block.tool.startedAt ?? block.createdAt
                    })
                }
                if (block.children.length > 0) walk(block.children)
                continue
            }
            if (block.kind === 'agent-event') {
                const event = block.event as {
                    type: string
                    toolUseId?: unknown
                    taskId?: unknown
                    status?: unknown
                }
                const toolUseId = typeof event.toolUseId === 'string' ? event.toolUseId : null
                if (!toolUseId) continue
                const status = typeof event.status === 'string' ? event.status : ''
                if (event.type === 'task-started') {
                    if (!startedByToolUseId.has(toolUseId)) {
                        startedByToolUseId.set(toolUseId, {
                            taskId: typeof event.taskId === 'string' ? event.taskId : null,
                            startedAt: block.createdAt
                        })
                    }
                    // task-started carries a terminal status only after the reducer
                    // merged a task-notification into it — that means the task closed.
                    if (isTerminalTaskStatus(status)) {
                        closedToolUseIds.add(toolUseId)
                    }
                } else if (event.type === 'task-notification') {
                    if (isTerminalTaskStatus(status)) {
                        closedToolUseIds.add(toolUseId)
                    }
                }
            }
        }
    }
    walk(blocks)

    const out: ActiveMonitor[] = []
    for (const mc of monitorCalls) {
        if (closedToolUseIds.has(mc.toolUseId)) continue
        const started = startedByToolUseId.get(mc.toolUseId)
        const hasStartedEvent = started !== undefined
        const toolStillInFlight = mc.tool.state === 'pending' || mc.tool.state === 'running'
        if (!hasStartedEvent && !toolStillInFlight) continue
        const info = readMonitorInput(mc.tool)
        out.push({
            id: mc.toolUseId,
            description: info.description,
            command: info.command,
            persistent: info.persistent,
            timeoutMs: info.timeoutMs,
            startedAt: started?.startedAt ?? mc.createdAt,
            taskId: started?.taskId ?? null,
            state: 'running'
        })
    }
    return out
}
