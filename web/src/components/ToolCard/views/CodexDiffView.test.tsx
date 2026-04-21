import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolViewProps } from './_all'
import { getCodexDiffUnified } from '@/components/ToolCard/codexArtifacts'
import { CodexDiffFullView, parseUnifiedDiffSections, renderUnifiedDiffSections } from './CodexDiffView'

const multiFileUnifiedDiff = [
    'diff --git a/web/src/app.ts b/web/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/web/src/app.ts',
    '+++ b/web/src/app.ts',
    '@@ -1,3 +1,3 @@',
    '-old app line',
    '+new app line',
    ' keep app line',
    'diff --git a/web/src/utils.ts b/web/src/utils.ts',
    'index 3333333..4444444 100644',
    '--- a/web/src/utils.ts',
    '+++ b/web/src/utils.ts',
    '@@ -1,3 +1,3 @@',
    '-old utils line',
    '+new utils line',
    ' keep utils line'
].join('\n')

function createProps(input: unknown, result: unknown = null): ToolViewProps {
    return {
        metadata: null,
        block: {
            kind: 'tool-call',
            id: 'codex-diff-1',
            localId: null,
            createdAt: 0,
            tool: {
                id: 'codex-diff-1',
                name: 'CodexDiff',
                state: 'completed',
                input,
                createdAt: 0,
                startedAt: 0,
                completedAt: 1,
                description: null,
                result
            },
            children: []
        }
    }
}

describe('CodexDiffView', () => {
    test('splits multi-file unified diffs into isolated sections', () => {
        const sections = parseUnifiedDiffSections(multiFileUnifiedDiff)

        expect(sections).toEqual([
            {
                filePath: 'web/src/app.ts',
                oldText: 'old app line\nkeep app line',
                newText: 'new app line\nkeep app line'
            },
            {
                filePath: 'web/src/utils.ts',
                oldText: 'old utils line\nkeep utils line',
                newText: 'new utils line\nkeep utils line'
            }
        ])
    })

    test('renders one diff block per file without mixing content', () => {
        const sections = parseUnifiedDiffSections(multiFileUnifiedDiff)
        const html = renderToStaticMarkup(renderUnifiedDiffSections(sections))

        expect(html).toContain('web/src/app.ts')
        expect(html).toContain('web/src/utils.ts')
        expect(html).toContain('old app line')
        expect(html).toContain('new app line')
        expect(html).toContain('old utils line')
        expect(html).toContain('new utils line')
        expect((html.match(/web\/src\/app\.ts/g) ?? []).length).toBe(1)
        expect((html.match(/web\/src\/utils\.ts/g) ?? []).length).toBe(1)
    })

    test('reads short diffs from input.diff and parses them into sections', () => {
        const shortDiff = [
            'diff --git a/web/src/app.ts b/web/src/app.ts',
            '--- a/web/src/app.ts',
            '+++ b/web/src/app.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new'
        ].join('\n')

        const unified = getCodexDiffUnified({ diff: shortDiff })
        expect(unified).toBe(shortDiff)

        const html = renderToStaticMarkup(renderUnifiedDiffSections(parseUnifiedDiffSections(unified ?? '')))
        expect(html).toContain('web/src/app.ts')
        expect(html).toContain('old')
        expect(html).toContain('new')
    })

    test('keeps the original file path and deletion semantics when +++ is /dev/null', () => {
        const sections = parseUnifiedDiffSections([
            'diff --git a/web/src/removed.ts b/web/src/removed.ts',
            'deleted file mode 100644',
            'index 1111111..0000000',
            '--- a/web/src/removed.ts',
            '+++ /dev/null',
            '@@ -1,2 +0,0 @@',
            '-removed line one',
            '-removed line two'
        ].join('\n'))

        expect(sections).toEqual([
            {
                filePath: 'web/src/removed.ts',
                oldText: 'removed line one\nremoved line two',
                newText: ''
            }
        ])

        const html = renderToStaticMarkup(renderUnifiedDiffSections(sections))
        expect(html).toContain('web/src/removed.ts')
        expect(html).not.toContain('/dev/null')
        expect(html).toContain('removed line one')
        expect(html).toContain('removed line two')
    })

    test('renders a visible fallback for binary diffs without text hunks', () => {
        const unifiedDiff = [
            'diff --git a/web/public/logo.png b/web/public/logo.png',
            'new file mode 100644',
            'index 0000000..1111111',
            'Binary files /dev/null and b/web/public/logo.png differ'
        ].join('\n')

        const html = renderToStaticMarkup(<CodexDiffFullView {...createProps({ unified_diff: unifiedDiff })} />)

        expect(html).toContain('web/public/logo.png')
        expect(html).toMatch(/binary|Binary|No textual diff|No text changes|无文本/)
    })

    test('renders a visible fallback for metadata-only diffs without hunks', () => {
        const unifiedDiff = [
            'diff --git a/web/src/old-name.ts b/web/src/new-name.ts',
            'similarity index 100%',
            'rename from web/src/old-name.ts',
            'rename to web/src/new-name.ts'
        ].join('\n')

        const html = renderToStaticMarkup(<CodexDiffFullView {...createProps({ unified_diff: unifiedDiff })} />)

        expect(html).toContain('web/src/old-name.ts')
        expect(html).toContain('web/src/new-name.ts')
        expect(html).toMatch(/rename|No textual diff|No text changes|metadata|无文本/)
    })

    test('renders multi-file diffs from result.diff without mixing hunks', () => {
        const html = renderToStaticMarkup(<CodexDiffFullView {...createProps({}, { diff: multiFileUnifiedDiff })} />)

        expect(html).toContain('web/src/app.ts')
        expect(html).toContain('web/src/utils.ts')
        expect(html).toContain('old app line')
        expect(html).toContain('new utils line')
        expect((html.match(/web\/src\/app\.ts/g) ?? []).length).toBe(1)
        expect((html.match(/web\/src\/utils\.ts/g) ?? []).length).toBe(1)
    })
})
