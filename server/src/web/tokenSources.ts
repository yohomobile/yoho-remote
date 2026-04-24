import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { IStore, OrgRole } from '../store'

const tokenSourceAgentSchema = z.enum(['claude', 'codex'])

export const tokenSourceSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    baseUrl: z.string().min(1).max(1000),
    apiKey: z.string().min(1).max(10_000),
    supportedAgents: z.array(tokenSourceAgentSchema).min(1).max(2),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
})

export const tokenSourceInputSchema = z.object({
    name: z.string().min(1).max(100),
    baseUrl: z.string().min(1).max(1000),
    apiKey: z.string().min(1).max(10_000),
    supportedAgents: z.array(tokenSourceAgentSchema).min(1).max(2),
})

export const tokenSourceUpdateSchema = tokenSourceInputSchema.partial().refine((value) => {
    return value.name !== undefined
        || value.baseUrl !== undefined
        || value.apiKey !== undefined
        || value.supportedAgents !== undefined
}, {
    message: 'At least one field is required',
})

export type TokenSource = z.infer<typeof tokenSourceSchema>
export type TokenSourceInput = z.infer<typeof tokenSourceInputSchema>
export type TokenSourceUpdateInput = z.infer<typeof tokenSourceUpdateSchema>
export type TokenSourceAgent = z.infer<typeof tokenSourceAgentSchema>

const TOKEN_SOURCE_SETTINGS_KEY = 'tokenSources'
const LOCAL_TOKEN_SOURCE_ENABLED_KEY = 'localTokenSourceEnabled'

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '')
}

function normalizeSupportedAgents(agents: TokenSourceAgent[]): TokenSourceAgent[] {
    const unique = new Set(agents)
    return (['claude', 'codex'] as const).filter((agent): agent is TokenSourceAgent => unique.has(agent))
}

function normalizeTokenSource(input: TokenSourceInput, current?: TokenSource): TokenSource {
    const now = Date.now()
    return {
        id: current?.id ?? randomUUID(),
        name: input.name.trim(),
        baseUrl: normalizeBaseUrl(input.baseUrl),
        apiKey: input.apiKey.trim(),
        supportedAgents: normalizeSupportedAgents(input.supportedAgents),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
    }
}

function parseTokenSources(raw: unknown): TokenSource[] {
    if (!Array.isArray(raw)) {
        return []
    }

    const parsed: TokenSource[] = []
    for (const item of raw) {
        const result = tokenSourceSchema.safeParse(item)
        if (result.success) {
            parsed.push({
                ...result.data,
                baseUrl: normalizeBaseUrl(result.data.baseUrl),
                apiKey: result.data.apiKey.trim(),
                supportedAgents: normalizeSupportedAgents(result.data.supportedAgents),
            })
        }
    }
    return parsed
}

function maskApiKey(apiKey: string): string {
    if (apiKey.length <= 8) {
        return `${apiKey.slice(0, 2)}***`
    }
    return `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`
}

export function serializeTokenSource(tokenSource: TokenSource, includeSecrets: boolean): {
    id: string
    name: string
    baseUrl: string
    supportedAgents: TokenSourceAgent[]
    createdAt: number
    updatedAt: number
    hasApiKey: boolean
    apiKeyMasked?: string | null
    apiKey?: string
} {
    return {
        id: tokenSource.id,
        name: tokenSource.name,
        baseUrl: tokenSource.baseUrl,
        supportedAgents: tokenSource.supportedAgents,
        createdAt: tokenSource.createdAt,
        updatedAt: tokenSource.updatedAt,
        hasApiKey: tokenSource.apiKey.trim().length > 0,
        apiKeyMasked: includeSecrets ? undefined : maskApiKey(tokenSource.apiKey),
        ...(includeSecrets ? { apiKey: tokenSource.apiKey } : {}),
    }
}

export async function getOrgRole(store: IStore, orgId: string, email: string): Promise<OrgRole | null> {
    return await store.getUserOrgRole(orgId, email)
}

export async function getTokenSourcesForOrg(store: IStore, orgId: string): Promise<TokenSource[]> {
    const org = await store.getOrganization(orgId)
    if (!org) {
        return []
    }
    return parseTokenSources(org.settings?.[TOKEN_SOURCE_SETTINGS_KEY])
}

