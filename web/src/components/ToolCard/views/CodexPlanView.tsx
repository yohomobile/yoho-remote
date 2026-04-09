import type { ToolViewProps } from '@/components/ToolCard/views/_all'

type PlanItem = {
    step: string
    status: 'pending' | 'in_progress' | 'completed'
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function extractPlanItems(input: unknown, result: unknown): PlanItem[] {
    // Prefer result (latest state) over input (initial state)
    for (const source of [result, input]) {
        if (!isObject(source)) continue
        const items = Array.isArray(source.plan) ? source.plan : null
        if (!items || items.length === 0) continue
        const parsed = items.flatMap((item): PlanItem[] => {
            if (!isObject(item) || typeof item.step !== 'string') return []
            const status = item.status === 'completed' ? 'completed'
                : item.status === 'in_progress' ? 'in_progress'
                : 'pending'
            return [{ step: item.step, status }]
        })
        if (parsed.length > 0) return parsed
    }
    return []
}

function itemTone(item: PlanItem): string {
    if (item.status === 'completed') return 'text-emerald-600 line-through'
    if (item.status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function itemIcon(item: PlanItem): string {
    if (item.status === 'completed') return '☑'
    return '☐'
}

export function CodexPlanView(props: ToolViewProps) {
    const items = extractPlanItems(props.block.tool.input, props.block.tool.result)
    if (items.length === 0) return null

    return (
        <div className="flex flex-col gap-1">
            {items.map((item, idx) => (
                <div key={idx} className={`text-sm ${itemTone(item)}`}>
                    {itemIcon(item)} {item.step}
                </div>
            ))}
        </div>
    )
}
