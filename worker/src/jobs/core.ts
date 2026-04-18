import type { JobWithMetadata, PgBoss } from 'pg-boss'
import type { ZodType } from 'zod'
import type { WorkerConfig } from '../config'
import type { WorkerContext } from '../types'

export type WorkerQueueOptions = {
    retryLimit?: number
    retryDelay?: number
    retryBackoff?: boolean
    retryDelayMax?: number
}

export type WorkerJobMetadata = {
    id?: string | null
    name: string
    family: string
    version: number
    queueName: string
    idempotencyKey: string
    retryCount?: number
    retryLimit?: number
    retryDelay?: number
    retryBackoff?: boolean
    retryDelayMax?: number
    singletonKey?: string | null
    createdOn?: Date
    startedOn?: Date
}

export type WorkerJobDefinition<TData extends { idempotencyKey: string }> = {
    name: string
    family: string
    version: number
    queueName: string
    schema: ZodType<TData>
    getQueueOptions(config: WorkerConfig): WorkerQueueOptions
    handle(data: TData, job: WorkerJobMetadata, ctx: WorkerContext): Promise<void>
}

type BossLike = Pick<PgBoss, 'createQueue' | 'updateQueue' | 'work'>

function toWorkerJobMetadata<TData extends { idempotencyKey: string }>(
    definition: WorkerJobDefinition<TData>,
    job: JobWithMetadata<unknown>,
    data: TData
): WorkerJobMetadata {
    return {
        id: job.id ?? null,
        name: definition.name,
        family: definition.family,
        version: definition.version,
        queueName: definition.queueName,
        idempotencyKey: data.idempotencyKey,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        retryDelay: job.retryDelay,
        retryBackoff: job.retryBackoff,
        retryDelayMax: job.retryDelayMax,
        singletonKey: job.singletonKey,
        createdOn: job.createdOn,
        startedOn: job.startedOn,
    }
}

export async function registerWorkerJobs(
    boss: BossLike,
    ctx: WorkerContext,
    definitions: ReadonlyArray<WorkerJobDefinition<any>>
): Promise<void> {
    for (const definition of definitions) {
        const queueOptions = definition.getQueueOptions(ctx.config)
        await boss.createQueue(definition.queueName, queueOptions)
        await boss.updateQueue(definition.queueName, queueOptions)
        await boss.work(definition.queueName, {
            batchSize: 1,
            localConcurrency: ctx.config.workerConcurrency,
            includeMetadata: true,
        }, async (jobs: JobWithMetadata<unknown>[]) => {
            for (const job of jobs) {
                const parsed = definition.schema.safeParse(job.data)
                if (!parsed.success) {
                    console.error(
                        `[Worker] Invalid ${definition.name} payload:`,
                        parsed.error.flatten()
                    )
                    continue
                }

                await definition.handle(
                    parsed.data,
                    toWorkerJobMetadata(definition, job, parsed.data),
                    ctx
                )
            }
        })
    }
}
