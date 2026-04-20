import {
    JOB_FAMILY,
    QUEUE,
    SUMMARIZE_SEGMENT_JOB_VERSION,
    type SummarizeSegmentJobData,
    summarizeSegmentJobDataSchema,
} from '../boss'
import { handleSummarizeSegment } from '../handlers/summarizeSegment'
import type { WorkerJobDefinition } from './core'

export const summarizeSegmentJobDefinition: WorkerJobDefinition<SummarizeSegmentJobData> = {
    name: QUEUE.SUMMARIZE_SEGMENT,
    family: JOB_FAMILY.SESSION_SUMMARY,
    version: SUMMARIZE_SEGMENT_JOB_VERSION,
    queueName: QUEUE.SUMMARIZE_SEGMENT,
    schema: summarizeSegmentJobDataSchema,
    getQueueOptions(config) {
        return {
            retryLimit: config.summarizeSegmentQueue.retryLimit,
            retryDelay: config.summarizeSegmentQueue.retryDelaySeconds,
            retryBackoff: config.summarizeSegmentQueue.retryBackoff,
            retryDelayMax: config.summarizeSegmentQueue.retryDelayMaxSeconds,
        }
    },
    async handle(data, job, ctx) {
        await handleSummarizeSegment(data.payload, job, ctx)
    },
}
