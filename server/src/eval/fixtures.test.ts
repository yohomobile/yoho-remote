import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { goldenSetSchema, redactGoldenItem } from './golden-set'

const FIXTURE_PATH = path.join(import.meta.dir, 'fixtures', 'golden-set.v1.json')

describe('golden set fixture v1', () => {
    test('parses against goldenSetSchema', async () => {
        const raw = await readFile(FIXTURE_PATH, 'utf-8')
        const parsed = goldenSetSchema.parse(JSON.parse(raw))
        expect(parsed.version).toBe(1)
        expect(parsed.items.length).toBeGreaterThan(0)
        for (const item of parsed.items) {
            expect(item.id).toMatch(/^[a-z0-9-]+$/)
            expect(item.dimensions.length).toBeGreaterThan(0)
        }
    })

    test('all items survive redaction round-trip', async () => {
        const raw = await readFile(FIXTURE_PATH, 'utf-8')
        const parsed = goldenSetSchema.parse(JSON.parse(raw))
        for (const item of parsed.items) {
            const redacted = redactGoldenItem(item)
            expect(redacted.input.personId).toBe(item.input.personId)
            expect(typeof redacted.input.userMessage).toBe('string')
        }
    })

    test('contains coverage for all six dimensions', async () => {
        const raw = await readFile(FIXTURE_PATH, 'utf-8')
        const parsed = goldenSetSchema.parse(JSON.parse(raw))
        const seen = new Set<string>()
        for (const item of parsed.items) {
            for (const d of item.dimensions) seen.add(d)
        }
        expect(seen.has('factual_consistency')).toBe(true)
        expect(seen.has('wrong_memory_write')).toBe(true)
        expect(seen.has('pseudo_familiarity')).toBe(true)
        expect(seen.has('pseudo_empathy')).toBe(true)
        expect(seen.has('token_cost')).toBe(true)
        expect(seen.has('latency')).toBe(true)
    })
})
