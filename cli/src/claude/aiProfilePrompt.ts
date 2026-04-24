export type AIProfileRole = 'developer' | 'architect' | 'reviewer' | 'pm' | 'tester' | 'devops'

export type AIProfile = {
    name: string
    role: AIProfileRole
    specialties: string[]
    personality: string | null
    greetingTemplate: string | null
    workStyle: string | null
    avatarEmoji: string
    stats: {
        tasksCompleted: number
        activeMinutes: number
    }
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
    developer: 'Execution Driver - You are a full-capability AI with a fast, execution-first style.',
    architect: 'Calm Strategist - You are a full-capability AI with a structured, long-horizon style.',
    reviewer: 'Critical Thinker - You are a full-capability AI with a risk-first, skeptical style.',
    pm: 'Alignment Lead - You are a full-capability AI with a coordination and clarity-first style.',
    tester: 'Skeptical Validator - You are a full-capability AI with a verification-first style.',
    devops: 'Steady Operator - You are a full-capability AI with a calm, reliability-first style.',
}

/**
 * 构建 AI 员工身份提示词
 */
export function buildAIProfilePrompt(profile: AIProfile): string {
    const parts: string[] = []

    // 风格标签和身份
    parts.push(`# Your Identity: ${profile.avatarEmoji} ${profile.name}`)
    parts.push('')
    parts.push(`**Style Preset:** ${ROLE_DESCRIPTIONS[profile.role] || profile.role}`)
    parts.push('**Scope:** You are an all-purpose AI. The style preset shapes how you reason and communicate, not what kinds of work you are allowed to do.')

    // 专长
    if (profile.specialties.length > 0) {
        parts.push(`**Specialties:** ${profile.specialties.join(', ')}`)
    }

    // 工作风格
    if (profile.workStyle) {
        parts.push(`**Work Style:** ${profile.workStyle}`)
    }

    // 个性
    if (profile.personality) {
        parts.push('')
        parts.push('## Your Personality')
        parts.push(profile.personality)
    }

    // 问候语模板（作为提示）
    if (profile.greetingTemplate) {
        parts.push('')
        parts.push('## Greeting Style')
        parts.push(`When starting a conversation, you might say something like: "${profile.greetingTemplate}"`)
    }

    // 统计信息（展示经验）
    if (profile.stats.tasksCompleted > 0) {
        parts.push('')
        parts.push('## Your Experience')
        parts.push(`You have completed ${profile.stats.tasksCompleted} tasks with ${Math.floor(profile.stats.activeMinutes / 60)} hours of active work.`)
    }

    parts.push('')
    parts.push('---')
    parts.push('')

    return parts.join('\n')
}

/**
 * 检查是否应该注入 AI Profile（基于会话名称或参数）
 */
export function shouldInjectAIProfile(
    profile: AIProfile | null,
    sessionName?: string,
    claudeAgent?: string
): boolean {
    // 没有 profile 就不注入
    if (!profile) return false

    // 如果 claudeAgent 是特殊角色，不注入普通 profile
    const specialAgents = ['cto']
    if (claudeAgent && specialAgents.includes(claudeAgent.toLowerCase())) {
        return false
    }

    // 默认：如果有 profile 就注入
    return true
}
