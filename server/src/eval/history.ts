import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { EvalReport } from './runner'

export type EvalHistoryEntry = {
    runId: string
    createdAt: number
    gitSha: string | null
    setVersion: number
    items: number
    passed: number
    failed: number
    reportPath: string
}

export type EvalHistoryWriteInput = {
    historyDir: string
    runId: string
    createdAt: number
    gitSha: string | null
    report: EvalReport
}

export async function ensureHistoryDir(historyDir: string): Promise<void> {
    if (!existsSync(historyDir)) {
        await mkdir(historyDir, { recursive: true })
    }
}

export async function writeHistoryEntry(input: EvalHistoryWriteInput): Promise<EvalHistoryEntry> {
    await ensureHistoryDir(input.historyDir)
    const reportPath = path.join(input.historyDir, `${input.runId}.json`)
    await writeFile(reportPath, JSON.stringify(input.report, null, 2), 'utf-8')

    const entry: EvalHistoryEntry = {
        runId: input.runId,
        createdAt: input.createdAt,
        gitSha: input.gitSha,
        setVersion: input.report.version,
        items: input.report.items,
        passed: input.report.passed,
        failed: input.report.failed,
        reportPath,
    }

    const indexPath = path.join(input.historyDir, 'index.json')
    const existing = await readHistoryIndex(input.historyDir)
    const filtered = existing.filter((e) => e.runId !== input.runId)
    const next = [...filtered, entry].sort((a, b) => a.createdAt - b.createdAt)
    await writeFile(indexPath, JSON.stringify(next, null, 2), 'utf-8')

    return entry
}

export async function readHistoryIndex(historyDir: string): Promise<EvalHistoryEntry[]> {
    const indexPath = path.join(historyDir, 'index.json')
    if (!existsSync(indexPath)) return []
    const raw = await readFile(indexPath, 'utf-8')
    try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed.filter(isHistoryEntry)
    } catch {
        return []
    }
}

export async function readHistoryReport(historyDir: string, runId: string): Promise<EvalReport | null> {
    const reportPath = path.join(historyDir, `${runId}.json`)
    if (!existsSync(reportPath)) return null
    const raw = await readFile(reportPath, 'utf-8')
    try {
        const parsed = JSON.parse(raw) as EvalReport
        if (typeof parsed.version !== 'number') return null
        return parsed
    } catch {
        return null
    }
}

export async function findLatestBaseline(historyDir: string, excludeRunId?: string): Promise<EvalHistoryEntry | null> {
    const entries = await readHistoryIndex(historyDir)
    const candidates = excludeRunId
        ? entries.filter((e) => e.runId !== excludeRunId)
        : entries
    if (candidates.length === 0) return null
    return candidates[candidates.length - 1] ?? null
}

export async function pruneHistory(historyDir: string, keep: number): Promise<EvalHistoryEntry[]> {
    if (keep <= 0) return []
    const entries = await readHistoryIndex(historyDir)
    if (entries.length <= keep) return []
    const removed = entries.slice(0, entries.length - keep)
    const retained = entries.slice(entries.length - keep)

    const indexPath = path.join(historyDir, 'index.json')
    await writeFile(indexPath, JSON.stringify(retained, null, 2), 'utf-8')

    const dirEntries = await readdir(historyDir)
    const removedIds = new Set(removed.map((e) => e.runId))
    for (const file of dirEntries) {
        if (!file.endsWith('.json') || file === 'index.json') continue
        const id = file.slice(0, -'.json'.length)
        if (removedIds.has(id)) {
            await rm(path.join(historyDir, file), { force: true })
        }
    }

    return removed
}

function isHistoryEntry(value: unknown): value is EvalHistoryEntry {
    if (!value || typeof value !== 'object') return false
    const v = value as Record<string, unknown>
    return (
        typeof v.runId === 'string' &&
        typeof v.createdAt === 'number' &&
        typeof v.setVersion === 'number' &&
        typeof v.items === 'number' &&
        typeof v.passed === 'number' &&
        typeof v.failed === 'number' &&
        typeof v.reportPath === 'string' &&
        (v.gitSha === null || typeof v.gitSha === 'string')
    )
}
