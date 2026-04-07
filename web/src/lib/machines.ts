import type { Machine } from '@/types/api'

export function getMachineTitle(machine: Machine | null | undefined): string {
    if (!machine) return 'Machine'
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}
