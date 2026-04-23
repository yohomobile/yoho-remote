import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { getReadBatchItems } from '@/components/ToolCard/readBatch'

export function ReadBatchView(props: ToolViewProps) {
    const items = getReadBatchItems(props.block, props.metadata)

    if (items.length === 0) {
        return (
            <div className="rounded-md border border-dashed border-[var(--app-divider)] px-3 py-2 text-sm text-[var(--app-hint)]">
                Waiting for file list…
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {items.map((item, index) => (
                <div key={`${item.file}:${index}`} className="min-w-0 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]/60 px-2 py-2">
                    <div className="flex min-w-0 items-start gap-2">
                        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--app-subtle-bg)] font-mono text-[10px] font-medium text-[var(--app-hint)]">
                            {index + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="break-all font-mono text-sm leading-5 text-[var(--app-fg)]">
                                {item.name}
                            </div>
                            {item.directory ? (
                                <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-[var(--app-hint)]">
                                    {item.directory}
                                </div>
                            ) : item.displayPath !== item.name ? (
                                <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-[var(--app-hint)]">
                                    {item.displayPath}
                                </div>
                            ) : null}
                        </div>
                    </div>
                    {item.content ? (
                        <div className="mt-2 min-w-0 max-w-full overflow-x-auto rounded-md bg-[var(--app-code-bg)]">
                            <pre className="m-0 w-max min-w-full whitespace-pre p-2 text-xs font-mono text-[var(--app-fg)]">{item.content}</pre>
                        </div>
                    ) : (
                        <div className="mt-2 rounded-md border border-dashed border-[var(--app-divider)] px-2 py-1.5 text-xs text-[var(--app-hint)]">
                            File content is not available for this read.
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}
