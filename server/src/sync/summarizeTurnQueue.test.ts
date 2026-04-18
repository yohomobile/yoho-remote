import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
    SUMMARIZE_TURN_QUEUE_NAME,
    SUMMARIZE_TURN_JOB_VERSION,
    createSummarizeTurnQueuePublisher,
    type SummarizeTurnJobData
} from './summarizeTurnQueue'

type BossInstanceRecord = {
    constructorArg: unknown
    lifecycle: string[]
    queueCalls: Array<{
        kind: 'create' | 'update'
        queueName: string
        options?: {
            retryLimit?: number
            retryDelay?: number
            retryBackoff?: boolean
            retryDelayMax?: number
        }
    }>
    sendCalls: Array<{
        queueName: string
        payload: SummarizeTurnJobData
        options?: { singletonKey?: string }
    }>
}

const bossInstances: BossInstanceRecord[] = []
const originalRetryEnv = {
    retryLimit: process.env.SUMMARIZE_TURN_RETRY_LIMIT,
    retryDelay: process.env.SUMMARIZE_TURN_RETRY_DELAY_SECONDS,
    retryBackoff: process.env.SUMMARIZE_TURN_RETRY_BACKOFF,
    retryDelayMax: process.env.SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS,
}

class FakePgBoss {
    private readonly record: BossInstanceRecord

    constructor(connection: unknown) {
        this.record = {
            constructorArg: connection,
            lifecycle: [],
            queueCalls: [],
            sendCalls: []
        }
        bossInstances.push(this.record)
    }

    async start(): Promise<void> {
        this.record.lifecycle.push('start')
    }

    async createQueue(
        queueName: string,
        options?: {
            retryLimit?: number
            retryDelay?: number
            retryBackoff?: boolean
            retryDelayMax?: number
        }
    ): Promise<void> {
        this.record.lifecycle.push(`createQueue:${queueName}`)
        this.record.queueCalls.push({ kind: 'create', queueName, options })
    }

    async updateQueue(
        queueName: string,
        options?: {
            retryLimit?: number
            retryDelay?: number
            retryBackoff?: boolean
            retryDelayMax?: number
        }
    ): Promise<void> {
        this.record.lifecycle.push(`updateQueue:${queueName}`)
        this.record.queueCalls.push({ kind: 'update', queueName, options })
    }

    async send(
        queueName: string,
        payload: SummarizeTurnJobData,
        options?: { singletonKey?: string }
    ): Promise<string> {
        this.record.sendCalls.push({ queueName, payload, options })
        return 'job-1'
    }

    async stop(): Promise<void> {
        this.record.lifecycle.push('stop')
    }
}

mock.module('pg-boss', () => ({
    PgBoss: FakePgBoss
}))

describe('createSummarizeTurnQueuePublisher', () => {
    beforeEach(() => {
        bossInstances.length = 0
        delete process.env.SUMMARIZE_TURN_RETRY_LIMIT
        delete process.env.SUMMARIZE_TURN_RETRY_DELAY_SECONDS
        delete process.env.SUMMARIZE_TURN_RETRY_BACKOFF
        delete process.env.SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS
    })

    afterEach(() => {
        if (originalRetryEnv.retryLimit === undefined) {
            delete process.env.SUMMARIZE_TURN_RETRY_LIMIT
        } else {
            process.env.SUMMARIZE_TURN_RETRY_LIMIT = originalRetryEnv.retryLimit
        }
        if (originalRetryEnv.retryDelay === undefined) {
            delete process.env.SUMMARIZE_TURN_RETRY_DELAY_SECONDS
        } else {
            process.env.SUMMARIZE_TURN_RETRY_DELAY_SECONDS = originalRetryEnv.retryDelay
        }
        if (originalRetryEnv.retryBackoff === undefined) {
            delete process.env.SUMMARIZE_TURN_RETRY_BACKOFF
        } else {
            process.env.SUMMARIZE_TURN_RETRY_BACKOFF = originalRetryEnv.retryBackoff
        }
        if (originalRetryEnv.retryDelayMax === undefined) {
            delete process.env.SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS
        } else {
            process.env.SUMMARIZE_TURN_RETRY_DELAY_MAX_SECONDS = originalRetryEnv.retryDelayMax
        }
    })

    test('uses named PgBoss export, wires schema, and creates summarize-turn queue on init', async () => {
        const publisher = await createSummarizeTurnQueuePublisher({
            host: 'db.example',
            port: 5432,
            user: 'yoho',
            password: 'p@ss',
            database: 'yoho_remote',
            ssl: { rejectUnauthorized: false },
            bossSchema: 'yr_boss'
        })

        expect(publisher).not.toBeNull()
        expect(bossInstances).toHaveLength(1)
        expect(bossInstances[0]?.constructorArg).toEqual({
            connectionString: 'postgres://yoho:p%40ss@db.example:5432/yoho_remote?sslmode=require',
            schema: 'yr_boss',
            ssl: { rejectUnauthorized: false }
        })
        expect(bossInstances[0]?.queueCalls).toEqual([
            {
                kind: 'create',
                queueName: SUMMARIZE_TURN_QUEUE_NAME,
                options: {
                    retryLimit: 4,
                    retryDelay: 15,
                    retryBackoff: true,
                    retryDelayMax: 300,
                }
            },
            {
                kind: 'update',
                queueName: SUMMARIZE_TURN_QUEUE_NAME,
                options: {
                    retryLimit: 4,
                    retryDelay: 15,
                    retryBackoff: true,
                    retryDelayMax: 300,
                }
            },
        ])
        expect(bossInstances[0]?.lifecycle).toEqual([
            'start',
            `createQueue:${SUMMARIZE_TURN_QUEUE_NAME}`,
            `updateQueue:${SUMMARIZE_TURN_QUEUE_NAME}`,
        ])
    })

    test('proxies queue name, payload, and singletonKey without drifting', async () => {
        const publisher = await createSummarizeTurnQueuePublisher({
            host: 'localhost',
            port: 5432,
            user: 'postgres',
            password: '',
            database: 'yoho_remote',
            bossSchema: 'pgboss'
        })

        const payload: SummarizeTurnJobData = {
            version: SUMMARIZE_TURN_JOB_VERSION,
            idempotencyKey: 'turn:session-1:11',
            payload: {
                sessionId: 'session-1',
                namespace: 'ns-a',
                userSeq: 11,
                scheduledAtMs: 1_700_000_000_123
            },
        }

        await publisher?.send(SUMMARIZE_TURN_QUEUE_NAME, payload, {
            singletonKey: 'turn:session-1:11'
        })
        await publisher?.stop()

        expect(bossInstances).toHaveLength(1)
        expect(bossInstances[0]?.sendCalls).toEqual([{
            queueName: SUMMARIZE_TURN_QUEUE_NAME,
            payload,
            options: {
                singletonKey: 'turn:session-1:11'
            }
        }])
        expect(bossInstances[0]?.lifecycle).toEqual([
            'start',
            `createQueue:${SUMMARIZE_TURN_QUEUE_NAME}`,
            `updateQueue:${SUMMARIZE_TURN_QUEUE_NAME}`,
            'stop'
        ])
    })
})
