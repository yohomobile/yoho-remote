#!/usr/bin/env bun
/**
 * Phase 3 pre-flight: BM25 vs prompt-based skill recall baseline
 *
 * Usage:
 *   bun run worker/src/evolve/recallBaseline.ts
 *   bun run worker/src/evolve/recallBaseline.ts --skip-llm
 *
 * Env:
 *   SKILLS_DIR          (default: /home/workspaces/tools/yoho-memory/skills)
 *   OPENROUTER_API_KEY  OpenRouter key → DeepSeek via OpenRouter (preferred)
 *   DEEPSEEK_API_KEY    Direct DeepSeek key (fallback)
 *
 * Produces:
 *   worker/evolve-dataset/recall-baseline-report.md
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── Paths ─────────────────────────────────────────────────────────────────────

const SKILLS_DIR = process.env.SKILLS_DIR ?? '/home/workspaces/tools/yoho-memory/skills'
const DATASET_PATH = join(__dirname, '../../evolve-dataset/skill-recall-eval.json')
const REPORT_PATH = join(__dirname, '../../evolve-dataset/recall-baseline-report.md')

// ── BM25 params ───────────────────────────────────────────────────────────────

const BM25_K1 = 1.5
const BM25_B = 0.75

// ── LLM config ────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY ?? ''
const SKIP_LLM = process.argv.includes('--skip-llm') || (!OPENROUTER_API_KEY && !DEEPSEEK_API_KEY && !CLAUDE_API_KEY)

// ── Types ─────────────────────────────────────────────────────────────────────

type QueryType = 'exact' | 'near_synonym' | 'fuzzy'

type EvalSample = {
    id: string
    query: string
    expected_skill_id: string
    query_type: QueryType
    note?: string
}

type SkillDoc = {
    id: string
    name: string
    description: string
    tags: string[]
    content: string
}

type SampleResult = {
    sample_id: string
    query: string
    query_type: QueryType
    expected: string
    bm25_top5: string[]
    llm_top5: string[]
    bm25_rank: number  // 1-based; 0 = not in top 14
    llm_rank: number
}

type GroupMetrics = {
    recall1: number
    recall3: number
    recall5: number
    mrr: number
    count: number
}

type Metrics = {
    recall1: number
    recall3: number
    recall5: number
    mrr: number
    byType: Record<QueryType, GroupMetrics>
}

// ── Tokenizer (unigram + bigram CJK, word-level Latin) ───────────────────────

function tokenize(text: string): string[] {
    const tokens: string[] = []
    // Split on whitespace/punctuation boundaries
    const segments = text.toLowerCase().split(/[\s\p{P}！。，；：""''【】《》、]+/u)
    for (const seg of segments) {
        if (!seg) continue
        const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/
        if (cjkPattern.test(seg)) {
            const cjkChars = [...seg].filter(c => cjkPattern.test(c))
            // Unigrams
            tokens.push(...cjkChars)
            // Bigrams (better recall for compound words like 会议, 表格)
            for (let i = 0; i < cjkChars.length - 1; i++) {
                tokens.push(cjkChars[i] + cjkChars[i + 1])
            }
            // Trigrams for longer compounds
            for (let i = 0; i < cjkChars.length - 2; i++) {
                tokens.push(cjkChars[i] + cjkChars[i + 1] + cjkChars[i + 2])
            }
            // Non-CJK parts in segment (e.g. "openId")
            const latin = seg.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').trim().split(/\s+/)
            tokens.push(...latin.filter(p => p.length > 1))
        } else if (seg.length > 1) {
            tokens.push(seg)
        }
    }
    return tokens.filter(t => t.length > 0)
}

// ── Skill loader ──────────────────────────────────────────────────────────────

function parseSkillMeta(content: string): { name: string; description: string; tags: string[] } {
    const name = (content.match(/^#\s+(.+)$/m)?.[1] ?? '').trim()
    const description = (content.match(/^>\s+(.+)$/m)?.[1] ?? '').trim()
    const tagsLine = content.match(/<!--\s*tags:\s*(.+?)\s*-->/)?.[1] ?? ''
    const tags = tagsLine.split(/[\s,]+/).filter(t => t.startsWith('#')).map(t => t.slice(1).toLowerCase())
    return { name, description, tags }
}

async function loadSkills(): Promise<SkillDoc[]> {
    const files = await readdir(SKILLS_DIR)
    const mdFiles = files.filter(f => f.endsWith('.md') && !f.startsWith('_'))
    const docs: SkillDoc[] = []
    for (const file of mdFiles) {
        const id = file.replace(/\.md$/, '')
        const content = await readFile(join(SKILLS_DIR, file), 'utf-8')
        const { name, description, tags } = parseSkillMeta(content)
        if (!name) continue
        docs.push({ id, name, description, tags, content })
    }
    return docs
}

// ── BM25F index (field-weighted BM25) ────────────────────────────────────────
// Approximate BM25F by concatenating fields with repetition for weighting.
// Weights match yoho-memory buildSkillCandidate priorities:
//   name/tags → 4×   description → 3×   content → 1×

type BM25Doc = {
    id: string
    termFreqs: Map<string, number>
    docLen: number
}

type BM25Index = {
    docs: BM25Doc[]
    df: Map<string, number>
    N: number
    avgLen: number
}

function buildWeightedText(skill: SkillDoc): string {
    const parts: string[] = [
        skill.name, skill.name, skill.name, skill.name,           // 4×
        skill.tags.join(' '), skill.tags.join(' '), skill.tags.join(' '), skill.tags.join(' '), // 4×
        skill.description, skill.description, skill.description,  // 3×
        skill.id.replace(/[-_]/g, ' '),                           // 1× id as text hint
        skill.content,                                            // 1×
    ]
    return parts.join(' ')
}

function buildBM25Index(skills: SkillDoc[]): BM25Index {
    const docs: BM25Doc[] = skills.map(skill => {
        const text = buildWeightedText(skill)
        const toks = tokenize(text)
        const termFreqs = new Map<string, number>()
        for (const t of toks) termFreqs.set(t, (termFreqs.get(t) ?? 0) + 1)
        return { id: skill.id, termFreqs, docLen: toks.length }
    })

    const df = new Map<string, number>()
    for (const doc of docs) {
        for (const term of doc.termFreqs.keys()) {
            df.set(term, (df.get(term) ?? 0) + 1)
        }
    }

    const avgLen = docs.reduce((s, d) => s + d.docLen, 0) / docs.length
    return { docs, df, N: docs.length, avgLen }
}

function bm25Retrieve(index: BM25Index, query: string): Array<{ skillId: string; score: number }> {
    const queryTokens = tokenize(query)
    const scores: Array<{ skillId: string; score: number }> = []

    for (const doc of index.docs) {
        let score = 0
        for (const term of queryTokens) {
            const tf = doc.termFreqs.get(term) ?? 0
            if (tf === 0) continue
            const dfVal = index.df.get(term) ?? 0
            // BM25 IDF (Robertson & Zaragoza)
            const idf = Math.log((index.N - dfVal + 0.5) / (dfVal + 0.5) + 1)
            // BM25 TF normalization
            const norm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * doc.docLen / index.avgLen))
            score += idf * norm
        }
        scores.push({ skillId: doc.id, score })
    }

    return scores.sort((a, b) => b.score - a.score)
}

// ── Prompt-based retrieval via DeepSeek (OpenRouter or direct) ────────────────

async function llmRetrieve(
    skills: SkillDoc[],
    query: string,
): Promise<Array<{ skillId: string; rank: number }>> {
    const skillList = skills
        .map(s => `[${s.id}] ${s.name} — ${s.description}`)
        .join('\n')

    const systemPrompt = [
        'You are a skill retrieval system. Given a user query and a list of available skills,',
        'return the 5 most relevant skill IDs in order (most relevant first).',
        'Output ONLY a JSON object: {"ranked": ["id1", "id2", "id3", "id4", "id5"]}',
        'Use exact IDs from the list. No explanation.',
    ].join(' ')

    const userPrompt = `Query: "${query}"\n\nAvailable skills:\n${skillList}`

    let content: string

    if (CLAUDE_API_KEY) {
        // Use Anthropic Claude API
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',  // Fast + cheap for ranking
                max_tokens: 300,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            }),
            signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw new Error(`Claude API ${response.status}: ${body}`)
        }
        const data = await response.json() as { content: Array<{ text: string }> }
        content = data.content[0]?.text ?? ''
    } else if (OPENROUTER_API_KEY) {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'deepseek/deepseek-chat',
                temperature: 0,
                max_tokens: 300,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
            signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw new Error(`OpenRouter API ${response.status}: ${body}`)
        }
        const data = await response.json() as { choices: Array<{ message: { content: string } }> }
        content = data.choices[0]?.message?.content ?? ''
    } else {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                temperature: 0,
                max_tokens: 300,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
            signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
            const body = await response.text().catch(() => '')
            throw new Error(`DeepSeek API ${response.status}: ${body}`)
        }
        const data = await response.json() as { choices: Array<{ message: { content: string } }> }
        content = data.choices[0]?.message?.content ?? ''
    }

    const jsonMatch = content.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) throw new Error(`No JSON in LLM response: ${content.slice(0, 200)}`)

    const parsed = JSON.parse(jsonMatch[0]) as { ranked?: string[] }
    const ranked = Array.isArray(parsed.ranked) ? parsed.ranked : []

    return ranked.map((skillId, i) => ({ skillId, rank: i + 1 }))
}

// ── Rank finder ───────────────────────────────────────────────────────────────

function findRank(ranked: Array<{ skillId: string }>, expectedId: string): number {
    const idx = ranked.findIndex(r => r.skillId === expectedId)
    return idx >= 0 ? idx + 1 : 0
}

// ── Metrics computation ───────────────────────────────────────────────────────

function computeMetrics(results: SampleResult[], method: 'bm25' | 'llm'): Metrics {
    const rankKey = method === 'bm25' ? 'bm25_rank' : 'llm_rank'
    const groups: Partial<Record<QueryType, { h1: number; h3: number; h5: number; rr: number; n: number }>> = {}
    let h1 = 0, h3 = 0, h5 = 0, rrSum = 0

    for (const r of results) {
        const rank = r[rankKey]
        if (!groups[r.query_type]) groups[r.query_type] = { h1: 0, h3: 0, h5: 0, rr: 0, n: 0 }
        const g = groups[r.query_type]!
        g.n++

        const rr = rank > 0 ? 1 / rank : 0
        rrSum += rr
        g.rr += rr

        if (rank === 1) { h1++; g.h1++ }
        if (rank > 0 && rank <= 3) { h3++; g.h3++ }
        if (rank > 0 && rank <= 5) { h5++; g.h5++ }
    }

    const n = results.length
    return {
        recall1: h1 / n,
        recall3: h3 / n,
        recall5: h5 / n,
        mrr: rrSum / n,
        byType: Object.fromEntries(
            Object.entries(groups).map(([t, g]) => [t, {
                recall1: g.h1 / g.n,
                recall3: g.h3 / g.n,
                recall5: g.h5 / g.n,
                mrr: g.rr / g.n,
                count: g.n,
            }])
        ) as Record<QueryType, GroupMetrics>,
    }
}

// ── Report generation ─────────────────────────────────────────────────────────

function pct(v: number) { return `${(v * 100).toFixed(1)}%` }
function fmt3(v: number) { return v.toFixed(3) }

function decisionText(bm25: Metrics, llm: Metrics | null): string {
    const r3 = bm25.recall3
    const lines: string[] = []

    if (r3 > 0.85) {
        lines.push('**建议：暂缓 Phase 3 GEPA**')
        lines.push(`BM25 Recall@3 = ${pct(r3)} > 85%，召回质量已较好。Phase 3 的边际收益偏低，`)
        lines.push('除非 LLM 有显著提升（>10pp），否则资源应先投入 Phase 0/1/2 巩固基础。')
    } else if (r3 < 0.50) {
        lines.push('**建议：暂缓 Phase 3，先修 Phase 0**')
        lines.push(`BM25 Recall@3 = ${pct(r3)} < 50%，召回本身是瓶颈。`)
        lines.push('应先完成 Phase 0（passesThreshold 修复 + discover 过滤改进），')
        lines.push('确保 BM25 基础召回可用后再评估 GEPA 的价值。')
    } else if (r3 < 0.70) {
        lines.push('**建议：有条件推进 Phase 3**')
        lines.push(`BM25 Recall@3 = ${pct(r3)}（50%-70%），有改善空间。`)
        if (llm && llm.recall3 > bm25.recall3 + 0.10) {
            lines.push(`LLM Recall@3 = ${pct(llm.recall3)}，比 BM25 高 ${pct(llm.recall3 - bm25.recall3)}。`)
            lines.push('说明 prompt-based 召回有显著优势，Phase 3 GEPA 优化 description/tags 有价值。')
        } else {
            lines.push('LLM 召回与 BM25 接近，建议优先完成 Phase 0 改进 BM25 基础，再上 Phase 3。')
        }
    } else {
        // 70-85%
        lines.push('**建议：可以推进 Phase 3**')
        lines.push(`BM25 Recall@3 = ${pct(r3)}（70%-85%），基础召回可用但仍有提升空间。`)
        if (bm25.recall1 < bm25.recall3 - 0.15) {
            lines.push(`注意：Recall@1 = ${pct(bm25.recall1)} vs Recall@3 = ${pct(bm25.recall3)}，`)
            lines.push('候选能召回但排序不准。GEPA 应重点优化 description/tags 改善排序，而非只优化 body。')
        } else {
            lines.push(`Recall@1 = ${pct(bm25.recall1)} 与 Recall@3 差距不大，BM25 区分度尚可。`)
            lines.push('GEPA 可重点优化 body 质量。')
        }
    }

    return lines.join('\n')
}

function generateReport(
    results: SampleResult[],
    bm25: Metrics,
    llm: Metrics | null,
    skills: SkillDoc[],
    runDate: string,
): string {
    const llmAvail = llm !== null

    const sections: string[] = [
        `# Skill 召回率基准测试报告`,
        ``,
        `> 生成时间：${runDate}  `,
        `> Phase 3 pre-flight：BM25 vs Prompt-based 召回率对比`,
        ``,
        `## 数据集概况`,
        ``,
        `| 指标 | 值 |`,
        `|------|-----|`,
        `| 技能总数 | ${skills.length} |`,
        `| 评测样本总数 | ${results.length} |`,
        `| exact 样本数 | ${results.filter(r => r.query_type === 'exact').length} |`,
        `| near_synonym 样本数 | ${results.filter(r => r.query_type === 'near_synonym').length} |`,
        `| fuzzy 样本数 | ${results.filter(r => r.query_type === 'fuzzy').length} |`,
        `| LLM 评测 | ${llmAvail ? '✅ 已运行 (DeepSeek via OpenRouter)' : '⏭️ 跳过 (--skip-llm 或无 API Key)'} |`,
        ``,
        `## 总体指标`,
        ``,
        `| 指标 | BM25${llmAvail ? ' | LLM (prompt-based)' : ''} |`,
        `|------|------${llmAvail ? '|------' : ''}|`,
        `| Recall@1 | ${pct(bm25.recall1)}${llmAvail ? ` | ${pct(llm!.recall1)}` : ''} |`,
        `| Recall@3 | ${pct(bm25.recall3)}${llmAvail ? ` | ${pct(llm!.recall3)}` : ''} |`,
        `| Recall@5 | ${pct(bm25.recall5)}${llmAvail ? ` | ${pct(llm!.recall5)}` : ''} |`,
        `| MRR      | ${fmt3(bm25.mrr)}${llmAvail ? ` | ${fmt3(llm!.mrr)}` : ''} |`,
        ``,
        `## 按查询类型分组`,
        ``,
    ]

    for (const qt of ['exact', 'near_synonym', 'fuzzy'] as QueryType[]) {
        const bg = bm25.byType[qt]
        const lg = llm?.byType[qt]
        if (!bg) continue
        sections.push(`### ${qt} (n=${bg.count})`)
        sections.push(``)
        sections.push(`| 指标 | BM25${llmAvail && lg ? ' | LLM' : ''} |`)
        sections.push(`|------|------${llmAvail && lg ? '|------' : ''}|`)
        sections.push(`| Recall@1 | ${pct(bg.recall1)}${llmAvail && lg ? ` | ${pct(lg.recall1)}` : ''} |`)
        sections.push(`| Recall@3 | ${pct(bg.recall3)}${llmAvail && lg ? ` | ${pct(lg.recall3)}` : ''} |`)
        sections.push(`| Recall@5 | ${pct(bg.recall5)}${llmAvail && lg ? ` | ${pct(lg.recall5)}` : ''} |`)
        sections.push(`| MRR      | ${fmt3(bg.mrr)}${llmAvail && lg ? ` | ${fmt3(lg.mrr)}` : ''} |`)
        sections.push(``)
    }

    // Failed samples
    const bm25Failures = results.filter(r => r.bm25_rank === 0 || r.bm25_rank > 3)
    if (bm25Failures.length > 0) {
        sections.push(`## BM25 未进入 Top-3 的样本`)
        sections.push(``)
        sections.push(`| ID | 查询 | 预期 | BM25 Rank | BM25 Top-3 |`)
        sections.push(`|----|------|------|-----------|------------|`)
        for (const r of bm25Failures) {
            const top3 = r.bm25_top5.slice(0, 3).join(', ')
            sections.push(`| ${r.sample_id} | ${r.query.slice(0, 40)}... | ${r.expected} | ${r.bm25_rank || 'N/A'} | ${top3} |`)
        }
        sections.push(``)
    }

    // Decision
    sections.push(`## 决策结论`)
    sections.push(``)
    sections.push(decisionText(bm25, llm))
    sections.push(``)

    // Raw results table
    sections.push(`## 逐样本结果`)
    sections.push(``)
    sections.push(`| ID | 类型 | 预期 | BM25 Rank${llmAvail ? ' | LLM Rank' : ''} |`)
    sections.push(`|----|------|------|----------${llmAvail ? '|----------' : ''}|`)
    for (const r of results) {
        const bRank = r.bm25_rank > 0 ? `#${r.bm25_rank}` : '—'
        const lRank = llmAvail ? (r.llm_rank > 0 ? `#${r.llm_rank}` : '—') : ''
        sections.push(`| ${r.sample_id} | ${r.query_type} | ${r.expected} | ${bRank}${llmAvail ? ` | ${lRank}` : ''} |`)
    }

    return sections.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const startTime = Date.now()
    console.log('=== Skill Recall Baseline Benchmark ===')
    console.log(`Skills dir: ${SKILLS_DIR}`)
    console.log(`Dataset:    ${DATASET_PATH}`)
    const llmProvider = CLAUDE_API_KEY ? 'Claude Haiku (Anthropic)' : OPENROUTER_API_KEY ? 'OpenRouter/DeepSeek' : DEEPSEEK_API_KEY ? 'DeepSeek direct' : 'none'
    console.log(`LLM:        ${SKIP_LLM ? 'SKIPPED (--skip-llm or no API key)' : llmProvider}`)
    console.log('')

    // Load skills
    const skills = await loadSkills()
    console.log(`Loaded ${skills.length} skills: ${skills.map(s => s.id).join(', ')}`)
    console.log('')

    // Load dataset
    const datasetRaw = await readFile(DATASET_PATH, 'utf-8')
    const dataset = JSON.parse(datasetRaw) as EvalSample[]
    console.log(`Dataset: ${dataset.length} samples (${dataset.filter(s => s.query_type === 'exact').length} exact, ${dataset.filter(s => s.query_type === 'near_synonym').length} near_synonym, ${dataset.filter(s => s.query_type === 'fuzzy').length} fuzzy)`)
    console.log('')

    // Build BM25 index
    const index = buildBM25Index(skills)
    console.log(`BM25 index built (${index.N} docs, avg length ${index.avgLen.toFixed(0)} tokens)`)
    console.log('')

    // Evaluate
    const results: SampleResult[] = []
    let llmErrors = 0

    for (let i = 0; i < dataset.length; i++) {
        const sample = dataset[i]!
        const prefix = `[${String(i + 1).padStart(2, '0')}/${dataset.length}] ${sample.id}`

        // BM25
        const bm25Ranked = bm25Retrieve(index, sample.query)
        const bm25Top5 = bm25Ranked.slice(0, 5).map(r => r.skillId)
        const bm25Rank = findRank(bm25Ranked, sample.expected_skill_id)

        // LLM
        let llmTop5: string[] = []
        let llmRank = 0

        if (!SKIP_LLM) {
            try {
                const llmRanked = await llmRetrieve(skills, sample.query)
                llmTop5 = llmRanked.slice(0, 5).map(r => r.skillId)
                llmRank = findRank(llmRanked, sample.expected_skill_id)
            } catch (err) {
                llmErrors++
                console.error(`  ${prefix} LLM error: ${err}`)
            }
        }

        results.push({
            sample_id: sample.id,
            query: sample.query,
            query_type: sample.query_type,
            expected: sample.expected_skill_id,
            bm25_top5: bm25Top5,
            llm_top5: llmTop5,
            bm25_rank: bm25Rank,
            llm_rank: llmRank,
        })

        const bStatus = bm25Rank > 0 && bm25Rank <= 3 ? '✅' : bm25Rank > 0 && bm25Rank <= 5 ? '⚠️ ' : '❌'
        const lStatus = SKIP_LLM ? '' : llmRank > 0 && llmRank <= 3 ? ' LLM✅' : llmRank > 0 && llmRank <= 5 ? ' LLM⚠️' : ' LLM❌'
        console.log(`${prefix} [${sample.query_type}] BM25#${bm25Rank}${bStatus}${lStatus}`)
    }
    console.log('')

    // Compute metrics
    const bm25Metrics = computeMetrics(results, 'bm25')
    const llmMetrics = SKIP_LLM ? null : computeMetrics(results, 'llm')

    // Print summary
    console.log('── BM25 Results ──────────────────────────────')
    console.log(`Recall@1: ${pct(bm25Metrics.recall1)}`)
    console.log(`Recall@3: ${pct(bm25Metrics.recall3)}`)
    console.log(`Recall@5: ${pct(bm25Metrics.recall5)}`)
    console.log(`MRR:      ${fmt3(bm25Metrics.mrr)}`)
    for (const qt of ['exact', 'near_synonym', 'fuzzy'] as QueryType[]) {
        const g = bm25Metrics.byType[qt]
        if (g) console.log(`  [${qt}] R@1=${pct(g.recall1)} R@3=${pct(g.recall3)} MRR=${fmt3(g.mrr)}`)
    }

    if (llmMetrics) {
        console.log('')
        console.log('── LLM (prompt-based) Results ────────────────')
        console.log(`Recall@1: ${pct(llmMetrics.recall1)}`)
        console.log(`Recall@3: ${pct(llmMetrics.recall3)}`)
        console.log(`Recall@5: ${pct(llmMetrics.recall5)}`)
        console.log(`MRR:      ${fmt3(llmMetrics.mrr)}`)
        for (const qt of ['exact', 'near_synonym', 'fuzzy'] as QueryType[]) {
            const g = llmMetrics.byType[qt]
            if (g) console.log(`  [${qt}] R@1=${pct(g.recall1)} R@3=${pct(g.recall3)} MRR=${fmt3(g.mrr)}`)
        }
        if (llmErrors > 0) console.log(`  (${llmErrors} LLM errors skipped)`)
    }

    // Decision
    console.log('')
    console.log('── Decision ──────────────────────────────────')
    const r3 = bm25Metrics.recall3
    if (r3 > 0.85) {
        console.log(`BM25 Recall@3=${pct(r3)} > 85% → 建议暂缓 Phase 3 GEPA（边际收益低）`)
    } else if (r3 < 0.50) {
        console.log(`BM25 Recall@3=${pct(r3)} < 50% → 先修 Phase 0，再评估 Phase 3`)
    } else if (r3 < 0.70) {
        console.log(`BM25 Recall@3=${pct(r3)} 50-70% → 有条件推进 Phase 3`)
    } else {
        console.log(`BM25 Recall@3=${pct(r3)} 70-85% → 可以推进 Phase 3`)
    }

    // Generate report
    const runDate = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const report = generateReport(results, bm25Metrics, llmMetrics, skills, runDate)
    await mkdir(dirname(REPORT_PATH), { recursive: true })
    await writeFile(REPORT_PATH, report, 'utf-8')
    console.log('')
    console.log(`Report: ${REPORT_PATH}`)
    console.log(`Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)
}

main().catch(err => {
    console.error('Fatal error:', err)
    process.exit(1)
})
