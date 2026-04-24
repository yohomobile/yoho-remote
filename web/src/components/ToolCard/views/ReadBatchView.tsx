import { CheckIcon, CopyIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { getReadBatchItems } from '@/components/ToolCard/readBatch'

function ReadBatchCodeBlock(props: {
    code: string
}) {
    const { copied, copy } = useCopyToClipboard()

    return (
        <div className="relative min-w-0 max-w-full">
            <button
                type="button"
                onClick={() => copy(props.code)}
                className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                title="Copy"
            >
                {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            </button>

            <div className="min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-md bg-[var(--app-code-bg)]">
                <pre className="m-0 w-max min-w-full whitespace-pre p-2 pr-8 text-xs font-mono text-[var(--app-fg)]">{props.code}</pre>
            </div>
        </div>
    )
}

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
                <div key={`${item.file}:${index}`} className="min-w-0 overflow-hidden rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]/60">
                    <div className="flex min-w-0 items-start gap-3 border-b border-[var(--app-divider)] bg-[var(--app-secondary-bg)]/60 px-3 py-2.5">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--app-subtle-bg)] text-[11px] font-medium text-[var(--app-hint)]">
                            {index + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="break-all text-sm font-medium leading-5 text-[var(--app-fg)]">
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
                    <div className="px-3 py-3">
                        {item.content ? (
                            <ReadBatchCodeBlock code={item.content} />
                        ) : (
                            <div className="rounded-md border border-dashed border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]">
                                File content is not available for this read.
                            </div>
                        )}
                    </div>
                </div>
            ))}
        </div>
    )
}
