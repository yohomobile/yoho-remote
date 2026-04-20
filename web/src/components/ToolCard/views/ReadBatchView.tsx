import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { resolveDisplayPath } from '@/components/ToolCard/path'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getFiles(input: unknown): string[] {
    if (!isObject(input) || !Array.isArray(input.files)) {
        return []
    }

    return input.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
}

export function ReadBatchView(props: ToolViewProps) {
    const files = getFiles(props.block.tool.input)

    if (files.length === 0) {
        return <div className="text-sm text-[var(--app-hint)]">Waiting for file list…</div>
    }

    return (
        <div className="flex flex-col gap-1">
            {files.map((file) => (
                <div key={file} className="text-sm font-mono text-[var(--app-fg)] break-all">
                    {resolveDisplayPath(file, props.metadata)}
                </div>
            ))}
        </div>
    )
}
