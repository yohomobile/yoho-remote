import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { basename, resolveDisplayPath } from '@/components/ToolCard/path'

const MAX_VISIBLE_FILES = 8

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getFiles(input: unknown): string[] {
    if (!isObject(input) || !Array.isArray(input.files)) {
        return []
    }

    return input.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
}

function getDisplayParts(file: string, metadata: ToolViewProps['metadata']): { name: string; directory: string | null; displayPath: string } {
    const displayPath = resolveDisplayPath(file, metadata)
    const name = basename(displayPath)
    const directory = displayPath === name
        ? null
        : displayPath.slice(0, Math.max(0, displayPath.length - name.length)).replace(/[\\/]+$/, '')

    return { name, directory: directory && directory.length > 0 ? directory : null, displayPath }
}

export function ReadBatchView(props: ToolViewProps) {
    const files = getFiles(props.block.tool.input)

    if (files.length === 0) {
        return (
            <div className="rounded-md border border-dashed border-[var(--app-divider)] px-3 py-2 text-sm text-[var(--app-hint)]">
                Waiting for file list…
            </div>
        )
    }

    const visibleFiles = files.slice(0, MAX_VISIBLE_FILES)
    const remaining = files.length - visibleFiles.length

    return (
        <div className="flex flex-col gap-1">
            {visibleFiles.map((file, index) => {
                const parts = getDisplayParts(file, props.metadata)
                return (
                    <div key={`${file}:${index}`} className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--app-subtle-bg)]">
                        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--app-subtle-bg)] font-mono text-[10px] font-medium text-[var(--app-hint)]">
                            {index + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="break-all font-mono text-sm leading-5 text-[var(--app-fg)]">
                                {parts.name}
                            </div>
                            {parts.directory ? (
                                <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-[var(--app-hint)]">
                                    {parts.directory}
                                </div>
                            ) : parts.displayPath !== parts.name ? (
                                <div className="mt-0.5 break-all font-mono text-[11px] leading-4 text-[var(--app-hint)]">
                                    {parts.displayPath}
                                </div>
                            ) : null}
                        </div>
                    </div>
                )
            })}
            {remaining > 0 ? (
                <div className="px-2 pt-1 text-xs text-[var(--app-hint)]">
                    +{remaining} more files
                </div>
            ) : null}
        </div>
    )
}
