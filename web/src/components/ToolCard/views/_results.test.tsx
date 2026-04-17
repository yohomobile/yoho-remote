import { describe, expect, test } from 'bun:test'
import { extractWebSearchDisplayData } from './_results'

describe('Tool result views', () => {
    test('extracts WebSearch query and action details', () => {
        const display = extractWebSearchDisplayData(
            {
                query: 'codex exec json'
            },
            {
                id: 'search-1',
                query: 'codex exec json',
                action: {
                    type: 'search',
                    queries: ['codex exec json', 'codex thread events']
                }
            }
        )

        expect(display).toEqual({
            query: 'codex exec json',
            actionLabel: 'Search',
            actionDetails: ['codex exec json', 'codex thread events']
        })
    })
})
