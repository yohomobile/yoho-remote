import type { ModelMode } from '@/types/api'

/**
 * Context window budget calculation for Claude sessions.
 *
 * The Claude Code CLI determines the context window dynamically:
 *   - Explicit [1m] suffix in model name → 1M tokens
 *   - Some models/plans get 1M via A/B experiment (coral_reef_sonnet) — we can't detect this externally
 *   - Default context window for Claude models is 200K tokens
 *
 * Auto-calibration heuristic:
 *   - If contextSize > 200K, the model MUST be using ≥ 1M context (200K model can never exceed 200K)
 *   - If model name contains [1m], it's always 1M
 *   - Otherwise: 200K (correct for 200K models; slightly over-reports for undetected 1M sessions,
 *     but under-reporting is more dangerous than over-reporting)
 */
export function getContextBudgetTokens(
    modelMode: ModelMode | undefined,
    runtimeModel?: string | null,
    contextSize?: number
): number | null {
    // Explicit [1m] suffix → always 1M context
    if (runtimeModel && /\[1m\]/i.test(runtimeModel)) {
        return 1_000_000
    }

    // If contextSize > 200K, model must be running with ≥ 1M context window
    if (contextSize !== undefined && contextSize > 200_000) {
        return 1_000_000
    }

    // Default: 200K (Claude Code CLI default for models without explicit 1M opt-in)
    // Over-reports percentage for undetected 1M sessions, but that's safer than
    // under-reporting (which hides context pressure from users)
    return 200_000
}
