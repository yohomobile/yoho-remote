import { z } from 'zod'

export const BRAIN_CLAUDE_CHILD_MODELS = ['sonnet', 'opus', 'opus-4-7'] as const
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

function normalizeCodexModelValue(value: string): string {
    return value.replace(/^openai\//, '').trim()
}

function normalizeAllowedList<T extends string>(
    values: readonly string[] | null | undefined,
    allowedValues: readonly T[],
): T[] {
    if (!values || values.length === 0) {
        return [...allowedValues]
    }
    const allowed = new Set(allowedValues)
    const normalized = values
        .map((value) => value.trim())
        .filter((value): value is T => allowed.has(value as T))
    return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function resolveDefaultModel<T extends string>(
    allowed: readonly T[],
    preferred: T,
    fallbackPool: readonly T[],
): T {
    if (allowed.includes(preferred)) {
        return preferred
    }
    for (const candidate of fallbackPool) {
        if (allowed.includes(candidate)) {
            return candidate
        }
    }
    return allowed[0] ?? preferred
}

export function parseBrainSessionPreferences(value: unknown): BrainSessionPreferences | null {
    const parsed = BrainSessionPreferencesSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return parsed.data
}

export function buildBrainSessionPreferences(input: {
    machineSelectionMode: 'auto' | 'manual'
    machineId: string
    childClaudeModels?: readonly string[] | null
    childCodexModels?: readonly string[] | null
}): BrainSessionPreferences {
    const allowedClaude = normalizeAllowedList(input.childClaudeModels, BRAIN_CLAUDE_CHILD_MODELS)
    const allowedCodex = normalizeAllowedList(
        input.childCodexModels?.map(normalizeCodexModelValue),
        BRAIN_CODEX_CHILD_MODELS,
    )

    return {
        machineSelection: {
            mode: input.machineSelectionMode,
            machineId: input.machineId,
        },
        childModels: {
            claude: {
                allowed: allowedClaude,
                defaultModel: resolveDefaultModel(allowedClaude, 'sonnet', BRAIN_CLAUDE_CHILD_MODELS),
            },
            codex: {
                allowed: allowedCodex,
                defaultModel: resolveDefaultModel(allowedCodex, 'gpt-5.4', BRAIN_CODEX_CHILD_MODELS),
            },
        },
    }
}

export function extractBrainSessionPreferencesFromMetadata(
    metadata: Record<string, unknown> | null | undefined
): BrainSessionPreferences | null {
    if (!metadata) {
        return null
    }
    return parseBrainSessionPreferences(metadata['brainPreferences'])
}

export function extractBrainChildModelDefaults(
    extra: Record<string, unknown> | null | undefined
): {
    childClaudeModels?: BrainClaudeChildModel[]
    childCodexModels?: BrainCodexChildModel[]
} {
    if (!extra) {
        return {}
    }

    const childClaudeModels = normalizeAllowedList(
        Array.isArray(extra['childClaudeModels']) ? extra['childClaudeModels'].filter((value): value is string => typeof value === 'string') : null,
        BRAIN_CLAUDE_CHILD_MODELS,
    )
    const childCodexModels = normalizeAllowedList(
        Array.isArray(extra['childCodexModels'])
            ? extra['childCodexModels']
                .filter((value): value is string => typeof value === 'string')
                .map(normalizeCodexModelValue)
            : null,
        BRAIN_CODEX_CHILD_MODELS,
    )

    return {
        childClaudeModels,
        childCodexModels,
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
