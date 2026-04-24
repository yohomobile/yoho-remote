import { describe, expect, it } from 'bun:test'
import type { GoldenItem, GoldenSet } from './golden-set'
import { redactGoldenItem, redactText } from './golden-set'
import { diffReports, renderReport, runGoldenSet } from './runner'

function makeItem(overrides: Partial<GoldenItem> = {}): GoldenItem {
    return {
        id: 'item-1',
        title: '简洁表达',
        category: 'communication_plan',
        input: {
            personId: 'person-1',
            orgId: 'org-1',
            userMessage: 'sgprod 的端口是多少？',
        },
        expect: {
            mustContain: ['5432'],
            mustNotContain: ['老板'],
            maxTokens: 50,
            maxLatencyMs: 1000,
        },
        dimensions: ['factual_consistency', 'token_cost'],
        ...overrides,
    }
}

function makeSet(items: GoldenItem[]): GoldenSet {
    return { version: 1, createdAt: 1_700_000_000_000, items }
}

describe('runGoldenSet', () => {
    it('passes when response satisfies all expectations', async () => {
        const report = await runGoldenSet(makeSet([makeItem()]), async () => ({
            itemId: 'item-1',
            title: '简洁表达',
            response: 'sgprod 数据库端口 5432',
            tokens: 30,
            latencyMs: 500,
        }))
        expect(report.passed).toBe(1)
        expect(report.failed).toBe(0)
        expect(report.byDimension.factual_consistency).toEqual({ passed: 1, failed: 0 })
    })

    it('fails when response missing required substring', async () => {
        const report = await runGoldenSet(makeSet([makeItem()]), async () => ({
            itemId: 'item-1',
            title: '简洁表达',
            response: '请自行查询配置',
            tokens: 10,
            latencyMs: 100,
        }))
        expect(report.failed).toBe(1)
        expect(report.cases[0].issues[0].type).toBe('must_contain_missing')
    })

    it('fails when response contains forbidden substring', async () => {
        const report = await runGoldenSet(makeSet([makeItem()]), async () => ({
            itemId: 'item-1',
            title: '简洁表达',
            response: 'sgprod 端口 5432，老板会很关心',
            tokens: 40,
            latencyMs: 500,
        }))
        const issueTypes = report.cases[0].issues.map((i) => i.type)
        expect(issueTypes).toContain('must_not_contain_hit')
    })

    it('fails when token / latency budget exceeded', async () => {
        const report = await runGoldenSet(makeSet([makeItem()]), async () => ({
            itemId: 'item-1',
            title: '简洁表达',
            response: 'sgprod 5432',
            tokens: 500,
            latencyMs: 5000,
        }))
        const types = report.cases[0].issues.map((i) => i.type)
        expect(types).toContain('max_tokens_exceeded')
        expect(types).toContain('max_latency_exceeded')
    })

    it('records run_error when runCase throws', async () => {
        const report = await runGoldenSet(makeSet([makeItem()]), async () => {
            throw new Error('mock llm exploded')
        })
        expect(report.failed).toBe(1)
        expect(report.cases[0].issues[0].type).toBe('run_error')
    })
})

describe('diffReports', () => {
    const baselineCase = {
        itemId: 'item-1',
        passed: true,
        issues: [],
        outcome: null,
    } as const
    const failingCase = {
        itemId: 'item-1',
        passed: false,
        issues: [{ type: 'run_error' as const, detail: 'x' }],
        outcome: null,
    }

    it('flags regressions when candidate fails an item baseline passed', () => {
        const baseline = { version: 1, items: 1, passed: 1, failed: 0, byDimension: {}, cases: [baselineCase] }
        const candidate = { version: 1, items: 1, passed: 0, failed: 1, byDimension: {}, cases: [failingCase] }
        const diff = diffReports(baseline, candidate)
        expect(diff.regressions).toEqual(['item-1'])
        expect(diff.fixes).toEqual([])
        expect(diff.deltaPassed).toBe(-1)
    })

    it('flags fixes when candidate passes an item baseline failed', () => {
        const baseline = { version: 1, items: 1, passed: 0, failed: 1, byDimension: {}, cases: [failingCase] }
        const candidate = { version: 1, items: 1, passed: 1, failed: 0, byDimension: {}, cases: [baselineCase] }
        const diff = diffReports(baseline, candidate)
        expect(diff.fixes).toEqual(['item-1'])
        expect(diff.regressions).toEqual([])
    })
})

describe('redaction', () => {
    it('redacts emails in plain text', () => {
        expect(redactText('联系 guang@yohomobile.com 或 ops@yoho.run'))
            .toBe('联系 <email> 或 <email>')
    })

    it('redacts personId and orgId markers', () => {
        expect(redactText('person-abcdef01 属于 org-deadbeef'))
            .toBe('person-<redacted> 属于 org-<redacted>')
    })

    it('redactGoldenItem scrubs nested fields', () => {
        const item = makeItem({
            input: {
                personId: 'person-abcdef01',
                orgId: 'org-1',
                userMessage: 'guang@yohomobile.com 问：端口？',
                priorContext: ['ops@yoho.run 说 5432'],
            },
            notes: 'from sub-abcdef01',
        })
        const redacted = redactGoldenItem(item)
        expect(redacted.input.userMessage).toBe('<email> 问：端口？')
        expect(redacted.input.priorContext).toEqual(['<email> 说 5432'])
        expect(redacted.notes).toBe('from sub-<redacted>')
        expect(redacted.input.personId).toBe('person-abcdef01') // 结构字段保留，只 scrub 文本
    })
})

describe('renderReport', () => {
    it('includes failure summaries in output', async () => {
        const report = await runGoldenSet(makeSet([makeItem()]), async () => ({
            itemId: 'item-1',
            title: '简洁表达',
            response: '找不到配置',
            tokens: 10,
            latencyMs: 50,
        }))
        const text = renderReport(report)
        expect(text).toContain('Failures:')
        expect(text).toContain('must_contain_missing')
    })
})
