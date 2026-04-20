import {
    JOB_FAMILY,
    QUEUE,
    SUMMARIZE_TURN_JOB_VERSION,
    type SummarizeTurnJobData,
    summarizeTurnJobDataSchema,
} from '../boss'
import { handleSummarizeTurn } from '../handlers/summarizeTurn'
import { summarizeSegmentJobDefinition } from './summarizeSegment'
import { summarizeSessionJobDefinition } from './summarizeSession'
import type { WorkerJobDefinition } from './core'

export const summarizeTurnJobDefinition: WorkerJobDefinition<SummarizeTurnJobData> = {
    name: QUEUE.SUMMARIZE_TURN,
    family: JOB_FAMILY.SESSION_SUMMARY,
    version: SUMMARIZE_TURN_JOB_VERSION,
    queueName: QUEUE.SUMMARIZE_TURN,
    schema: summarizeTurnJobDataSchema,
    getQueueOptions(config) {
        return {
            retryLimit: config.summarizeTurnQueue.retryLimit,
            retryDelay: config.summarizeTurnQueue.retryDelaySeconds,
            retryBackoff: config.summarizeTurnQueue.retryBackoff,
            retryDelayMax: config.summarizeTurnQueue.retryDelayMaxSeconds,
        }
    },
    async handle(data, job, ctx) {
        await handleSummarizeTurn(data.payload, job, ctx)
    },
}

export const workerJobDefinitions = [
    summarizeTurnJobDefinition,
    summarizeSegmentJobDefinition,
    summarizeSessionJobDefinition,
] as const
