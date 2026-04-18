import { z } from 'zod'

export const QUEUE = {
    SUMMARIZE_TURN: 'summarize-turn',
} as const

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

export const summarizeTurnPayloadSchema = z.object({
    sessionId: z.string().min(1),
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
