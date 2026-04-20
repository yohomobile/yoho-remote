import type { TokenSource, TokenSourceAgent } from '@/types/api'
import {
    CODEX_MODELS,
    normalizeCodexModelValue,
    type ClaudeModelMode,
} from '@/components/SessionAgentFields'
import { LOCAL_TOKEN_SOURCE_ID } from '@/lib/tokenSources'
import { machineSupportsTokenSourceAgent } from '@/lib/tokenSources'

const CLAUDE_CHILD_MODEL_VALUES: ClaudeModelMode[] = ['sonnet', 'opus', 'opus-4-7']
const CODEX_CHILD_MODEL_VALUES = CODEX_MODELS.map((model) => normalizeCodexModelValue(model.value))

export function pickDefaultTokenSourceId(compatibleSources: TokenSource[]): string {
    if (compatibleSources.length === 0) return ''
    if (compatibleSources.length === 1) return compatibleSources[0].id
    const nonLocal = compatibleSources.filter((src) => src.id !== LOCAL_TOKEN_SOURCE_ID)
    if (nonLocal.length === 0) return compatibleSources[0].id
    const sorted = [...nonLocal].sort((a, b) => b.createdAt - a.createdAt)
    return sorted[0].id
}

export function normalizeChildClaudeModels(
    extra: Record<string, unknown> | null | undefined
): ClaudeModelMode[] {
    const values = Array.isArray(extra?.['childClaudeModels']) ? extra['childClaudeModels'] : null
    if (!values) {
        return [...CLAUDE_CHILD_MODEL_VALUES]
    }
    return Array.from(new Set(
        values.filter((value): value is ClaudeModelMode =>
            value === 'sonnet' || value === 'opus' || value === 'opus-4-7'
        )
    ))
}

export function normalizeChildCodexModels(
    extra: Record<string, unknown> | null | undefined
): string[] {
    const values = Array.isArray(extra?.['childCodexModels']) ? extra['childCodexModels'] : null
    if (!values) {
        return [...CODEX_CHILD_MODEL_VALUES]
    }

    const allowed = new Set(CODEX_CHILD_MODEL_VALUES)
    return Array.from(new Set(
        values
            .filter((value): value is string => typeof value === 'string')
            .map((value) => normalizeCodexModelValue(value))
            .filter((value) => allowed.has(value))
    ))
}

export type BrainChildRuntimeAvailability = Record<TokenSourceAgent, boolean>

function hasConfiguredTokenSourceId(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0
}

export function resolveBrainChildRuntimeAvailability(args: {
    machineSupportedAgents: readonly string[] | null | undefined
    localTokenSourceEnabled: boolean
    tokenSourceIds?: Partial<Record<TokenSourceAgent, string | undefined>>
}): BrainChildRuntimeAvailability {
    const tokenSourceIds = args.tokenSourceIds ?? {}

    const isAvailable = (agent: TokenSourceAgent): boolean => {
        if (!machineSupportsTokenSourceAgent(args.machineSupportedAgents, agent)) {
            return false
        }
        return args.localTokenSourceEnabled || hasConfiguredTokenSourceId(tokenSourceIds[agent])
    }

    return {
        claude: isAvailable('claude'),
        codex: isAvailable('codex'),
    }
}

export function filterBrainChildModelsByRuntimeAvailability(args: {
    availability: BrainChildRuntimeAvailability
    childClaudeModels: readonly ClaudeModelMode[]
    childCodexModels: readonly string[]
}): {
    childClaudeModels: ClaudeModelMode[]
    childCodexModels: string[]
} {
    return {
        childClaudeModels: args.availability.claude ? [...args.childClaudeModels] : [],
        childCodexModels: args.availability.codex ? [...args.childCodexModels] : [],
    }
}

export {
    CLAUDE_CHILD_MODEL_VALUES,
    CODEX_CHILD_MODEL_VALUES,
}
