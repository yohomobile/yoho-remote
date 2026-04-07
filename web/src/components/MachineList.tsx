import type { Machine } from '@/types/api'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getMachineTitle } from '@/lib/machines'

export function MachineList(props: {
    machines: Machine[]
    onSelect: (machineId: string) => void
}) {
    return (
        <div className="flex flex-col gap-3 p-3">
            <div className="text-xs text-[var(--app-hint)]">
                {props.machines.length} online
            </div>

            <div className="flex flex-col gap-3">
                {props.machines.map((m) => (
                    <Card
                        key={m.id}
                        className="cursor-pointer"
                        onClick={() => props.onSelect(m.id)}
                    >
                        <CardHeader className="pb-2">
                            <CardTitle className="truncate">{getMachineTitle(m)}</CardTitle>
                            <CardDescription className="truncate">
                                {m.metadata?.platform ? m.metadata.platform : 'Unknown platform'}
                            </CardDescription>
                        </CardHeader>
                    </Card>
                ))}
            </div>
        </div>
    )
}
