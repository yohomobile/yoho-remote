import type { GoldenItem, GoldenSet } from './golden-set'

// Phase 3D Eval Runner：本地运行 golden set，输出 item 级结果 + 总分。
// 不调用真实 LLM；调用方注入 `runCase` 以适配不同 fixture 或 mock。
// 设计稿：docs/design/k1-phase3-actor-aware-brain.md §4.D

export type EvalOutcome = {
    itemId: string
    title: string
    response: string
    tokens: number
    latencyMs: number
}

export type EvalIssue = {
    type:
        | 'must_contain_missing'
        | 'must_not_contain_hit'
        | 'must_not_match_hit'
        | 'max_tokens_exceeded'
        | 'max_latency_exceeded'
        | 'run_error'
    detail: string
}

export type EvalCaseResult = {
    itemId: string
    passed: boolean
    issues: EvalIssue[]
    outcome: EvalOutcome | null
}

export type EvalReport = {
    version: number
    items: number
    passed: number
    failed: number
    byDimension: Record<string, { passed: number; failed: number }>
    cases: EvalCaseResult[]
}

export type CaseRunner = (item: GoldenItem) => Promise<EvalOutcome>

export async function runGoldenSet(set: GoldenSet, runCase: CaseRunner): Promise<EvalReport> {
    const cases: EvalCaseResult[] = []
    const byDimension: Record<string, { passed: number; failed: number }> = {}

    for (const item of set.items) {
        let outcome: EvalOutcome | null = null
        const issues: EvalIssue[] = []
        try {
            outcome = await runCase(item)
        } catch (error) {
            issues.push({
                type: 'run_error',
                detail: error instanceof Error ? error.message : String(error),
            })
        }

        if (outcome) {
            for (const needle of item.expect.mustContain ?? []) {
                if (!outcome.response.includes(needle)) {
                    issues.push({
                        type: 'must_contain_missing',
                        detail: `missing: ${needle}`,
                    })
                }
            }
            for (const needle of item.expect.mustNotContain ?? []) {
                if (outcome.response.includes(needle)) {
                    issues.push({
                        type: 'must_not_contain_hit',
                        detail: `forbidden substring: ${needle}`,
                    })
                }
            }
            for (const pattern of item.expect.mustNotMatch ?? []) {
                if (new RegExp(pattern).test(outcome.response)) {
                    issues.push({
                        type: 'must_not_match_hit',
                        detail: `forbidden pattern: ${pattern}`,
                    })
                }
            }
            if (item.expect.maxTokens !== undefined && outcome.tokens > item.expect.maxTokens) {
                issues.push({
                    type: 'max_tokens_exceeded',
                    detail: `${outcome.tokens} > ${item.expect.maxTokens}`,
                })
            }
            if (item.expect.maxLatencyMs !== undefined && outcome.latencyMs > item.expect.maxLatencyMs) {
                issues.push({
                    type: 'max_latency_exceeded',
                    detail: `${outcome.latencyMs}ms > ${item.expect.maxLatencyMs}ms`,
                })
            }
        }

        const passed = issues.length === 0
        cases.push({ itemId: item.id, passed, issues, outcome })

        for (const dim of item.dimensions) {
            const bucket = byDimension[dim] ?? { passed: 0, failed: 0 }
            if (passed) bucket.passed += 1
            else bucket.failed += 1
            byDimension[dim] = bucket
        }
    }

    const passed = cases.filter((c) => c.passed).length
    return {
        version: set.version,
        items: set.items.length,
        passed,
        failed: cases.length - passed,
        byDimension,
        cases,
    }
}

export function diffReports(
    baseline: EvalReport,
    candidate: EvalReport,
): {
    deltaPassed: number
    deltaFailed: number
    regressions: string[]
    fixes: string[]
} {
    const baselineCases = new Map(baseline.cases.map((c) => [c.itemId, c]))
    const candidateCases = new Map(candidate.cases.map((c) => [c.itemId, c]))
    const regressions: string[] = []
    const fixes: string[] = []

    for (const [id, cand] of candidateCases) {
        const base = baselineCases.get(id)
        if (!base) continue
        if (base.passed && !cand.passed) regressions.push(id)
        if (!base.passed && cand.passed) fixes.push(id)
    }

    return {
        deltaPassed: candidate.passed - baseline.passed,
        deltaFailed: candidate.failed - baseline.failed,
        regressions,
        fixes,
    }
}

export function renderReport(report: EvalReport): string {
    const lines: string[] = []
    lines.push(`Eval report v${report.version}`)
    lines.push(`Items: ${report.items}  Passed: ${report.passed}  Failed: ${report.failed}`)
    lines.push('By dimension:')
    for (const [dim, stats] of Object.entries(report.byDimension)) {
        lines.push(`  ${dim}: ${stats.passed} pass / ${stats.failed} fail`)
    }
    const failed = report.cases.filter((c) => !c.passed)
    if (failed.length > 0) {
        lines.push('Failures:')
        for (const c of failed) {
            lines.push(`  ${c.itemId}: ${c.issues.map((i) => i.type).join(', ')}`)
        }
    }
    return lines.join('\n')
}
