import type { IStore, StoredAIProfile } from '../store'
import { evaluateRecallConsumption } from '../agent/memoryResultGate'
import { isSessionOrchestrationChildSource } from '../sessionOrchestrationPolicy'

export type SelfSystemMemoryProvider = 'yoho-memory' | 'none'
export type SelfSystemMemoryStatus = 'disabled' | 'skipped' | 'attached' | 'empty' | 'error'

export type SelfSystemConfig = {
    enabled: boolean
    defaultProfileId: string | null
    memoryProvider: SelfSystemMemoryProvider
}

export type BrainSelfSystemContext = {
    config: SelfSystemConfig
    prompt: string | null
    metadataPatch: {
        selfSystemEnabled: boolean
        selfProfileId: string | null
        selfProfileName: string | null
        selfProfileResolved: boolean
        selfMemoryProvider: SelfSystemMemoryProvider
        selfMemoryAttached: boolean
        selfMemoryStatus: SelfSystemMemoryStatus
    }
}

type ResolveSessionSelfSystemContextOptions = {
    store: IStore
    orgId?: string | null
    userEmail?: string | null
    /**
     * Session 的 metadata.source。用于决定是否注入 K1 自我系统：
     * - orchestration child（brain-child / orchestrator-child）→ 整段不注入
     * - 'brain' 父 session → 头部 + 长期记忆都注入
     * - 其他（webapp / null / orchestrator / cli / 自定义）→ 仅注入头部，不拉长期记忆
     */
    source?: string | null
    /**
     * 显式覆盖 includeMemory 决策。未传时按 source 推导（仅 source === 'brain' 时为 true）。
     */
    includeMemory?: boolean
    yohoMemoryUrl?: string
    fetchImpl?: typeof fetch
}

type RecallSelfMemoryResult = {
    snippet: string | null
    status: Extract<SelfSystemMemoryStatus, 'attached' | 'empty' | 'error'>
}

const DEFAULT_YOHO_MEMORY_URL = process.env.YOHO_MEMORY_URL || 'http://localhost:3100/api'
const DEFAULT_SELF_SYSTEM_CONFIG: SelfSystemConfig = {
    enabled: false,
    defaultProfileId: null,
    memoryProvider: 'yoho-memory',
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function normalizeMemoryProvider(value: unknown): SelfSystemMemoryProvider {
    return value === 'none' ? 'none' : 'yoho-memory'
}

function cleanOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : null
}

const MEMORY_SNIPPET_MAX_CHARS = 2500

function trimMemorySnippet(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length <= MEMORY_SNIPPET_MAX_CHARS) {
        return trimmed
    }
    return `${trimmed.slice(0, MEMORY_SNIPPET_MAX_CHARS).trimEnd()}\n...`
}

function buildSelfSystemPrompt(profile: StoredAIProfile, memorySnippet: string | null): string {
    const lines = [
        '## K1 自我系统',
        '以下内容是当前会话绑定的稳定 AI 风格设定。保持一致性，但若与用户本轮明确指令冲突，以用户指令为准。',
        `- 名称：${profile.name}`,
        `- 风格：${profile.role}`,
    ]

    if (profile.personality) {
        lines.push(`- 个性：${profile.personality}`)
    }
    if (profile.workStyle) {
        lines.push(`- 工作方式：${profile.workStyle}`)
    }
    if (profile.behaviorAnchors.length > 0) {
        lines.push('- 行为准则：')
        for (const anchor of profile.behaviorAnchors) {
            lines.push(`  · ${anchor}`)
        }
    }
    if (profile.specialties.length > 0) {
        lines.push(`- 常见切入点：${profile.specialties.join('、')}`)
    }
    if (profile.preferredProjects.length > 0) {
        lines.push(`- 偏好场景：${profile.preferredProjects.join('、')}`)
    }

    lines.push('- 职责说明：上述风格只影响思考与表达方式；不拒做任何类型的工作（开发、评审、测试、部署、排障、规划等一视同仁）。')

    if (memorySnippet) {
        lines.push('')
        lines.push('### 长期自我记忆（yoho-memory）')
        lines.push(memorySnippet)
    }

    return lines.join('\n')
}

function buildYohoMemoryRequestHeaders(): Record<string, string> {
    const token = process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN?.trim()
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
}

function unwrapYohoMemoryResult(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) return null
    return isRecord(value.result) ? value.result : value
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown> | null> {
    try {
        return unwrapYohoMemoryResult(await response.json())
    } catch {
        return null
    }
}

