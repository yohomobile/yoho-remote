import { SESSION_PERMISSION_MODE_VALUES } from '../../sessionPermissionMode'

type SessionPermissionMode = typeof SESSION_PERMISSION_MODE_VALUES[number]

export function validatePermissionModeForSessionFlavor(
    flavorInput: unknown,
    permissionMode: SessionPermissionMode,
): { ok: true } | { ok: false; error: string } {
    const flavor = typeof flavorInput === 'string' && flavorInput.trim().length > 0
        ? flavorInput.trim()
        : 'claude'

    if (flavor === 'claude') {
        if (permissionMode !== 'bypassPermissions') {
            return { ok: false, error: 'Claude sessions only support permissionMode=bypassPermissions' }
        }
        return { ok: true }
    }

    if (flavor === 'codex') {
        if (permissionMode === 'bypassPermissions') {
            return { ok: false, error: 'Codex sessions do not support permissionMode=bypassPermissions' }
        }
        return { ok: true }
    }

    return { ok: false, error: `Session config currently only supports Claude/Codex sessions; current flavor is ${flavor}` }
}
