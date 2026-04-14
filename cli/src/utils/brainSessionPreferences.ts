import { z } from 'zod'

import type { Metadata } from '@/api/types'

export const BRAIN_CLAUDE_CHILD_MODELS = ['sonnet', 'opus'] as const
export const BRAIN_CODEX_CHILD_MODELS = [
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
] as const

export type BrainClaudeChildModel = typeof BRAIN_CLAUDE_CHILD_MODELS[number]
export type BrainCodexChildModel = typeof BRAIN_CODEX_CHILD_MODELS[number]
export type BrainChildAgent = 'claude' | 'codex'

export type BrainSessionPreferences = {
    machineSelection: {
        mode: 'auto' | 'manual'
        machineId: string
    }
    childModels: {
        claude: {
            allowed: BrainClaudeChildModel[]
            defaultModel: BrainClaudeChildModel
        }
        codex: {
            allowed: BrainCodexChildModel[]
            defaultModel: BrainCodexChildModel
        }
    }
}

const BrainSessionPreferencesSchema: z.ZodType<BrainSessionPreferences> = z.object({
    machineSelection: z.object({
        mode: z.enum(['auto', 'manual']),
        machineId: z.string().min(1),
    }),
    childModels: z.object({
        claude: z.object({
            allowed: z.array(z.enum(BRAIN_CLAUDE_CHILD_MODELS)),
            defaultModel: z.enum(BRAIN_CLAUDE_CHILD_MODELS),
        }),
        codex: z.object({
            allowed: z.array(z.enum(BRAIN_CODEX_CHILD_MODELS)),
            defaultModel: z.enum(BRAIN_CODEX_CHILD_MODELS),
        }),
    }),
})

export function parseBrainSessionPreferences(value: unknown): BrainSessionPreferences | null {
    const parsed = BrainSessionPreferencesSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return parsed.data
}

export function getBrainSessionPreferencesFromMetadata(metadata: Metadata | null | undefined): BrainSessionPreferences | null {
    if (!metadata || typeof metadata !== 'object') {
        return null
    }
    return parseBrainSessionPreferences((metadata as Record<string, unknown>)['brainPreferences'])
}

export function getBrainSessionPreferencesFromEnv(): BrainSessionPreferences | null {
    const raw = process.env['YR_BRAIN_SESSION_PREFERENCES']
    if (!raw) {
        return null
    }
    try {
        return parseBrainSessionPreferences(JSON.parse(raw))
    } catch {
        return null
    }
}

export function getAllowedBrainChildAgents(preferences: BrainSessionPreferences | null): BrainChildAgent[] {
    if (!preferences) {
        return ['claude', 'codex']
    }

    const result: BrainChildAgent[] = []
    if (preferences.childModels.claude.allowed.length > 0) {
        result.push('claude')
    }
    if (preferences.childModels.codex.allowed.length > 0) {
        result.push('codex')
    }
    return result
}
