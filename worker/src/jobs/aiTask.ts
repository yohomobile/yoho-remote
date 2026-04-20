import type { PgBoss } from 'pg-boss'
import type { WorkerConfig } from '../config'
import type { AiTaskPayload } from '../handlers/aiTask'

// AI_TASK_RUN_QUEUE is added to boss.ts by Path 1
export const AI_TASK_RUN_QUEUE = 'ai-task' as const

// Path 1 extends WorkerConfig with aiTaskTimeoutMs
type AiTaskSendConfig = WorkerConfig & { aiTaskTimeoutMs: number }

export async function sendAiTaskRun(
    boss: PgBoss,
    payload: AiTaskPayload,
    config: AiTaskSendConfig,
    singletonKey?: string,
): Promise<void> {
    await boss.send(AI_TASK_RUN_QUEUE, payload, {
        singletonKey: singletonKey ?? `aitaskrun:${payload.runId}`,
        retryLimit: 1,
        retryDelay: 60,
        expireInSeconds: Math.ceil(config.aiTaskTimeoutMs / 1000) + 300,
    })
}
