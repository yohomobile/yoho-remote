import type { ModelMode } from '@/types/api'

/**
 * Context windows vary by model/provider and may change over time.
 *
 * The UI displays context usage percentage based on the full context window size.
 * This matches Claude Code CLI's calculation (src/utils/context.ts:calculateContextPercentages).
 *
 * Note: We use the full context window (1M tokens) for percentage calculation,
 * not the autoCompact threshold. This gives users a clear view of actual context usage.
 */
const MODEL_CONTEXT_WINDOWS: Partial<Record<ModelMode, number>> = {
    // Claude Code 1M context window (Opus 4.6 / Sonnet 4.5+)
    default: 1_000_000,
    sonnet: 1_000_000,
    opus: 1_000_000,
    'glm-5.1': 1_000_000
}

export function getContextBudgetTokens(modelMode: ModelMode | undefined): number | null {
    const mode: ModelMode = modelMode ?? 'default'
    const windowTokens = MODEL_CONTEXT_WINDOWS[mode]
    if (!windowTokens) return null
    // Return full context window size (matches Claude Code CLI behavior)
    return windowTokens
}
