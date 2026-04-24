// Phase 3E Session Affect：会话级临时状态，只影响当前 session 表达节奏。
// 设计稿：docs/design/k1-phase3-actor-aware-brain.md §4.E
// 硬边界：
// - 不做心理诊断。
// - 不写长期 persona。
// - 只能影响表达，不能影响工具调用、权限或事实判断。
// - 过期后不再注入。

export type SessionAffectMode = 'concise' | 'detailed' | 'default'

export type SessionAffect = {
    mode: SessionAffectMode
    source: 'user_explicit' | 'user_toggle' | 'system_signal'
    setAt: number
    expiresAt?: number | null
    note?: string | null
}

export type SessionAffectStatus =
    | 'none'
    | 'default'
    | 'expired'
    | 'attached'

export type SessionAffectContext = {
    affect: SessionAffect | null
    prompt: string | null
    metadataPatch: {
        sessionAffectAttached: boolean
        sessionAffectStatus: SessionAffectStatus
        sessionAffectMode: SessionAffectMode | null
        sessionAffectExpiresAt: number | null
    }
}

const MODE_LABELS: Record<SessionAffectMode, string> = {
    concise: '本会话偏好简洁。省略铺垫、不展开背景，除非用户要求。',
    detailed: '本会话偏好详细。主动给出完整背景、边界条件、理由链。',
    default: '本会话无特殊节奏偏好，按任务需要决定详略。',
}

const SOURCE_LABELS: Record<SessionAffect['source'], string> = {
    user_explicit: '用户在本会话明确表达',
    user_toggle: '用户在本会话 UI 切换',
    system_signal: '系统从本会话信号推断',
}

export type SessionAffectInput = {
    affect?: SessionAffect | null
    now?: number
}

export function resolveSessionAffectContext(input: SessionAffectInput): SessionAffectContext {
    const now = input.now ?? Date.now()
    const affect = input.affect ?? null

    if (!affect) {
        return {
            affect: null,
            prompt: null,
            metadataPatch: {
                sessionAffectAttached: false,
                sessionAffectStatus: 'none',
                sessionAffectMode: null,
                sessionAffectExpiresAt: null,
            },
        }
    }

    if (affect.expiresAt !== null && affect.expiresAt !== undefined && affect.expiresAt <= now) {
        return {
            affect: null,
            prompt: null,
            metadataPatch: {
                sessionAffectAttached: false,
                sessionAffectStatus: 'expired',
                sessionAffectMode: affect.mode,
                sessionAffectExpiresAt: affect.expiresAt ?? null,
            },
        }
    }

    if (affect.mode === 'default') {
        return {
            affect,
            prompt: null,
            metadataPatch: {
                sessionAffectAttached: false,
                sessionAffectStatus: 'default',
                sessionAffectMode: 'default',
                sessionAffectExpiresAt: affect.expiresAt ?? null,
            },
        }
    }

    const lines: string[] = []
    lines.push('【本会话表达节奏（session-only）】')
    lines.push(`- 节奏：${MODE_LABELS[affect.mode]}`)
    lines.push(`- 来源：${SOURCE_LABELS[affect.source]}`)
    if (affect.note?.trim()) {
        lines.push(`- 备注：${affect.note.trim()}`)
    }
    lines.push('- 约束：仅影响回复节奏与详略。不做心理诊断，不写长期画像，不影响工具调用或事实判断。')
    lines.push('- 过期后自动丢弃。')
    const prompt = lines.join('\n')

    return {
        affect,
        prompt,
        metadataPatch: {
            sessionAffectAttached: true,
            sessionAffectStatus: 'attached',
            sessionAffectMode: affect.mode,
            sessionAffectExpiresAt: affect.expiresAt ?? null,
        },
    }
}

export function appendSessionAffectPrompt(basePrompt: string, affectPrompt: string | null | undefined): string {
    if (!affectPrompt || !affectPrompt.trim()) return basePrompt
    if (!basePrompt || !basePrompt.trim()) return affectPrompt
    return `${basePrompt}\n\n${affectPrompt}`
}

const MIN_NOTE_LENGTH = 0
const MAX_NOTE_LENGTH = 500

export type SessionAffectUpdateInput = {
    mode: SessionAffectMode
    source: SessionAffect['source']
    note?: string | null
    ttlMs?: number | null
    now?: number
}

export function buildSessionAffect(input: SessionAffectUpdateInput): SessionAffect {
    const now = input.now ?? Date.now()
    const note = input.note?.trim() || null
    if (note && (note.length < MIN_NOTE_LENGTH || note.length > MAX_NOTE_LENGTH)) {
        throw new Error(`note length must be ${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} chars`)
    }
    const expiresAt = input.ttlMs === null || input.ttlMs === undefined ? null : now + input.ttlMs
    return {
        mode: input.mode,
        source: input.source,
        setAt: now,
        expiresAt,
        note,
    }
}

export const SESSION_AFFECT_METADATA_KEY = 'sessionAffect'

const VALID_MODES: ReadonlyArray<SessionAffectMode> = ['concise', 'detailed', 'default']
const VALID_SOURCES: ReadonlyArray<SessionAffect['source']> = ['user_explicit', 'user_toggle', 'system_signal']

export function extractSessionAffectFromMetadata(metadata: Record<string, unknown> | null | undefined): SessionAffect | null {
    if (!metadata || typeof metadata !== 'object') return null
    const raw = (metadata as Record<string, unknown>)[SESSION_AFFECT_METADATA_KEY]
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const mode = typeof obj.mode === 'string' && VALID_MODES.includes(obj.mode as SessionAffectMode)
        ? (obj.mode as SessionAffectMode)
        : null
    const source = typeof obj.source === 'string' && VALID_SOURCES.includes(obj.source as SessionAffect['source'])
        ? (obj.source as SessionAffect['source'])
        : null
    const setAt = typeof obj.setAt === 'number' ? obj.setAt : null
    if (!mode || !source || setAt === null) return null
    const expiresAt = typeof obj.expiresAt === 'number' ? obj.expiresAt : null
    const note = typeof obj.note === 'string' ? obj.note : null
    return { mode, source, setAt, expiresAt, note }
}
