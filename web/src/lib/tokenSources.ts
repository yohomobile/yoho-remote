import type { TokenSource } from '@/types/api'

export const LOCAL_TOKEN_SOURCE_ID = '__local__'

export const LOCAL_TOKEN_SOURCE: TokenSource = {
    id: LOCAL_TOKEN_SOURCE_ID,
    name: 'Local',
    baseUrl: 'Use the machine-local Claude/Codex login and config',
    supportedAgents: ['claude', 'codex'],
    createdAt: 0,
    updatedAt: 0,
    hasApiKey: false,
    apiKeyMasked: null,
}
