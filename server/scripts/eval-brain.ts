#!/usr/bin/env bun

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { goldenSetSchema, type GoldenItem, type GoldenSet } from '../src/eval/golden-set'
import {
    diffReports,
    renderReport,
    runGoldenSet,
    type CaseRunner,
    type EvalOutcome,
    type EvalReport,
} from '../src/eval/runner'
import {
    findLatestBaseline,
    pruneHistory,
    readHistoryReport,
    writeHistoryEntry,
} from '../src/eval/history'

type RunnerKind = 'mock'

type Options = {
    goldenPath: string
    historyDir: string
    runId: string
    runner: RunnerKind
    baselineRunId: string | null
    outputJsonPath: string | null
    keep: number
    format: 'text' | 'json'
    failOnRegression: boolean
    help: boolean
}

const DEFAULT_GOLDEN = path.join(import.meta.dir, '..', 'src', 'eval', 'fixtures', 'golden-set.v1.json')
const DEFAULT_HISTORY = path.join(import.meta.dir, '..', 'eval-history')

function printUsage(): void {
    console.log(`Usage:
  bun run scripts/eval-brain.ts [options]

Run the K1 Phase 3D golden-set against a CaseRunner, write a versioned report
to history, and (optionally) compare with the most recent baseline run.

This script never calls a real LLM. The default --runner=mock returns a
deterministic synthetic response per item that intentionally hits the
expectations defined in the fixture (so a green run is the regression baseline).

Options:
  --golden=<path>          Path to golden set JSON (default: ${path.relative(process.cwd(), DEFAULT_GOLDEN)})
  --history-dir=<path>     Directory to persist run reports (default: ${path.relative(process.cwd(), DEFAULT_HISTORY)})
  --run-id=<id>            Run identifier (default: ISO timestamp)
  --runner=mock            Case runner backend (currently only "mock")
  --baseline=<runId|auto>  Compare against baseline (default: auto = latest history excluding this run)
  --output=<path>          Also write the rendered JSON report to this path
  --keep=<n>               Prune history, keep latest N runs (default: 30, 0 to disable)
  --format=text|json       stdout format (default: text)
  --fail-on-regression     Exit with code 1 if regressions appear vs baseline
  --help, -h               Show this help
`)
}

function parseArgs(argv: string[]): Options {
    const opts: Options = {
        goldenPath: DEFAULT_GOLDEN,
        historyDir: DEFAULT_HISTORY,
        runId: new Date().toISOString().replace(/[:.]/g, '-'),
        runner: 'mock',
        baselineRunId: 'auto',
        outputJsonPath: null,
        keep: 30,
        format: 'text',
        failOnRegression: false,
        help: false,
    }

    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            opts.help = true
            continue
        }
        if (arg === '--fail-on-regression') {
            opts.failOnRegression = true
            continue
        }
        if (arg.startsWith('--golden=')) {
            opts.goldenPath = arg.slice('--golden='.length).trim()
            continue
        }
        if (arg.startsWith('--history-dir=')) {
            opts.historyDir = arg.slice('--history-dir='.length).trim()
            continue
        }
        if (arg.startsWith('--run-id=')) {
            opts.runId = arg.slice('--run-id='.length).trim()
            continue
        }
        if (arg.startsWith('--runner=')) {
            const value = arg.slice('--runner='.length).trim()
            if (value !== 'mock') {
                throw new Error(`Unsupported --runner value: ${value}. Only "mock" is implemented.`)
            }
            opts.runner = value
            continue
        }
        if (arg.startsWith('--baseline=')) {
            const value = arg.slice('--baseline='.length).trim()
            opts.baselineRunId = value || null
            continue
        }
        if (arg === '--no-baseline') {
            opts.baselineRunId = null
            continue
        }
        if (arg.startsWith('--output=')) {
            opts.outputJsonPath = arg.slice('--output='.length).trim()
            continue
        }
        if (arg.startsWith('--keep=')) {
            const n = Number(arg.slice('--keep='.length))
            if (!Number.isInteger(n) || n < 0) {
                throw new Error('--keep must be a non-negative integer')
            }
            opts.keep = n
            continue
        }
        if (arg.startsWith('--format=')) {
            const value = arg.slice('--format='.length).trim()
            if (value !== 'text' && value !== 'json') {
                throw new Error(`Unsupported --format value: ${value}`)
            }
            opts.format = value
            continue
        }
        throw new Error(`Unknown argument: ${arg}`)
    }

    return opts
}

