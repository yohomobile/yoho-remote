import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { createVersionedJobDataSchema } from '../boss'
import { registerWorkerJobs, type WorkerJobDefinition } from './core'
import type { WorkerContext } from '../types'

function createContext(): WorkerContext {
    return {
        config: {
            workerConcurrency: 2,
        },
    } as WorkerContext
}

describe('registerWorkerJobs', () => {
    it('registers queue options and passes standardized metadata to handlers', async () => {
        const createQueueCalls: Array<{ queueName: string; options?: Record<string, unknown> }> = []
        const updateQueueCalls: Array<{ queueName: string; options?: Record<string, unknown> }> = []
        const workCalls: Array<{ queueName: string; options?: Record<string, unknown> }> = []
        let workHandler: ((jobs: Array<Record<string, unknown>>) => Promise<void>) | null = null
        const handled: Array<Record<string, unknown>> = []

        const boss = {
            async createQueue(queueName: string, options?: Record<string, unknown>) {
                createQueueCalls.push({ queueName, options })
            },
            async updateQueue(queueName: string, options?: Record<string, unknown>) {
                updateQueueCalls.push({ queueName, options })
            },
            async work(
                queueName: string,
                options: Record<string, unknown>,
                handler: (jobs: Array<Record<string, unknown>>) => Promise<void>
            ) {
                workCalls.push({ queueName, options })
                workHandler = handler
            },
        }

        const definition: WorkerJobDefinition<{
            version: 1
            idempotencyKey: string
            payload: { sessionId: string }
        }> = {
            name: 'demo-job',
            family: 'demo-family',
            version: 1,
            queueName: 'demo-job',
            schema: createVersionedJobDataSchema(1, z.object({
                sessionId: z.string().min(1),
            })),
            getQueueOptions() {
                return {
                    retryLimit: 5,
                    retryDelay: 10,
                }
            },
            async handle(data, job) {
                handled.push({ data, job })
            },
        }

        await registerWorkerJobs(boss as never, createContext(), [definition])
        expect(workHandler).not.toBeNull()
        await workHandler!([{
            id: 'job-1',
            data: {
                version: 1,
                idempotencyKey: 'demo:session-1',
                payload: {
                    sessionId: 'session-1',
                },
            },
            retryCount: 2,
            retryLimit: 5,
            retryDelay: 10,
            retryBackoff: true,
            retryDelayMax: 120,
            singletonKey: 'demo:session-1',
            createdOn: new Date(1_700_000_000_000),
            startedOn: new Date(1_700_000_000_500),
        }])

        expect(createQueueCalls).toEqual([{
            queueName: 'demo-job',
            options: {
                retryLimit: 5,
                retryDelay: 10,
            },
        }])
        expect(updateQueueCalls).toEqual([{
            queueName: 'demo-job',
            options: {
                retryLimit: 5,
                retryDelay: 10,
            },
        }])
        expect(workCalls).toEqual([{
            queueName: 'demo-job',
            options: {
                batchSize: 1,
                localConcurrency: 2,
                includeMetadata: true,
            },
        }])
        expect(handled).toHaveLength(1)
        expect(handled[0]).toMatchObject({
            data: {
                version: 1,
                idempotencyKey: 'demo:session-1',
                payload: {
                    sessionId: 'session-1',
                },
            },
            job: {
                id: 'job-1',
                name: 'demo-job',
                family: 'demo-family',
                version: 1,
                queueName: 'demo-job',
                idempotencyKey: 'demo:session-1',
                retryCount: 2,
                retryLimit: 5,
                retryDelay: 10,
                retryBackoff: true,
                retryDelayMax: 120,
                singletonKey: 'demo:session-1',
            },
        })
    })

    it('drops invalid payloads before they reach the handler', async () => {
        let workHandler: ((jobs: Array<Record<string, unknown>>) => Promise<void>) | null = null
        let handledCount = 0

        const boss = {
            async createQueue() {},
            async updateQueue() {},
            async work(
                _queueName: string,
                _options: Record<string, unknown>,
                handler: (jobs: Array<Record<string, unknown>>) => Promise<void>
            ) {
                workHandler = handler
            },
        }

        const definition: WorkerJobDefinition<{
            version: 1
            idempotencyKey: string
            payload: { sessionId: string }
        }> = {
            name: 'demo-job',
            family: 'demo-family',
            version: 1,
            queueName: 'demo-job',
            schema: createVersionedJobDataSchema(1, z.object({
                sessionId: z.string().min(1),
            })),
            getQueueOptions() {
                return {}
            },
            async handle() {
                handledCount += 1
            },
        }

        await registerWorkerJobs(boss as never, createContext(), [definition])
        expect(workHandler).not.toBeNull()
        await workHandler!([{
            id: 'job-2',
            data: {
                version: 1,
                idempotencyKey: '',
                payload: {
                    sessionId: '',
                },
            },
        }])

        expect(handledCount).toBe(0)
    })
})
