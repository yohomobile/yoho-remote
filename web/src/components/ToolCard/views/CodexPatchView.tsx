import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'
import { getCodexPatchEntries, truncatePreview } from '@/components/ToolCard/codexArtifacts'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

function renderEntries(props: ToolViewProps, preview: boolean) {
    const entries = getCodexPatchEntries(props.block.tool.input, props.block.tool.result)
    if (entries.length === 0) return null

    const visibleEntries = preview ? entries.slice(0, 1) : entries

    return (
        <div className="flex flex-col gap-3">
            {visibleEntries.map((entry, index) => {
                const display = entry.filePath ? resolveDisplayPath(entry.filePath, props.metadata) : null
                const title = display ? basename(display) : null
                const code = preview && entry.text ? truncatePreview(entry.text) : entry.text

                return (
                    <div key={`${entry.filePath ?? 'unknown'}:${index}`} className="flex flex-col gap-2">
                        {title ? (
                            <div className="text-sm text-[var(--app-fg)] font-mono break-all">
                                {title}
                            </div>
                        ) : null}
                        {code ? (
                            <CodeBlock code={code} language={entry.language} />
                        ) : null}
                    </div>
                )
            })}
            {preview && entries.length > visibleEntries.length ? (
                <div className="text-xs text-[var(--app-hint)]">
                    (+{entries.length - visibleEntries.length} more files)
                </div>
            ) : null}
        </div>
    )
}

export function CodexPatchCompactView(props: ToolViewProps) {
    return renderEntries(props, true)
}

export function CodexPatchView(props: ToolViewProps) {
    return renderEntries(props, false)
}
