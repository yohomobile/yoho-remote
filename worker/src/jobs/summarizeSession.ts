import {
    JOB_FAMILY,
    QUEUE,
    SUMMARIZE_SESSION_JOB_VERSION,
    type SummarizeSessionJobData,
    summarizeSessionJobDataSchema,
} from '../boss'
import { handleSummarizeSession } from '../handlers/summarizeSession'
import type { WorkerJobDefinition } from './core'

export const summarizeSessionJobDefinition: WorkerJobDefinition<SummarizeSessionJobData> = {
    name: QUEUE.SUMMARIZE_SESSION,
    family: JOB_FAMILY.SESSION_SUMMARY,
    version: SUMMARIZE_SESSION_JOB_VERSION,
    queueName: QUEUE.SUMMARIZE_SESSION,
    schema: summarizeSessionJobDataSchema,
    getQueueOptions(config) {
        return {
            retryLimit: config.summarizeSessionQueue.retryLimit,
            retryDelay: config.summarizeSessionQueue.retryDelaySeconds,
            retryBackoff: config.summarizeSessionQueue.retryBackoff,
            retryDelayMax: config.summarizeSessionQueue.retryDelayMaxSeconds,
        }
    },
    async handle(data, job, ctx) {
        await handleSummarizeSession(data.payload, job, ctx)
    },
}
