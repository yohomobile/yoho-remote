import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import type { WorkerConfig } from './config'
import type { RunStore } from './db/runStore'
import type { SessionStore } from './db/sessionStore'
import type { SummaryStore } from './db/summaryStore'
import type { DeepSeekClient } from './llm/deepseek'

export type DbMessage = {
    id: string
    seq: number
    content: unknown
    createdAt: number
}

export type SessionSnapshot = {
    id: string
    namespace: string
    thinking: boolean
}

export type ProviderTelemetry = {
    provider: string
    model: string | null
    statusCode: number | null
    requestId: string | null
    finishReason: string | null
    errorCode: string | null
}

export type L1SummaryRecord = {
    summary: string
    topic: string
    tools: string[]
    entities: string[]
    provider?: ProviderTelemetry | null
}

export type L1SummaryResult = L1SummaryRecord & {
    tokensIn: number | null
    tokensOut: number | null
    rawResponse: string
    provider: ProviderTelemetry
}

export type StoredL1Summary = {
    id: string
    seqStart: number | null
    seqEnd: number | null
    summary: string
    topic: string | null
    tools: string[]
    entities: string[]
}

export type StoredL2Summary = {
    id: string
    seqStart: number | null
    seqEnd: number | null
    summary: string
    topic: string | null
    tools: string[]
    entities: string[]
}

export type LLMSummaryResult = {
    summary: string
    topic: string
    tools: string[]
    entities: string[]
    tokensIn: number | null
    tokensOut: number | null
    rawResponse: string
    provider: ProviderTelemetry
}

export type WorkerIdentity = {
    host: string
    version: string
}

export type WorkerContext = {
    config: WorkerConfig
    worker: WorkerIdentity
    pool: Pool
    boss: PgBoss
    sessionStore: SessionStore
    summaryStore: SummaryStore
    runStore: RunStore
    deepseekClient: DeepSeekClient
}
