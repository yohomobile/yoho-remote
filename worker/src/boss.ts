import { z } from 'zod'

export const QUEUE = {
    SUMMARIZE_TURN: 'summarize-turn',
} as const

export const summarizeTurnPayloadSchema = z.object({
    sessionId: z.string().min(1),
    namespace: z.string().min(1),
    userSeq: z.number().int().positive(),
    scheduledAtMs: z.number().int().nonnegative(),
})

export type SummarizeTurnPayload = z.infer<typeof summarizeTurnPayloadSchema>
