import type { Machine } from '@/types/api'

export function getMachineTitle(machine: Machine | null | undefined): string {
    if (!machine) return 'Machine'
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function getMachineIp(machine: Machine | null | undefined): string | null {
    if (!machine?.metadata) return null
    return machine.metadata.publicIp ?? machine.metadata.ip ?? null
}

export function getMachineStatusLabel(machine: Machine | null | undefined): string {
    return machine?.active ? '在线' : '离线'
}

export function formatMachineTimestamp(timestamp?: number | null): string {
    if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) {
        return '-'
    }
    return new Date(timestamp).toLocaleString()
}
