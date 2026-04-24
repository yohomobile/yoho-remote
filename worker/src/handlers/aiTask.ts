import { z } from 'zod'
import { AiTaskStore, type AiTaskRunStatus } from '../db/aiTaskStore'
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
    // mainSessionId: when the schedule was created by another session, the worker
    // session becomes its orchestrator-child so brain-child callback UI lights up.
    mainSessionId: z.string().min(1).nullish(),
    // recurring: suppresses auto-callback on success — only failures fire the callback
    // so the brain doesn't react to every normal cron tick.
    recurring: z.boolean().optional(),
    systemPrompt: z.string().max(8000).nullish(),
    label: z.string().max(200).nullish(),
    tags: z.array(z.string().max(64)).max(20).nullish(),
    ownerEmail: z.string().email().nullish(),
    permissionMode: z.string().nullish(),
})

export type AiTaskPayload = z.infer<typeof aiTaskPayloadSchema>

const POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000

type AiTaskRunMetadata = {
    sessionId?: string
    messageLocalId?: string
    messageSentAt?: number
    findOrCreateAt?: number
}

function getAiTaskConfig(ctx: WorkerContext): AiTaskExtendedConfig {
    return ctx.config as AiTaskExtendedConfig
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function readRunMetadata(value: unknown): AiTaskRunMetadata {
    const record = asRecord(value)
    return {
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
        messageLocalId: typeof record.messageLocalId === 'string' ? record.messageLocalId : undefined,
        messageSentAt: typeof record.messageSentAt === 'number' ? record.messageSentAt : undefined,
        findOrCreateAt: typeof record.findOrCreateAt === 'number' ? record.findOrCreateAt : undefined,
    }
}

function buildMessageLocalId(runId: string): string {
    return `worker-ai-task:${runId}:prompt`
}

function buildFindOrCreateBody(payload: AiTaskPayload): Record<string, unknown> {
    const {
        directory,
        agent,
        mode,
        machineId,
        mainSessionId,
        recurring,
        scheduleId,
        systemPrompt,
        label,
        tags,
        ownerEmail,
        permissionMode,
    } = payload

    // Only attach orchestrator-child fields when we have a creator session — legacy
    // payloads (no mainSessionId) keep the neutral 'worker-ai-task' tag path.
    const orchestrationExtras: Record<string, unknown> = {}
    if (mainSessionId) {
        orchestrationExtras.mainSessionId = mainSessionId
        orchestrationExtras.source = 'orchestrator-child'
        // Recurring schedules only want the brain to hear about failures. The
        // worker will explicitly trigger the callback on error paths.
        orchestrationExtras.callbackOnFailureOnly = recurring === true
    }

    const automationExtras: Record<string, unknown> = {
        scheduleId,
    }
    if (label) automationExtras.label = label
    if (systemPrompt) automationExtras.automationSystemPrompt = systemPrompt
    if (tags && tags.length > 0) automationExtras.tags = tags
    if (ownerEmail) automationExtras.ownerEmail = ownerEmail

    if (agent === 'claude') {
        return {
            directory,
            agent,
            machineId,
            modelMode: mode ?? 'sonnet',
            permissionMode: permissionMode ?? 'safe-yolo',
            ...orchestrationExtras,
            ...automationExtras,
        }
    }

    return {
        directory,
        agent,
        machineId,
        codexModel: mode ?? 'gpt-5.4',
        permissionMode: permissionMode ?? 'safe-yolo',
        ...orchestrationExtras,
        ...automationExtras,
    }
}

// Forces a brain-child callback for recurring-schedule failures whose sessions
// were spawned with callbackOnFailureOnly=true. Safe to call even when the flag
// wasn't set — the server side treats it as a manual re-trigger.
async function triggerFailureCallbackIfNeeded(
    baseUrl: string,
    token: string,
    payload: AiTaskPayload,
    sessionId: string | null,
): Promise<void> {
    if (!sessionId) return
    if (!payload.mainSessionId) return
    if (payload.recurring !== true) return
    try {
        const res = await internalPost(baseUrl, token, '/api/internal/session/trigger-callback', {
            sessionId,
        })
        if (!res.ok) {
            const errText = await res.text().catch(() => String(res.status))
            console.warn(
                `[aiTask] trigger-callback failed: runId=${payload.runId} sessionId=${sessionId} status=${res.status} body=${errText}`,
            )
        }
    } catch (err) {
        console.warn(
            `[aiTask] trigger-callback threw: runId=${payload.runId} sessionId=${sessionId}`,
            err,
        )
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

async function finishRun(
    store: AiTaskStore,
    payload: AiTaskPayload,
    input: {
        status: AiTaskRunStatus
        finishedAt: number
        subsessionId?: string | null
        error?: string | null
    },
): Promise<void> {
    await store.updateRunResult(payload.runId, input)
    if (!payload.scheduleId) return

    const schedule = await store.getSchedule(payload.scheduleId).catch(() => null)
    const previousFailures = schedule?.consecutiveFailures ?? 0
    const consecutiveFailures = input.status === 'succeeded' || input.status === 'deduped'
        ? 0
        : previousFailures + 1
    await store.updateScheduleRunResult(
        payload.scheduleId,
        input.status,
        consecutiveFailures,
    ).catch(err => {
        console.error(
            `[aiTask] failed to update schedule result: scheduleId=${payload.scheduleId}`,
            err,
        )
    })
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

    const existingRun = await store.getRun(payload.runId)
    const metadata = readRunMetadata(existingRun?.metadata)
    const messageLocalId = metadata.messageLocalId ?? buildMessageLocalId(payload.runId)
    let sessionId: string | null = metadata.sessionId ?? existingRun?.subsessionId ?? null

    try {
        if (!sessionId) {
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
                await finishRun(store, payload, {
                    status: 'failed',
                    finishedAt: Date.now(),
                    error: `find-or-create failed ${spawnRes.status}: ${errText}`,
                })
                // No sessionId to trigger callback for — the orchestration path
                // can't fire yet. Nothing to notify the brain about.
                return
            }

            const spawnData = (await spawnRes.json()) as { sessionId: string }
            sessionId = spawnData.sessionId
            await store.updateRunSession(payload.runId, sessionId, {
                ...metadata,
                sessionId,
                messageLocalId,
                findOrCreateAt: Date.now(),
            })
        }

        if (!metadata.messageSentAt) {
            // Step 2: send prompt with a stable localId so retries are idempotent.
            const sendRes = await internalPost(baseUrl, token, '/api/internal/session/send', {
                sessionId,
                message: payload.prompt,
                localId: messageLocalId,
                appendSystemPrompt: payload.systemPrompt ?? undefined,
            })

            if (!sendRes.ok) {
                const errText = await sendRes.text().catch(() => String(sendRes.status))
                console.error(
                    `[aiTask] send failed: runId=${payload.runId} sessionId=${sessionId} status=${sendRes.status} body=${errText}`,
                )
                await finishRun(store, payload, {
                    status: 'failed',
                    finishedAt: Date.now(),
                    subsessionId: sessionId,
                    error: `send failed ${sendRes.status}: ${errText}`,
                })
                await triggerFailureCallbackIfNeeded(baseUrl, token, payload, sessionId)
                return
            }

            await store.mergeRunMetadata(payload.runId, {
                sessionId,
                messageLocalId,
                messageSentAt: Date.now(),
            })
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
                await finishRun(store, payload, {
                    status: 'timeout',
                    finishedAt: Date.now(),
                    subsessionId: sessionId,
                    error: `timed out after ${timeoutMs}ms`,
                })
                await triggerFailureCallbackIfNeeded(baseUrl, token, payload, sessionId)
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
                await finishRun(store, payload, {
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

        await finishRun(store, payload, {
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

        await triggerFailureCallbackIfNeeded(baseUrl, token, payload, sessionId)

        throw error
    }
}
