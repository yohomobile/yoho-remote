import type { Machine } from '@/types/api'

const PERSONAL_WORKTREE_MACHINE_NAMES = new Set([
    'guang-instance',
    'bruce-instance',
])

type SessionType = 'simple' | 'worktree'

function normalizeMachineName(value: string | undefined): string | null {
    if (!value) {
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
    if (!email) {
        return null
    }

    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
        return null
    }

    const normalized = trimmed
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')

    return normalized ? normalized : null
}

export function getDefaultSessionTypeForMachine(machine: Machine | null | undefined, userEmail: string | null | undefined): SessionType {
    return isPersonalWorktreeMachine(machine) && getPersonalWorktreeOwner(userEmail)
        ? 'worktree'
        : 'simple'
}
