import type { TokenSource, TokenSourceAgent } from '@/types/api'

export const LOCAL_TOKEN_SOURCE_ID = '__local__'

export const LOCAL_TOKEN_SOURCE: TokenSource = {
    id: LOCAL_TOKEN_SOURCE_ID,
    name: 'Local',
    baseUrl: 'Use the machine-local login/config. Actual agent availability depends on the selected machine.',
    supportedAgents: ['claude', 'codex'],
    createdAt: 0,
    updatedAt: 0,
    hasApiKey: false,
    apiKeyMasked: null,
}

export function machineSupportsTokenSourceAgent(
    supportedAgents: readonly string[] | null | undefined,
    agent: TokenSourceAgent,
): boolean {
    if (!supportedAgents || supportedAgents.length === 0) {
        return true
    }
    return supportedAgents.includes(agent)
}

export function tokenSourceSupportsAgent(
    tokenSource: TokenSource,
    agent: TokenSourceAgent,
    options?: {
        machineSupportedAgents?: readonly string[] | null
    }
): boolean {
    if (tokenSource.id === LOCAL_TOKEN_SOURCE_ID) {
        return machineSupportsTokenSourceAgent(options?.machineSupportedAgents, agent)
    }
    return tokenSource.supportedAgents.includes(agent)
}

export function getCompatibleTokenSources(
    tokenSources: TokenSource[],
    agent: TokenSourceAgent,
    options?: {
        machineSupportedAgents?: readonly string[] | null
    }
): TokenSource[] {
    return tokenSources.filter((tokenSource) =>
        tokenSourceSupportsAgent(tokenSource, agent, options)
    )
}
