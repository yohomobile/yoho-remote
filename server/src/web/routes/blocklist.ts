import type { Machine } from '../../sync/syncEngine'

/**
 * Blocked machine hostnames — these machines will be hidden from
 * GET /machines and rejected by spawn / session-create endpoints.
 */
const BLOCKED_HOSTS = new Set([
    'guang.local',  // macmini
])

export function isMachineBlocked(machine: Machine): boolean {
    const host = machine.metadata?.host
    if (host && BLOCKED_HOSTS.has(host)) {
        return true
    }
    return false
}
