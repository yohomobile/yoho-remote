import { describe, expect, test } from 'bun:test'
import { getCodexDiffUnified, getCodexPatchEntries, getUnifiedDiffFilePath } from './codexArtifacts'
import { getToolPresentation } from './knownTools'

describe('codexArtifacts', () => {
    test('reads legacy CodexPatch changes payloads', () => {
        const entries = getCodexPatchEntries({
            changes: {
                '/repo/src/app.ts': {
                    type: 'update',
                    unified_diff: '@@ -1 +1 @@\n-old\n+new\n'
                }
            }
        }, null)

        expect(entries).toEqual([{
            filePath: '/repo/src/app.ts',
            language: 'diff',
            text: '@@ -1 +1 @@\n-old\n+new\n'
        }])
    })

    test('reads exec-style CodexPatch result diffs', () => {
        const entries = getCodexPatchEntries(
            { file_path: '/repo/src/app.ts' },
            {
                file_path: '/repo/src/app.ts',
                diff: '@@ -1 +1 @@\n-old\n+new\n',
                status: 'completed'
            }
        )

        expect(entries).toEqual([{
            filePath: '/repo/src/app.ts',
            language: 'diff',
            text: '@@ -1 +1 @@\n-old\n+new\n'
        }])
    })

    test('reads enriched exec-style CodexPatch change arrays', () => {
        const entries = getCodexPatchEntries(
            {
                changes: {
                    '/repo/src/app.ts': {
                        kind: 'update'
                    }
                }
            },
            {
                changes: [{
                    path: '/repo/src/app.ts',
                    kind: 'update',
                    unified_diff: '@@ -1 +1 @@\n-old\n+new\n'
                }],
                status: 'completed'
            }
        )

        expect(entries).toEqual([{
            filePath: '/repo/src/app.ts',
            language: 'diff',
            text: '@@ -1 +1 @@\n-old\n+new\n'
        }])
    })

    test('extracts unified diff file path', () => {
        const unified = [
            'diff --git a/web/src/app.ts b/web/src/app.ts',
            '--- a/web/src/app.ts',
            '+++ b/web/src/app.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new'
        ].join('\n')

        expect(getCodexDiffUnified({ unified_diff: unified })).toBe(unified)
        expect(getUnifiedDiffFilePath(unified)).toBe('web/src/app.ts')
    })
})

describe('Codex tool presentation', () => {
    test('keeps CodexPatch inline when a diff is available', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexPatch',
            input: { file_path: '/repo/src/app.ts' },
            result: {
                file_path: '/repo/src/app.ts',
                diff: '@@ -1 +1 @@\n-old\n+new\n'
            },
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.minimal).toBe(false)
        expect(presentation.subtitle).toBe('app.ts')
    })

    test('keeps long CodexDiff inline instead of collapsing it away', () => {
        const unified = [
            'diff --git a/web/src/app.ts b/web/src/app.ts',
            '--- a/web/src/app.ts',
            '+++ b/web/src/app.ts',
            ...Array.from({ length: 80 }, (_, index) => `+line ${index}`)
        ].join('\n')

        const presentation = getToolPresentation({
            toolName: 'CodexDiff',
            input: { unified_diff: unified },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.minimal).toBe(false)
        expect(presentation.subtitle).toBe('app.ts')
    })
})