async function fetchSelfProfileMemory(
    yohoMemoryUrl: string,
    fetchImpl: typeof fetch,
): Promise<RecallSelfMemoryResult | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
        const response = await fetchImpl(`${yohoMemoryUrl}/self_profile_get`, {
            method: 'POST',
            headers: buildYohoMemoryRequestHeaders(),
            body: JSON.stringify({
                agentId: 'K1',
                profileMode: 'brain-init',
            }),
            signal: controller.signal,
        })

        if (response.status === 404) {
            return null
        }
        if (!response.ok) {
            return { snippet: null, status: 'error' }
        }

        const payload = await readJsonResponse(response)
        const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
        const sources = Array.isArray(payload?.sources) ? payload.sources : []
        if (!content || sources.length === 0) {
            return { snippet: null, status: 'empty' }
        }

        return {
            snippet: trimMemorySnippet(content),
            status: 'attached',
        }
    } catch {
        return { snippet: null, status: 'error' }
    } finally {
        clearTimeout(timeout)
    }
}

async function recallSelfMemory(
    profile: StoredAIProfile,
    scopeKey: string,
    yohoMemoryUrl: string,
    fetchImpl: typeof fetch,
): Promise<RecallSelfMemoryResult> {
    const selfProfileResult = await fetchSelfProfileMemory(yohoMemoryUrl, fetchImpl)
    if (selfProfileResult) {
        return selfProfileResult
    }

    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3_000)
        const response = await fetchImpl(`${yohoMemoryUrl}/recall`, {
            method: 'POST',
            headers: buildYohoMemoryRequestHeaders(),
            body: JSON.stringify({
                input: `K1 会话自我记忆 ${profile.name} 风格:${profile.role} scope:${scopeKey}`,
                keywords: [
                    profile.name,
                    profile.role,
                    scopeKey,
                    'K1',
                    '自我记忆',
                ],
                maxFiles: 1,
            }),
            signal: controller.signal,
        }).finally(() => clearTimeout(timeout))

        if (!response.ok) {
            return { snippet: null, status: 'error' }
        }

        const result = await readJsonResponse(response) as { answer?: string; filesSearched?: number; confidence?: number } | null
        if (!result) {
            return { snippet: null, status: 'empty' }
        }
        const gate = evaluateRecallConsumption(result, {
            matchTerms: [profile.name, scopeKey],
            requireResultCount: true,
        })
        if (!gate.reliable || typeof result.answer !== 'string' || result.answer.trim().length === 0) {
            return { snippet: null, status: 'empty' }
        }

        return {
            snippet: trimMemorySnippet(result.answer),
            status: 'attached',
        }
    } catch {
        return { snippet: null, status: 'error' }
    }
}

function toSelfSystemConfig(value: {
    enabled: boolean
    defaultProfileId: string | null
    memoryProvider: SelfSystemMemoryProvider | string
} | null | undefined): SelfSystemConfig {
    if (!value) {
        return DEFAULT_SELF_SYSTEM_CONFIG
    }
    return {
        enabled: value.enabled === true,
        defaultProfileId: cleanOptionalString(value.defaultProfileId),
        memoryProvider: normalizeMemoryProvider(value.memoryProvider),
    }
}

function buildContextWithConfig(config: SelfSystemConfig, memoryStatus?: SelfSystemMemoryStatus): BrainSelfSystemContext {
    const resolvedMemoryStatus = memoryStatus ?? (!config.enabled || config.memoryProvider === 'none' ? 'disabled' : 'skipped')
    return {
        config,
        prompt: null,
        metadataPatch: {
            selfSystemEnabled: config.enabled,
            selfProfileId: config.defaultProfileId,
            selfProfileName: null,
            selfProfileResolved: false,
            selfMemoryProvider: config.memoryProvider,
            selfMemoryAttached: false,
            selfMemoryStatus: resolvedMemoryStatus,
        },
    }
}

export function matchesProfileScope(
    profile: StoredAIProfile,
    orgId: string | null,
): boolean {
    if (!orgId) {
        console.warn(
            `[selfSystem] rejecting profile ${profile.id}: session orgId is null; profile scope requires a concrete orgId`
        )
        return false
    }
    return profile.orgId === orgId
}

export function extractSelfSystemConfig(extra: unknown): SelfSystemConfig {
    if (!isRecord(extra) || !isRecord(extra.selfSystem)) {
        return DEFAULT_SELF_SYSTEM_CONFIG
    }

    const selfSystem = extra.selfSystem
    return {
        enabled: selfSystem.enabled === true,
        defaultProfileId: cleanOptionalString(selfSystem.defaultProfileId),
        memoryProvider: normalizeMemoryProvider(selfSystem.memoryProvider),
    }
}

