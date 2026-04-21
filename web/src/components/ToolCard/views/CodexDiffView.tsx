import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'
import { DiffView } from '@/components/DiffView'
import { getCodexDiffUnified, truncatePreview } from '@/components/ToolCard/codexArtifacts'

export type UnifiedDiffSection = {
    filePath: string | null
    oldText: string
    newText: string
}

function isDiffMetadataLine(line: string): boolean {
    return line.startsWith('index ')
        || line.startsWith('new file mode ')
        || line.startsWith('deleted file mode ')
        || line.startsWith('similarity index ')
        || line.startsWith('rename from ')
        || line.startsWith('rename to ')
        || line.startsWith('old mode ')
        || line.startsWith('new mode ')
}

function parseDiffGitPath(line: string): string | null {
    if (!line.startsWith('diff --git ')) {
        return null
    }

    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (!match) {
        return null
    }

    return match[2]
}

function parseUnifiedDiffPath(line: string): string | null {
    if (line.startsWith('+++ ')) {
        const candidate = line.slice('+++ '.length)
        if (candidate === '/dev/null') return null
        return candidate.replace(/^[ab]\//, '')
    }

    if (line.startsWith('--- ')) {
        const candidate = line.slice('--- '.length)
        if (candidate === '/dev/null') return null
        return candidate.replace(/^[ab]\//, '')
    }

    return null
}

export function parseUnifiedDiffSections(unifiedDiff: string): UnifiedDiffSection[] {
    const lines = unifiedDiff.split('\n')
    const sections: UnifiedDiffSection[] = []
    let currentSection: {
        filePath: string | null
        oldLines: string[]
        newLines: string[]
        inHunk: boolean
    } | null = null

    const flushSection = () => {
        if (!currentSection) return

        if (currentSection.filePath === null && currentSection.oldLines.length === 0 && currentSection.newLines.length === 0) {
            currentSection = null
            return
        }

        sections.push({
            filePath: currentSection.filePath,
            oldText: currentSection.oldLines.join('\n'),
            newText: currentSection.newLines.join('\n')
        })
        currentSection = null
    }

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flushSection()
            currentSection = {
                filePath: parseDiffGitPath(line),
                oldLines: [],
                newLines: [],
                inHunk: false
            }
            continue
        }

        if (!currentSection) {
            currentSection = {
                filePath: null,
                oldLines: [],
                newLines: [],
                inHunk: false
            }
        }

        if (line.startsWith('+++ ') || line.startsWith('--- ')) {
            const filePath = parseUnifiedDiffPath(line)
            if (filePath) {
                currentSection.filePath = filePath
            }
            continue
        }

        if (line.startsWith('@@')) {
            currentSection.inHunk = true
            continue
        }

        if (!currentSection.inHunk || isDiffMetadataLine(line) || line === '\\ No newline at end of file') {
            continue
        }

        if (line.startsWith('+')) {
            currentSection.newLines.push(line.slice(1))
            continue
        }

        if (line.startsWith('-')) {
            currentSection.oldLines.push(line.slice(1))
            continue
        }

        if (line.startsWith(' ')) {
            const text = line.slice(1)
            currentSection.oldLines.push(text)
            currentSection.newLines.push(text)
            continue
        }

        if (line === '') {
            currentSection.oldLines.push('')
            currentSection.newLines.push('')
        }
    }

    flushSection()
    return sections
}

function splitUnifiedDiffRawSections(unifiedDiff: string): string[] {
    const lines = unifiedDiff.split('\n')
    const rawSections: string[] = []
    let currentLines: string[] = []

    const flushSection = () => {
        if (currentLines.length === 0) return
        rawSections.push(currentLines.join('\n'))
        currentLines = []
    }

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flushSection()
            continue
        }

        currentLines.push(line)
    }

    flushSection()
    return rawSections
}

function renderFallbackSection(section: UnifiedDiffSection, rawSection: string | undefined, index: number) {
    return (
        <div key={`${section.filePath ?? 'unknown'}:${index}`} className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
            {section.filePath ? (
                <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-hint)] truncate">
                    {section.filePath}
                </div>
            ) : null}
            <div className="px-2 py-2 text-xs text-[var(--app-hint)]">
                No textual diff available
            </div>
            {typeof rawSection === 'string' && rawSection.trim().length > 0 ? (
                <div className="border-t border-[var(--app-border)] bg-[var(--app-code-bg)]">
                    <pre className="m-0 overflow-x-auto p-2 text-xs font-mono whitespace-pre-wrap break-words text-[var(--app-fg)]">
                        {rawSection.trimEnd()}
                    </pre>
                </div>
            ) : null}
        </div>
    )
}

export function renderUnifiedDiffSections(sections: UnifiedDiffSection[], rawSections: string[] = []) {
    return (
        <div className="flex flex-col gap-3">
            {sections.map((section, index) => (
                section.oldText.length > 0 || section.newText.length > 0 ? (
                    <DiffView
                        key={`${section.filePath ?? 'unknown'}:${index}`}
                        oldString={section.oldText}
                        newString={section.newText}
                        filePath={section.filePath ?? undefined}
                        variant="inline"
                    />
                ) : (
                    renderFallbackSection(section, rawSections[index], index)
                )
            ))}
        </div>
    )
}

function renderDiff(block: ToolViewProps['block']) {
    const unifiedDiff = getCodexDiffUnified(block.tool.input, block.tool.result)
    if (!unifiedDiff) return null

    return renderUnifiedDiffSections(
        parseUnifiedDiffSections(unifiedDiff),
        splitUnifiedDiffRawSections(unifiedDiff)
    )
}

export function CodexDiffCompactView(props: ToolViewProps) {
    const unifiedDiff = getCodexDiffUnified(props.block.tool.input, props.block.tool.result)
    if (!unifiedDiff) return null

    return <CodeBlock code={truncatePreview(unifiedDiff)} language="diff" />
}

export function CodexDiffFullView(props: ToolViewProps) {
    return renderDiff(props.block)
}
