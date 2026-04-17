import type { ChatToolCall } from '@/chat/types'

export function isExitPlanModeToolName(toolName: string): boolean {
    return toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode'
}

type ExitPlanModeRenderState = Pick<ChatToolCall, 'state' | 'permission'>

export function shouldRenderExitPlanModeInteractively(tool: ExitPlanModeRenderState): boolean {
    if (tool.permission?.status === 'pending') return true
    return !tool.permission && (tool.state === 'pending' || tool.state === 'running')
}
