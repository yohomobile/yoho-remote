import { z } from 'zod'

export const QUEUE = {
    SUMMARIZE_TURN: 'summarize-turn',
    SUMMARIZE_SEGMENT: 'summarize-segment',
    SUMMARIZE_SESSION: 'summarize-session',
    AI_TASK_DISPATCH: 'ai-task-dispatch',
    AI_TASK_RUN: 'ai-task',
} as const

export const AI_TASK_DISPATCH_QUEUE = QUEUE.AI_TASK_DISPATCH
export const AI_TASK_RUN_QUEUE = QUEUE.AI_TASK_RUN

export const JOB_FAMILY = {
    SESSION_SUMMARY: 'session-summary',
} as const

export function createVersionedJobDataSchema<
    TVersion extends number,
    TPayload extends z.ZodTypeAny,
>(version: TVersion, payloadSchema: TPayload) {
    return z.object({
        version: z.literal(version),
        idempotencyKey: z.string().min(1),
        payload: payloadSchema,
    })
}

// ---- summarize-turn (L1) ----

export const summarizeTurnPayloadSchema = z.object({
    sessionId: z.string().min(1),
    orgId: z.string().min(1),
    namespace: z.string().min(1),
    userSeq: z.number().int().positive(),
    scheduledAtMs: z.number().int().nonnegative(),
})

export type SummarizeTurnPayload = z.infer<typeof summarizeTurnPayloadSchema>

export const SUMMARIZE_TURN_JOB_VERSION = 1 as const

export const summarizeTurnJobDataSchema = createVersionedJobDataSchema(
    SUMMARIZE_TURN_JOB_VERSION,
    summarizeTurnPayloadSchema
)

export type SummarizeTurnJobData = z.infer<typeof summarizeTurnJobDataSchema>

// ---- summarize-segment (L2) ----

export const summarizeSegmentPayloadSchema = z.object({
    sessionId: z.string().min(1),
    orgId: z.string().min(1),
    namespace: z.string().min(1),
    scheduledAtMs: z.number().int().nonnegative(),
})

export type SummarizeSegmentPayload = z.infer<typeof summarizeSegmentPayloadSchema>

export const SUMMARIZE_SEGMENT_JOB_VERSION = 1 as const

export const summarizeSegmentJobDataSchema = createVersionedJobDataSchema(
    SUMMARIZE_SEGMENT_JOB_VERSION,
    summarizeSegmentPayloadSchema
)

export type SummarizeSegmentJobData = z.infer<typeof summarizeSegmentJobDataSchema>

// ---- summarize-session (L3) ----

export const summarizeSessionPayloadSchema = z.object({
    sessionId: z.string().min(1),
    orgId: z.string().min(1),
    namespace: z.string().min(1),
    scheduledAtMs: z.number().int().nonnegative(),
})

export type SummarizeSessionPayload = z.infer<typeof summarizeSessionPayloadSchema>

export const SUMMARIZE_SESSION_JOB_VERSION = 1 as const

export const summarizeSessionJobDataSchema = createVersionedJobDataSchema(
    SUMMARIZE_SESSION_JOB_VERSION,
    summarizeSessionPayloadSchema
)

export type SummarizeSessionJobData = z.infer<typeof summarizeSessionJobDataSchema>
