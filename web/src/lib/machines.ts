import type { Machine } from '@/types/api'

const machineDisplayNameCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
})

export function getMachineTitle(machine: Machine | null | undefined): string {
    if (!machine) return 'Machine'
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function sortMachinesForStableDisplay(machines: readonly Machine[]): Machine[] {
    return [...machines].sort((a, b) => {
        if (a.active !== b.active) {
            return a.active ? -1 : 1
        }

        const titleCompare = machineDisplayNameCollator.compare(getMachineTitle(a), getMachineTitle(b))
        if (titleCompare !== 0) {
            return titleCompare
        }

        const hostCompare = machineDisplayNameCollator.compare(a.metadata?.host ?? '', b.metadata?.host ?? '')
        if (hostCompare !== 0) {
            return hostCompare
        }

        return a.id.localeCompare(b.id)
    })
}

export function getMobileSessionAgentSummary(input: {
    agentLabel: string
    machineName?: string | null
    projectName?: string | null
}): string {
    return [input.agentLabel, input.machineName, input.projectName]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join(' · ')
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
