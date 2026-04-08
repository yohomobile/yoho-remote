import type { Machine } from '../../sync/syncEngine'

export function sortMachinesForDisplay(machines: Machine[]): Machine[] {
    return [...machines].sort((a, b) => {
        if (a.active !== b.active) {
            return a.active ? -1 : 1
        }

        const aLastSeen = Math.max(a.activeAt, a.updatedAt, a.createdAt)
        const bLastSeen = Math.max(b.activeAt, b.updatedAt, b.createdAt)
        return bLastSeen - aLastSeen
    })
}

export function serializeMachine(machine: Machine) {
    return {
        id: machine.id,
        active: machine.active,
        activeAt: machine.activeAt,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt,
        metadata: machine.metadata ? { ...machine.metadata } : null,
        daemonState: machine.daemonState,
    }
}
