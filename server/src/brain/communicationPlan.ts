import type { IStore, StoredCommunicationPlan } from '../store'
import type { CommunicationPlanPreferences } from '../store/types'

export type CommunicationPlanStatus =
    | 'disabled-no-person'
    | 'disabled-store-unsupported'
    | 'missing'
    | 'disabled'
    | 'empty'
    | 'attached'
    | 'error'

export type BrainCommunicationPlanContext = {
    plan: StoredCommunicationPlan | null
    prompt: string | null
    metadataPatch: {
        communicationPlanAttached: boolean
        communicationPlanStatus: CommunicationPlanStatus
        communicationPlanId: string | null
        communicationPlanVersion: number | null
        communicationPlanPersonId: string | null
    }
}

type ResolveCommunicationPlanOptions = {
    store: IStore
    orgId?: string | null
    personId?: string | null
}

const LENGTH_LABELS: Record<NonNullable<CommunicationPlanPreferences['length']>, string> = {
    concise: '简洁，少铺垫、不展开',
    default: '默认长度，按任务需要决定',
    detailed: '详细，给出完整背景与推导',
}

const DEPTH_LABELS: Record<NonNullable<CommunicationPlanPreferences['explanationDepth']>, string> = {
    minimal: '只给结论，不解释过程',
    moderate: '结论+简短理由',
    thorough: '充分解释，展示推理与取舍',
}

const FORMALITY_LABELS: Record<NonNullable<CommunicationPlanPreferences['formality']>, string> = {
    casual: '口语、随意',
    neutral: '中性、正常书面语',
    formal: '正式、严谨',
}

function hasAnyPreference(preferences: CommunicationPlanPreferences): boolean {
    return Boolean(
        preferences.tone?.trim() ||
            preferences.length ||
            preferences.explanationDepth ||
            preferences.formality ||
            preferences.customInstructions?.trim(),
    )
}

function buildCommunicationPlanPrompt(plan: StoredCommunicationPlan): string | null {
    const prefs = plan.preferences
    if (!hasAnyPreference(prefs)) {
        return null
    }

    const lines: string[] = [
        '## 用户表达偏好（Communication Plan）',
        '仅影响你的表达方式（语气、长度、解释深度、正式度），**不改变事实、权限、审批或工具调用决策**。若与用户本轮明确指令冲突，以本轮指令为准。',
    ]

    if (prefs.length) {
        lines.push(`- 回复长度：${LENGTH_LABELS[prefs.length]}`)
    }
    if (prefs.explanationDepth) {
        lines.push(`- 解释深度：${DEPTH_LABELS[prefs.explanationDepth]}`)
    }
    if (prefs.formality) {
        lines.push(`- 正式度：${FORMALITY_LABELS[prefs.formality]}`)
    }
    if (prefs.tone?.trim()) {
        lines.push(`- 语气：${prefs.tone.trim()}`)
    }
    if (prefs.customInstructions?.trim()) {
        lines.push('- 自定义指令：')
        for (const line of prefs.customInstructions.trim().split(/\n+/)) {
            const trimmed = line.trim()
            if (trimmed) lines.push(`  · ${trimmed}`)
        }
    }

    return lines.join('\n')
}

function buildEmptyContext(status: CommunicationPlanStatus): BrainCommunicationPlanContext {
    return {
        plan: null,
        prompt: null,
        metadataPatch: {
            communicationPlanAttached: false,
            communicationPlanStatus: status,
            communicationPlanId: null,
            communicationPlanVersion: null,
            communicationPlanPersonId: null,
        },
    }
}

function trimmed(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null
    const v = value.trim()
    return v.length > 0 ? v : null
}

export async function resolveSessionCommunicationPlanContext(
    options: ResolveCommunicationPlanOptions,
): Promise<BrainCommunicationPlanContext> {
    const personId = trimmed(options.personId)
    if (!personId) {
        return buildEmptyContext('disabled-no-person')
    }

    const storeWithPlan = options.store as IStore & {
        getCommunicationPlanByPerson?: IStore['getCommunicationPlanByPerson']
    }
    if (typeof storeWithPlan.getCommunicationPlanByPerson !== 'function') {
        return buildEmptyContext('disabled-store-unsupported')
    }

    const orgId = trimmed(options.orgId)
    const namespace = orgId ?? 'default'

    let plan: StoredCommunicationPlan | null = null
    try {
        plan = await storeWithPlan.getCommunicationPlanByPerson({
            namespace,
            orgId,
            personId,
        })
    } catch (err) {
        console.warn(`[communicationPlan] resolve failed for person=${personId}: ${err instanceof Error ? err.message : String(err)}`)
        return {
            ...buildEmptyContext('error'),
            metadataPatch: {
                communicationPlanAttached: false,
                communicationPlanStatus: 'error',
                communicationPlanId: null,
                communicationPlanVersion: null,
                communicationPlanPersonId: personId,
            },
        }
    }

    if (!plan) {
        return {
            ...buildEmptyContext('missing'),
            metadataPatch: {
                communicationPlanAttached: false,
                communicationPlanStatus: 'missing',
                communicationPlanId: null,
                communicationPlanVersion: null,
                communicationPlanPersonId: personId,
            },
        }
    }

    if (!plan.enabled) {
        return {
            plan,
            prompt: null,
            metadataPatch: {
                communicationPlanAttached: false,
                communicationPlanStatus: 'disabled',
                communicationPlanId: plan.id,
                communicationPlanVersion: plan.version,
                communicationPlanPersonId: personId,
            },
        }
    }

    const prompt = buildCommunicationPlanPrompt(plan)
    if (!prompt) {
        return {
            plan,
            prompt: null,
            metadataPatch: {
                communicationPlanAttached: false,
                communicationPlanStatus: 'empty',
                communicationPlanId: plan.id,
                communicationPlanVersion: plan.version,
                communicationPlanPersonId: personId,
            },
        }
    }

    return {
        plan,
        prompt,
        metadataPatch: {
            communicationPlanAttached: true,
            communicationPlanStatus: 'attached',
            communicationPlanId: plan.id,
            communicationPlanVersion: plan.version,
            communicationPlanPersonId: personId,
        },
    }
}

export function appendCommunicationPlanPrompt(
    basePrompt: string,
    planPrompt: string | null | undefined,
): string {
    if (!planPrompt?.trim()) {
        return basePrompt
    }
    return `${basePrompt.trim()}\n\n${planPrompt.trim()}`
}
