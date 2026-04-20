export const SESSION_PERMISSION_MODE_VALUES = [
    'default',
    'bypassPermissions',
    'read-only',
    'safe-yolo',
    'yolo',
] as const

export const CLAUDE_PERMISSION_MODE_VALUES = ['bypassPermissions'] as const
export const CODEX_PERMISSION_MODE_VALUES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const

export type SessionPermissionMode = typeof SESSION_PERMISSION_MODE_VALUES[number]

function asTrimmedString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

export function normalizeSessionPermissionMode(input: {
    flavor?: unknown
    permissionMode: unknown
    metadata?: Record<string, unknown> | null | undefined
}): SessionPermissionMode | undefined {
    const flavor = asTrimmedString(input.flavor)
    const raw = asTrimmedString(input.permissionMode)
    const yolo = input.metadata?.yolo === true

    if (flavor === 'claude') {
        return raw === 'bypassPermissions' ? raw : undefined
    }

    if (flavor === 'codex') {
        if (raw === 'default' || raw === 'read-only' || raw === 'safe-yolo' || raw === 'yolo') {
            return raw
        }
        if (raw === 'bypassPermissions' && yolo) {
            // Older Brain/Codex sessions were incorrectly seeded with bypassPermissions
            // even though the runtime was actually launched in yolo mode.
            return 'yolo'
        }
        return undefined
    }

    if (!raw) {
        return undefined
    }
    return SESSION_PERMISSION_MODE_VALUES.includes(raw as SessionPermissionMode)
        ? raw as SessionPermissionMode
        : undefined
}
