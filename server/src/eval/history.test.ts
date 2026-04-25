import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
    findLatestBaseline,
    pruneHistory,
    readHistoryIndex,
    readHistoryReport,
    writeHistoryEntry,
} from './history'
import type { EvalReport } from './runner'

function makeReport(overrides: Partial<EvalReport> = {}): EvalReport {
    return {
        version: 1,
        items: 2,
        passed: 2,
        failed: 0,
        byDimension: { factual_consistency: { passed: 2, failed: 0 } },
        cases: [
            { itemId: 'a', passed: true, issues: [], outcome: null },
            { itemId: 'b', passed: true, issues: [], outcome: null },
        ],
        ...overrides,
    }
}

describe('eval history', () => {
    let dir: string

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'eval-history-'))
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    test('writeHistoryEntry persists report file and updates index', async () => {
        const entry = await writeHistoryEntry({
            historyDir: dir,
            runId: 'run-001',
            createdAt: 1000,
            gitSha: 'abc123',
            report: makeReport(),
        })

        expect(entry.runId).toBe('run-001')
        expect(entry.passed).toBe(2)

        const stored = await readHistoryReport(dir, 'run-001')
        expect(stored?.passed).toBe(2)

        const index = await readHistoryIndex(dir)
        expect(index.length).toBe(1)
        expect(index[0]?.runId).toBe('run-001')
        expect(index[0]?.gitSha).toBe('abc123')
    })

    test('findLatestBaseline returns most recent entry by createdAt', async () => {
        await writeHistoryEntry({ historyDir: dir, runId: 'r1', createdAt: 100, gitSha: null, report: makeReport() })
        await writeHistoryEntry({ historyDir: dir, runId: 'r3', createdAt: 300, gitSha: null, report: makeReport({ passed: 1, failed: 1 }) })
        await writeHistoryEntry({ historyDir: dir, runId: 'r2', createdAt: 200, gitSha: null, report: makeReport() })

        const latest = await findLatestBaseline(dir)
        expect(latest?.runId).toBe('r3')
    })

    test('findLatestBaseline can exclude a run id', async () => {
        await writeHistoryEntry({ historyDir: dir, runId: 'r1', createdAt: 100, gitSha: null, report: makeReport() })
        await writeHistoryEntry({ historyDir: dir, runId: 'r2', createdAt: 200, gitSha: null, report: makeReport() })

        const latest = await findLatestBaseline(dir, 'r2')
        expect(latest?.runId).toBe('r1')
    })

    test('pruneHistory keeps the latest N and removes report files', async () => {
        for (let i = 1; i <= 5; i += 1) {
            await writeHistoryEntry({
                historyDir: dir,
                runId: `r${i}`,
                createdAt: i * 100,
                gitSha: null,
                report: makeReport(),
            })
        }

        const removed = await pruneHistory(dir, 2)
        expect(removed.map((e) => e.runId).sort()).toEqual(['r1', 'r2', 'r3'])

        const remaining = await readHistoryIndex(dir)
        expect(remaining.map((e) => e.runId)).toEqual(['r4', 'r5'])

        expect(await readHistoryReport(dir, 'r1')).toBeNull()
        expect(await readHistoryReport(dir, 'r5')).not.toBeNull()
    })

    test('writeHistoryEntry replaces an entry with same runId', async () => {
        await writeHistoryEntry({ historyDir: dir, runId: 'r1', createdAt: 100, gitSha: null, report: makeReport() })
        await writeHistoryEntry({
            historyDir: dir,
            runId: 'r1',
            createdAt: 150,
            gitSha: null,
            report: makeReport({ passed: 0, failed: 2 }),
        })

        const index = await readHistoryIndex(dir)
        expect(index.length).toBe(1)
        expect(index[0]?.passed).toBe(0)
        expect(index[0]?.failed).toBe(2)
    })

    test('readHistoryIndex tolerates missing index.json and returns []', async () => {
        const entries = await readHistoryIndex(dir)
        expect(entries).toEqual([])
    })

    test('readHistoryIndex tolerates malformed index.json', async () => {
        const indexPath = path.join(dir, 'index.json')
        await Bun.write(indexPath, '{not valid json')
        const entries = await readHistoryIndex(dir)
        expect(entries).toEqual([])
    })
})