async function loadGoldenSet(filePath: string): Promise<GoldenSet> {
    if (!existsSync(filePath)) {
        throw new Error(`Golden set file not found: ${filePath}`)
    }
    const raw = await readFile(filePath, 'utf-8')
    return goldenSetSchema.parse(JSON.parse(raw))
}

function buildMockRunner(): CaseRunner {
    return async (item: GoldenItem): Promise<EvalOutcome> => {
        // Deterministic synthetic response that satisfies the fixture's expectations.
        // Real runners (live LLM) will plug in later via a different --runner mode.
        const parts: string[] = []
        for (const must of item.expect.mustContain ?? []) {
            parts.push(must)
        }
        if (parts.length === 0) parts.push(`mock-response:${item.id}`)
        const tokenBudget = item.expect.maxTokens ?? 512
        const latencyBudget = item.expect.maxLatencyMs ?? 1000
        return {
            itemId: item.id,
            title: item.title,
            response: parts.join(' '),
            tokens: Math.max(1, Math.min(tokenBudget, 60)),
            latencyMs: Math.max(1, Math.min(latencyBudget, 50)),
        }
    }
}

async function resolveBaseline(
    historyDir: string,
    baseline: string | null,
    currentRunId: string,
): Promise<EvalReport | null> {
    if (!baseline) return null
    if (baseline === 'auto') {
        const latest = await findLatestBaseline(historyDir, currentRunId)
        if (!latest) return null
        return await readHistoryReport(historyDir, latest.runId)
    }
    return await readHistoryReport(historyDir, baseline)
}

function getGitSha(): string | null {
    return process.env.GIT_SHA?.trim() || null
}

async function main(): Promise<number> {
    let opts: Options
    try {
        opts = parseArgs(process.argv.slice(2))
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        printUsage()
        return 2
    }
    if (opts.help) {
        printUsage()
        return 0
    }

    const set = await loadGoldenSet(opts.goldenPath)
    const runner = buildMockRunner()
    const report = await runGoldenSet(set, runner)

    const entry = await writeHistoryEntry({
        historyDir: opts.historyDir,
        runId: opts.runId,
        createdAt: Date.now(),
        gitSha: getGitSha(),
        report,
    })

    if (opts.outputJsonPath) {
        await writeFile(opts.outputJsonPath, JSON.stringify(report, null, 2), 'utf-8')
    }

    const baseline = await resolveBaseline(opts.historyDir, opts.baselineRunId, opts.runId)
    const diff = baseline ? diffReports(baseline, report) : null

    if (opts.keep > 0) {
        await pruneHistory(opts.historyDir, opts.keep)
    }

    if (opts.format === 'json') {
        const payload = {
            runId: entry.runId,
            createdAt: entry.createdAt,
            gitSha: entry.gitSha,
            report,
            baseline: baseline
                ? { runId: opts.baselineRunId, items: baseline.items, passed: baseline.passed, failed: baseline.failed }
                : null,
            diff,
        }
        console.log(JSON.stringify(payload, null, 2))
    } else {
        console.log(renderReport(report))
        if (baseline && diff) {
            console.log('')
            console.log(`Baseline diff (vs ${opts.baselineRunId}):`)
            console.log(`  deltaPassed: ${diff.deltaPassed}`)
            console.log(`  deltaFailed: ${diff.deltaFailed}`)
            if (diff.regressions.length > 0) {
                console.log(`  regressions: ${diff.regressions.join(', ')}`)
            }
            if (diff.fixes.length > 0) {
                console.log(`  fixes: ${diff.fixes.join(', ')}`)
            }
        } else {
            console.log('')
            console.log('Baseline diff: <no baseline available>')
        }
    }

    if (opts.failOnRegression && diff && diff.regressions.length > 0) {
        return 1
    }
    if (report.failed > 0) {
        // Surface failures non-zero so CI users can opt into hard-fail without --fail-on-regression.
        return opts.failOnRegression ? 1 : 0
    }
    return 0
}

const exitCode = await main()
process.exit(exitCode)