async function resolveEffectiveSelfSystemConfig(
    options: ResolveSessionSelfSystemContextOptions,
): Promise<SelfSystemConfig> {
    const orgId = cleanOptionalString(options.orgId)
    const userEmail = cleanOptionalString(options.userEmail)
    const storeWithUserConfig = options.store as IStore & {
        getUserSelfSystemConfig?: IStore['getUserSelfSystemConfig']
    }
    const storeWithOrgConfig = options.store as IStore & {
        getBrainConfigByOrg?: IStore['getBrainConfigByOrg']
    }

    if (orgId && userEmail && typeof storeWithUserConfig.getUserSelfSystemConfig === 'function') {
        const userConfig = await storeWithUserConfig.getUserSelfSystemConfig(orgId, userEmail)
        if (userConfig) {
            return toSelfSystemConfig(userConfig)
        }
    }

    if (orgId && typeof storeWithOrgConfig.getBrainConfigByOrg === 'function') {
        const orgConfig = await storeWithOrgConfig.getBrainConfigByOrg(orgId)
        return orgConfig ? extractSelfSystemConfig(orgConfig.extra) : DEFAULT_SELF_SYSTEM_CONFIG
    }

    // 当 session 没有 orgId 时，fallback 到平台默认 org 的配置
    const fallbackOrgId = cleanOptionalString(process.env.YR_DEFAULT_SELF_ORG_ID)
    if (fallbackOrgId && typeof storeWithOrgConfig.getBrainConfigByOrg === 'function') {
        const orgConfig = await storeWithOrgConfig.getBrainConfigByOrg(fallbackOrgId)
        return orgConfig ? extractSelfSystemConfig(orgConfig.extra) : DEFAULT_SELF_SYSTEM_CONFIG
    }

    return DEFAULT_SELF_SYSTEM_CONFIG
}

export async function resolveSessionSelfSystemContext(
    options: ResolveSessionSelfSystemContextOptions,
): Promise<BrainSelfSystemContext> {
    const fetchImpl = options.fetchImpl ?? fetch
    const yohoMemoryUrl = options.yohoMemoryUrl ?? DEFAULT_YOHO_MEMORY_URL
    const storeWithProfile = options.store as IStore & { getAIProfile?: IStore['getAIProfile'] }

    if (typeof storeWithProfile.getAIProfile !== 'function') {
        return buildContextWithConfig(DEFAULT_SELF_SYSTEM_CONFIG, 'disabled')
    }

    const config = await resolveEffectiveSelfSystemConfig(options)
    const emptyContext = buildContextWithConfig(config)

    const source = cleanOptionalString(options.source)
    if (source && isSessionOrchestrationChildSource(source)) {
        // orchestration child（brain-child / orchestrator-child）由父 session 编排，
        // 不注入 K1 自我系统，避免与父 session 的人格设定冲突。
        return emptyContext
    }

    if (!config.enabled || !config.defaultProfileId) {
        return emptyContext
    }

    const orgId = cleanOptionalString(options.orgId)
    const profile = await storeWithProfile.getAIProfile(config.defaultProfileId)
    if (!profile || !matchesProfileScope(profile, orgId)) {
        return emptyContext
    }

    // 长期记忆段（### 长期自我记忆）只在 brain 父 session 注入；caller 可显式 override。
    const includeMemory = options.includeMemory !== undefined
        ? options.includeMemory !== false
        : source === 'brain'
    const scopeKey = orgId ? `org:${orgId}` : 'global'
    let memorySnippet: string | null = null
    let memoryStatus: SelfSystemMemoryStatus = config.memoryProvider === 'none' ? 'disabled' : 'skipped'
    if (includeMemory && config.memoryProvider === 'yoho-memory') {
        const memoryResult = await recallSelfMemory(profile, scopeKey, yohoMemoryUrl, fetchImpl)
        memorySnippet = memoryResult.snippet
        memoryStatus = memoryResult.status
    }

    return {
        config,
        prompt: buildSelfSystemPrompt(profile, memorySnippet),
        metadataPatch: {
            selfSystemEnabled: true,
            selfProfileId: profile.id,
            selfProfileName: profile.name,
            selfProfileResolved: true,
            selfMemoryProvider: config.memoryProvider,
            selfMemoryAttached: memoryStatus === 'attached',
            selfMemoryStatus: memoryStatus,
        },
    }
}

export function appendSelfSystemPrompt(basePrompt: string, selfPrompt: string | null | undefined): string {
    if (!selfPrompt?.trim()) {
        return basePrompt
    }
    return `${basePrompt.trim()}\n\n${selfPrompt.trim()}`
}
