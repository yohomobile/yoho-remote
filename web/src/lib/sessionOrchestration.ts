import type { Session } from '@/types/api'

type SessionOrchestrationProfile = {
    parentSource: string
    childSource: string
    parentSessionLabel: string
    childSessionLabel: string
    parentDisplayName: string
    parentBadgeLabel: string
    childBadgeLabel: string
    callbackLabel: string
    eventIcon: string
    accentTone: 'amber' | 'sky'
}

const SESSION_ORCHESTRATION_PROFILES: readonly SessionOrchestrationProfile[] = [
    {
        parentSource: 'brain',
        childSource: 'brain-child',
        parentSessionLabel: '主 Brain',
        childSessionLabel: '子任务',
        parentDisplayName: 'Brain',
        parentBadgeLabel: '🧠 Brain',
        childBadgeLabel: '🧠 子任务',
        callbackLabel: '子任务回传',
        eventIcon: '🧠',
        accentTone: 'amber',
    },
    {
        parentSource: 'orchestrator',
        childSource: 'orchestrator-child',
        parentSessionLabel: '主编排 Session',
        childSessionLabel: '编排子任务',
        parentDisplayName: 'Orchestrator',
        parentBadgeLabel: '🎛 Orchestrator',
        childBadgeLabel: '🎛 编排子任务',
        callbackLabel: '编排子任务回传',
        eventIcon: '🎛',
        accentTone: 'sky',
    },
] as const

function normalizeSource(source: string | null | undefined): string | null {
    if (typeof source !== 'string') {
        return null
    }

    const trimmed = source.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : null
}

export function getSessionOrchestrationProfileBySource(
    source: string | null | undefined
): SessionOrchestrationProfile | null {
    const normalized = normalizeSource(source)
    if (!normalized) {
        return null
    }

    for (const profile of SESSION_ORCHESTRATION_PROFILES) {
        if (
            profile.parentSource === normalized ||
            profile.childSource === normalized
        ) {
            return profile
        }
    }

    return null
}

export function isSessionOrchestrationParentSource(
    source: string | null | undefined
): boolean {
    const profile = getSessionOrchestrationProfileBySource(source)
    return Boolean(profile && profile.parentSource === normalizeSource(source))
}

export function isSessionOrchestrationChildSource(
    source: string | null | undefined
): boolean {
    const profile = getSessionOrchestrationProfileBySource(source)
    return Boolean(profile && profile.childSource === normalizeSource(source))
}

export function getSessionOrchestrationChildSourceForParentSource(
    source: string | null | undefined
): string | undefined {
    const profile = getSessionOrchestrationProfileBySource(source)
    if (!profile || profile.parentSource !== normalizeSource(source)) {
        return undefined
    }
    return profile.childSource
}

export function getSessionOrchestrationParentSessionId(
    metadata: Session['metadata']
): string | undefined {
    if (
        !metadata ||
        !isSessionOrchestrationChildSource(metadata.source) ||
        typeof metadata.mainSessionId !== 'string'
    ) {
        return undefined
    }

    const trimmed = metadata.mainSessionId.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export function getSessionOrchestrationLabels(
    source: string | null | undefined
): {
    parentSessionLabel: string
    childSessionLabel: string
} | null {
    const profile = getSessionOrchestrationProfileBySource(source)
    if (!profile) {
        return null
    }

    return {
        parentSessionLabel: profile.parentSessionLabel,
        childSessionLabel: profile.childSessionLabel,
    }
}

export function getSessionOrchestrationPresentation(
    source: string | null | undefined
): {
    parentDisplayName: string
    badgeLabel: string
    callbackLabel: string
    eventIcon: string
    accentTone: 'amber' | 'sky'
} | null {
    const profile = getSessionOrchestrationProfileBySource(source)
    if (!profile) {
        return null
    }

    const normalized = normalizeSource(source)
    return {
        parentDisplayName: profile.parentDisplayName,
        badgeLabel:
            normalized === profile.childSource
                ? profile.childBadgeLabel
                : profile.parentBadgeLabel,
        callbackLabel: profile.callbackLabel,
        eventIcon: profile.eventIcon,
        accentTone: profile.accentTone,
    }
}

export function getSessionOrchestrationReadyPhaseCopy(
    source: string | null | undefined,
    phase: 'created' | 'initializing' | 'ready'
): string | null {
    const presentation = getSessionOrchestrationPresentation(source)
    if (!presentation) {
        return null
    }

    if (presentation.parentDisplayName === 'Orchestrator') {
        if (phase === 'created') {
            return '已创建：Orchestrator 会话已创建成功，正在等待 runtime 上线。现在发送的消息会先入队。'
        }
        if (phase === 'initializing') {
            return '初始化中：Orchestrator 已上线，正在加载编排工具和运行上下文，暂时不要把“创建成功”误当成“已经完全可用”。'
        }
        return '可开始使用：Orchestrator 已准备就绪，现在可以开始协调子 session。'
    }

    if (phase === 'created') {
        return '已创建：Brain 会话已创建成功，正在等待 runtime 上线。现在发送的消息会先入队。'
    }
    if (phase === 'initializing') {
        return '初始化中：Brain 已上线，正在加载初始化指令和工具，暂时不要把“创建成功”误当成“已经完全可用”。'
    }
    return '可开始使用：Brain 已准备就绪，现在可以开始派发任务。'
}

export function getSessionOrchestrationInactiveQueueCopy(
    source: string | null | undefined
): string | null {
    const presentation = getSessionOrchestrationPresentation(source)
    if (!presentation) {
        return null
    }

    return `${presentation.parentDisplayName} 当前未运行。新消息会先入队，等恢复后再消费。`
}
