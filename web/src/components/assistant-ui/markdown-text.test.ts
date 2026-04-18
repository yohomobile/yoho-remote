import { describe, expect, test } from 'bun:test'
import { isFolderPath, preprocessMarkdown } from './markdown-text'

describe('preprocessMarkdown', () => {
    test('closes an unclosed backtick fence', () => {
        expect(preprocessMarkdown('```ts\nconst value = 1')).toBe('```ts\nconst value = 1\n```')
    })

    test('closes an unclosed tilde fence', () => {
        expect(preprocessMarkdown('~~~\nconst value = 1')).toBe('~~~\nconst value = 1\n~~~')
    })

    test('does not touch inline code spans', () => {
        expect(preprocessMarkdown('Use `inline code` here.')).toBe('Use `inline code` here.')
    })
})

describe('isFolderPath', () => {
    test('treats only trailing slash as a folder when status is absent', () => {
        expect(isFolderPath('docs/')).toBe(true)
        expect(isFolderPath('README')).toBe(false)
        expect(isFolderPath('Makefile')).toBe(false)
    })

    test('prefers explicit backend status when present', () => {
        expect(isFolderPath('README', 'folder')).toBe(true)
        expect(isFolderPath('docs/', 'file')).toBe(false)
    })
})
