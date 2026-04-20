import type { SpawnAgentType } from '../store/types'
import type { BrainClaudeChildModel } from './brainSessionPreferences'

export type BrainChildRuntimeAvailability = Record<SpawnAgentType, boolean>

function hasConfiguredTokenSourceId(value: string | undefined): boolean {
    return typeof value === 'string' && value.trim().length > 0
}

export function machineSupportsBrainChildAgent(
    supportedAgents: SpawnAgentType[] | null | undefined,
    agent: SpawnAgentType,
): boolean {
    if (!supportedAgents || supportedAgents.length === 0) {
        return true
    }
    return supportedAgents.includes(agent)
}

export function resolveBrainChildRuntimeAvailability(args: {
    machineSupportedAgents: SpawnAgentType[] | null | undefined
    localTokenSourceEnabled: boolean
    tokenSourceIds?: Partial<Record<SpawnAgentType, string | undefined>>
}): BrainChildRuntimeAvailability {
    const hasLocal = args.localTokenSourceEnabled
    const tokenSourceIds = args.tokenSourceIds ?? {}

    const isAvailable = (agent: SpawnAgentType): boolean => {
        if (!machineSupportsBrainChildAgent(args.machineSupportedAgents, agent)) {
            return false
        }
        return hasLocal || hasConfiguredTokenSourceId(tokenSourceIds[agent])
    }

    return {
        claude: isAvailable('claude'),
        codex: isAvailable('codex'),
    }
}

export function filterBrainChildModelsByRuntimeAvailability(args: {
    availability: BrainChildRuntimeAvailability
    childClaudeModels: readonly BrainClaudeChildModel[]
    childCodexModels: readonly string[]
}): {
    childClaudeModels: BrainClaudeChildModel[]
    childCodexModels: string[]
} {
    return {
        childClaudeModels: args.availability.claude ? [...args.childClaudeModels] : [],
        childCodexModels: args.availability.codex ? [...args.childCodexModels] : [],
    }
}
