import type { IStore, StoredAIProfile } from '../store'
import { evaluateRecallConsumption } from '../agent/memoryResultGate'

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

type ResolveBrainSelfSystemContextOptions = {
    store: IStore
    namespace: string
    yohoMemoryUrl?: string
    fetchImpl?: typeof fetch
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

function trimMemorySnippet(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length <= 1200) {
        return trimmed
    }
    return `${trimmed.slice(0, 1200).trimEnd()}\n...`
}

function buildSelfSystemPrompt(profile: StoredAIProfile, memorySnippet: string | null): string {
    const lines = [
        '## K1 自我系统',
        '以下内容是当前 Brain 绑定的稳定自我设定与长期自我记忆。保持一致性，但若与用户本轮明确指令冲突，以用户指令为准。',
        `- 名称：${profile.name}`,
        `- 角色：${profile.role}`,
    ]

    if (profile.specialties.length > 0) {
        lines.push(`- 专长：${profile.specialties.join('、')}`)
    }
    if (profile.personality) {
        lines.push(`- 个性：${profile.personality}`)
    }
    if (profile.workStyle) {
        lines.push(`- 工作方式：${profile.workStyle}`)
    }
    if (profile.greetingTemplate) {
        lines.push(`- 常用开场：${profile.greetingTemplate}`)
    }
    if (profile.preferredProjects.length > 0) {
        lines.push(`- 偏好项目：${profile.preferredProjects.join('、')}`)
    }

    if (memorySnippet) {
        lines.push('')
        lines.push('### 长期自我记忆（yoho-memory）')
        lines.push(memorySnippet)
    }

    return lines.join('\n')
}

type RecallSelfMemoryResult = {
    snippet: string | null
    status: Extract<SelfSystemMemoryStatus, 'attached' | 'empty' | 'error'>
}

async function recallSelfMemory(
    profile: StoredAIProfile,
    namespace: string,
    yohoMemoryUrl: string,
    fetchImpl: typeof fetch,
): Promise<RecallSelfMemoryResult> {
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3_000)
        const response = await fetchImpl(`${yohoMemoryUrl}/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: `K1 Brain 自我记忆 ${profile.name} ${profile.role} namespace:${namespace}`,
                keywords: [
                    profile.name,
                    profile.role,
                    namespace,
                    'K1 Brain',
                    '自我记忆',
                ],
                maxFiles: 1,
            }),
            signal: controller.signal,
        }).finally(() => clearTimeout(timeout))

        if (!response.ok) {
            return { snippet: null, status: 'error' }
        }

        const payload = await response.json() as { answer?: string; filesSearched?: number; confidence?: number }
        const gate = evaluateRecallConsumption(payload, {
            matchTerms: [profile.name, namespace],
            requireResultCount: true,
        })
        if (!gate.reliable || typeof payload.answer !== 'string' || payload.answer.trim().length === 0) {
            return { snippet: null, status: 'empty' }
        }

        return {
            snippet: trimMemorySnippet(payload.answer),
            status: 'attached',
        }
    } catch {
        return { snippet: null, status: 'error' }
    }
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

export async function resolveBrainSelfSystemContext(
    options: ResolveBrainSelfSystemContextOptions,
): Promise<BrainSelfSystemContext> {
    const fetchImpl = options.fetchImpl ?? fetch
    const yohoMemoryUrl = options.yohoMemoryUrl ?? DEFAULT_YOHO_MEMORY_URL
    if (typeof options.store.getBrainConfig !== 'function' || typeof options.store.getAIProfile !== 'function') {
        return {
            config: DEFAULT_SELF_SYSTEM_CONFIG,
            prompt: null,
            metadataPatch: {
                selfSystemEnabled: false,
                selfProfileId: null,
                selfProfileName: null,
                selfProfileResolved: false,
                selfMemoryProvider: 'yoho-memory',
                selfMemoryAttached: false,
                selfMemoryStatus: 'disabled',
            },
        }
    }
    const brainConfig = await options.store.getBrainConfig(options.namespace)
    const config = extractSelfSystemConfig(brainConfig?.extra)
    const baseMemoryStatus: SelfSystemMemoryStatus = !config.enabled || config.memoryProvider === 'none'
        ? 'disabled'
        : 'skipped'

    const emptyContext: BrainSelfSystemContext = {
        config,
        prompt: null,
        metadataPatch: {
            selfSystemEnabled: config.enabled,
            selfProfileId: config.defaultProfileId,
            selfProfileName: null,
            selfProfileResolved: false,
            selfMemoryProvider: config.memoryProvider,
            selfMemoryAttached: false,
            selfMemoryStatus: baseMemoryStatus,
        },
    }

    if (!config.enabled || !config.defaultProfileId) {
        return emptyContext
    }

    const profile = await options.store.getAIProfile(config.defaultProfileId)
    if (!profile || profile.namespace !== options.namespace) {
        return emptyContext
    }

    const memoryResult = config.memoryProvider === 'yoho-memory'
        ? await recallSelfMemory(profile, options.namespace, yohoMemoryUrl, fetchImpl)
        : { snippet: null, status: 'disabled' as const }

    return {
        config,
        prompt: buildSelfSystemPrompt(profile, memoryResult.snippet),
        metadataPatch: {
            selfSystemEnabled: true,
            selfProfileId: profile.id,
            selfProfileName: profile.name,
            selfProfileResolved: true,
            selfMemoryProvider: config.memoryProvider,
            selfMemoryAttached: memoryResult.status === 'attached',
            selfMemoryStatus: memoryResult.status,
        },
    }
}

export function appendSelfSystemPrompt(basePrompt: string, selfPrompt: string | null | undefined): string {
    if (!selfPrompt?.trim()) {
        return basePrompt
    }
    return `${basePrompt.trim()}\n\n${selfPrompt.trim()}`
}
