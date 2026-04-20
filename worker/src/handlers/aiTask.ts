import { z } from 'zod'
import { AiTaskStore } from '../db/aiTaskStore'
import type { WorkerContext } from '../types'
import type { WorkerConfig } from '../config'

// Path 1 extends WorkerConfig with these fields
type AiTaskExtendedConfig = WorkerConfig & {
    yohoRemoteInternalUrl: string
    workerInternalToken: string
    aiTaskTimeoutMs: number
}

export const aiTaskPayloadSchema = z.object({
    scheduleId: z.string().min(1),
    runId: z.string().min(1),
    prompt: z.string().min(1),
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex']),
    mode: z.string().nullish(),
    machineId: z.string().min(1),
})

export type AiTaskPayload = z.infer<typeof aiTaskPayloadSchema>

const POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000

function getAiTaskConfig(ctx: WorkerContext): AiTaskExtendedConfig {
    return ctx.config as AiTaskExtendedConfig
}

function buildFindOrCreateBody(payload: AiTaskPayload): Record<string, unknown> {
    const { directory, agent, mode, machineId } = payload

    if (agent === 'claude') {
        return {
            directory,
            agent,
            machineId,
            modelMode: mode ?? 'sonnet',
        }
    }

    return {
        directory,
        agent,
        machineId,
        codexModel: mode ?? 'gpt-5.4',
        permissionMode: 'safe-yolo',
    }
}

async function internalPost(
    baseUrl: string,
    token: string,
    path: string,
    body: unknown,
): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Worker-Token': token,
        },
        body: JSON.stringify(body),
    })
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export async function handleAiTask(
    payload: AiTaskPayload,
    ctx: WorkerContext,
): Promise<void> {
    const config = getAiTaskConfig(ctx)
    const baseUrl = config.yohoRemoteInternalUrl
    const token = config.workerInternalToken
    const timeoutMs = config.aiTaskTimeoutMs ?? DEFAULT_TIMEOUT_MS

    const store = new AiTaskStore(ctx.pool)
    const startedAt = Date.now()

    await store.updateRunStatus(payload.runId, 'running', startedAt)

    let sessionId: string | null = null

    try {
        // Step 1: find-or-create session
        const spawnRes = await internalPost(
            baseUrl,
            token,
            '/api/internal/session/find-or-create',
            buildFindOrCreateBody(payload),
        )

        if (!spawnRes.ok) {
            const errText = await spawnRes.text().catch(() => String(spawnRes.status))
            console.error(
                `[aiTask] find-or-create failed: runId=${payload.runId} status=${spawnRes.status} body=${errText}`,
            )
            await store.updateRunResult(payload.runId, {
                status: 'failed',
                finishedAt: Date.now(),
                error: `find-or-create failed ${spawnRes.status}: ${errText}`,
            })
            return
        }

        const spawnData = (await spawnRes.json()) as { sessionId: string }
        sessionId = spawnData.sessionId

        // Step 2: send prompt
        const sendRes = await internalPost(baseUrl, token, '/api/internal/session/send', {
            sessionId,
            prompt: payload.prompt,
        })

        if (!sendRes.ok) {
            const errText = await sendRes.text().catch(() => String(sendRes.status))
            console.error(
                `[aiTask] send failed: runId=${payload.runId} sessionId=${sessionId} status=${sendRes.status} body=${errText}`,
            )
            await store.updateRunResult(payload.runId, {
                status: 'failed',
                finishedAt: Date.now(),
                subsessionId: sessionId,
                error: `send failed ${sendRes.status}: ${errText}`,
            })
            return
        }

        // Step 3: poll until session is no longer executing
        const deadline = startedAt + timeoutMs

        while (true) {
            await sleep(POLL_INTERVAL_MS)

            if (Date.now() >= deadline) {
                console.warn(
                    `[aiTask] timeout: runId=${payload.runId} sessionId=${sessionId} after ${timeoutMs}ms`,
                )
                await internalPost(baseUrl, token, '/api/internal/session/stop', {
                    sessionId,
                }).catch(err => {
                    console.error(
                        `[aiTask] stop request failed for sessionId=${sessionId}:`,
                        err,
                    )
                })
                await store.updateRunResult(payload.runId, {
                    status: 'timeout',
                    finishedAt: Date.now(),
                    subsessionId: sessionId,
                    error: `timed out after ${timeoutMs}ms`,
                })
                return
            }

            const statusRes = await internalPost(
                baseUrl,
                token,
                '/api/internal/session/status',
                { sessionId },
            )

            if (!statusRes.ok) {
                console.warn(
                    `[aiTask] status poll returned ${statusRes.status} for sessionId=${sessionId}, retrying`,
                )
                continue
            }

            const statusData = (await statusRes.json()) as { executing: boolean }

            if (!statusData.executing) {
                await store.updateRunResult(payload.runId, {
                    status: 'succeeded',
                    finishedAt: Date.now(),
                    subsessionId: sessionId,
                })
                return
            }
        }
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        console.error(`[aiTask] unexpected error: runId=${payload.runId}`, error)

        await store.updateRunResult(payload.runId, {
            status: 'failed',
            finishedAt: Date.now(),
            subsessionId: sessionId ?? undefined,
            error: errMsg,
        }).catch(storeErr => {
            console.error(
                `[aiTask] failed to record error result: runId=${payload.runId}`,
                storeErr,
            )
        })

        throw error
    }
}
