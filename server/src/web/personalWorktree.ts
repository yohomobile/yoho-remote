import type { Machine } from '../sync/syncEngine'

const PERSONAL_WORKTREE_MACHINE_NAMES = new Set([
    'guang-instance',
    'bruce-instance',
])

type SessionType = 'simple' | 'worktree' | undefined

function normalizeMachineName(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }
    const trimmed = value.trim().toLowerCase()
    return trimmed.length > 0 ? trimmed : null
}

export function isPersonalWorktreeMachine(machine: Machine | null | undefined): boolean {
    const names = [
        normalizeMachineName(machine?.metadata?.displayName),
        normalizeMachineName(machine?.metadata?.host),
    ]

    return names.some((name) => name ? PERSONAL_WORKTREE_MACHINE_NAMES.has(name) : false)
}

export function getPersonalWorktreeOwner(email: string | null | undefined): string | null {
    if (typeof email !== 'string') {
        return null
    }

    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
        return null
    }

    const prefix = trimmed.split('@')[0]?.trim()
    if (!prefix) {
        return null
    }

    const normalized = prefix
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')

    return normalized ? normalized : null
}

export function resolvePersonalWorktreeSpawnOptions(options: {
    machine: Machine | null | undefined
    email: string | null | undefined
    sessionType: SessionType
    worktreeName?: string
}): {
    sessionType: SessionType
    worktreeName?: string
    reuseExistingWorktree: boolean
    personalWorktreeOwner: string | null
} {
    const personalWorktreeOwner = isPersonalWorktreeMachine(options.machine)
        ? getPersonalWorktreeOwner(options.email)
        : null

    if (options.sessionType !== 'worktree' || !personalWorktreeOwner) {
        return {
            sessionType: options.sessionType,
            worktreeName: options.worktreeName,
            reuseExistingWorktree: false,
            personalWorktreeOwner,
        }
    }

    return {
        sessionType: 'worktree',
        worktreeName: personalWorktreeOwner,
        reuseExistingWorktree: true,
        personalWorktreeOwner,
    }
}