export async function pickDefaultTokenSourceForAgent(
    store: IStore,
    orgId: string,
    agent: TokenSourceAgent,
): Promise<TokenSource | null> {
    const tokenSources = await getTokenSourcesForOrg(store, orgId)
    const compatible = tokenSources
        .filter((tokenSource) => tokenSource.supportedAgents.includes(agent))
        .sort((a, b) => b.createdAt - a.createdAt)
    return compatible[0] ?? null
}

async function saveTokenSourcesForOrg(store: IStore, orgId: string, tokenSources: TokenSource[]): Promise<boolean> {
    const org = await store.getOrganization(orgId)
    if (!org) {
        return false
    }

    const settings = {
        ...org.settings,
        [TOKEN_SOURCE_SETTINGS_KEY]: tokenSources,
    }

    const updated = await store.updateOrganization(orgId, { settings })
    return Boolean(updated)
}

export async function createTokenSourceForOrg(store: IStore, orgId: string, input: TokenSourceInput): Promise<TokenSource | null> {
    const current = await getTokenSourcesForOrg(store, orgId)
    const tokenSource = normalizeTokenSource(input)
    current.push(tokenSource)

    const saved = await saveTokenSourcesForOrg(store, orgId, current)
    return saved ? tokenSource : null
}

export async function updateTokenSourceForOrg(store: IStore, orgId: string, id: string, input: TokenSourceUpdateInput): Promise<TokenSource | null> {
    const current = await getTokenSourcesForOrg(store, orgId)
    const existing = current.find((item) => item.id === id)
    if (!existing) {
        return null
    }

    const next = normalizeTokenSource({
        name: input.name ?? existing.name,
        baseUrl: input.baseUrl ?? existing.baseUrl,
        apiKey: input.apiKey ?? existing.apiKey,
        supportedAgents: input.supportedAgents ?? existing.supportedAgents,
    }, existing)

    const updatedList = current.map((item) => item.id === id ? next : item)
    const saved = await saveTokenSourcesForOrg(store, orgId, updatedList)
    return saved ? next : null
}

export async function deleteTokenSourceForOrg(store: IStore, orgId: string, id: string): Promise<boolean> {
    const current = await getTokenSourcesForOrg(store, orgId)
    const next = current.filter((item) => item.id !== id)
    if (next.length === current.length) {
        return false
    }
    return await saveTokenSourcesForOrg(store, orgId, next)
}

export async function getLocalTokenSourceEnabledForOrg(store: IStore, orgId: string): Promise<boolean> {
    const org = await store.getOrganization(orgId)
    if (!org) {
        return true
    }
    const raw = org.settings?.[LOCAL_TOKEN_SOURCE_ENABLED_KEY]
    if (typeof raw !== 'boolean') {
        return true
    }
    return raw
}

export async function setLocalTokenSourceEnabledForOrg(store: IStore, orgId: string, enabled: boolean): Promise<boolean> {
    const org = await store.getOrganization(orgId)
    if (!org) {
        return false
    }

    const settings = {
        ...org.settings,
        [LOCAL_TOKEN_SOURCE_ENABLED_KEY]: enabled,
    }

    const updated = await store.updateOrganization(orgId, { settings })
    return Boolean(updated)
}

export async function resolveTokenSourceForAgent(
    store: IStore,
    orgId: string,
    tokenSourceId: string,
    agent: string | null | undefined
): Promise<{ tokenSource: TokenSource } | { error: string; status: number }> {
    const normalizedAgent = agent === 'codex' ? 'codex' : agent === 'claude' ? 'claude' : null
    if (!normalizedAgent) {
        return { error: 'Token Source only supports Claude or Codex session creation', status: 400 }
    }

    const tokenSources = await getTokenSourcesForOrg(store, orgId)
    const tokenSource = tokenSources.find((item) => item.id === tokenSourceId)
    if (!tokenSource) {
        return { error: 'Token Source not found', status: 404 }
    }
    if (!tokenSource.supportedAgents.includes(normalizedAgent)) {
        return { error: `Token Source "${tokenSource.name}" does not support ${normalizedAgent}`, status: 400 }
    }
    return { tokenSource }
}
