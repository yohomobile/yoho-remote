import { z } from 'zod'

// Phase 3D Eval Harness：金标集用于在策略/prompt 变更前后做回归检测。
// 设计稿：docs/design/k1-phase3-actor-aware-brain.md §4.D
// 约束：
// - 所有 person 名称、邮箱、身份锚点必须脱敏。
// - 分数不自动阻断部署，只作为人工 review 的信号。

export type EvalDimension =
    | 'factual_consistency'     // 同一事实是否在不同 plan / scope 下保持一致
    | 'wrong_memory_write'      // 是否把不该写的内容写进了 personal/team
    | 'pseudo_familiarity'      // 伪熟悉：把陌生人当熟人
    | 'pseudo_empathy'          // 伪共情：编造情绪关怀
    | 'token_cost'              // token 消耗
    | 'latency'                 // 延迟（ms）

export const goldenItemSchema = z.object({
    id: z.string().min(1),
    title: z.string(),
    category: z.enum([
        'communication_plan',
        'team_recall',
        'conflict_resolution',
        'affect_routing',
        'factual_invariance',
    ]),
    input: z.object({
        personId: z.string().min(1),
        orgId: z.string().nullable(),
        scope: z.enum(['personal', 'team']).optional(),
        userMessage: z.string(),
        priorContext: z.array(z.string()).optional(),
    }),
    expect: z.object({
        mustContain: z.array(z.string()).optional(),
        mustNotContain: z.array(z.string()).optional(),
        mustNotMatch: z.array(z.string()).optional(),
        maxTokens: z.number().int().positive().optional(),
        maxLatencyMs: z.number().int().positive().optional(),
    }),
    dimensions: z.array(z.enum([
        'factual_consistency',
        'wrong_memory_write',
        'pseudo_familiarity',
        'pseudo_empathy',
        'token_cost',
        'latency',
    ])),
    notes: z.string().optional(),
    redactedFrom: z.string().optional(),
})

export type GoldenItem = z.infer<typeof goldenItemSchema>

export const goldenSetSchema = z.object({
    version: z.number().int().positive(),
    createdAt: z.number().int(),
    items: z.array(goldenItemSchema),
})

export type GoldenSet = z.infer<typeof goldenSetSchema>

// 脱敏规则：把真实的人名 / email / employee code 替换成稳定的占位符。
// 目标是在 git 存档时不会泄露真实身份，但仍保留结构供 eval 使用。
export type RedactionRule = {
    pattern: RegExp
    replacement: string
}

export const defaultRedactionRules: RedactionRule[] = [
    { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '<email>' },
    { pattern: /person-[a-f0-9]{6,}/g, replacement: 'person-<redacted>' },
    { pattern: /org-[a-f0-9]{6,}/g, replacement: 'org-<redacted>' },
    { pattern: /sub-[A-Za-z0-9-]{6,}/g, replacement: 'sub-<redacted>' },
]

export function redactText(text: string, rules: RedactionRule[] = defaultRedactionRules): string {
    let out = text
    for (const rule of rules) {
        out = out.replace(rule.pattern, rule.replacement)
    }
    return out
}

export function redactGoldenItem(item: GoldenItem, rules: RedactionRule[] = defaultRedactionRules): GoldenItem {
    return {
        ...item,
        input: {
            ...item.input,
            userMessage: redactText(item.input.userMessage, rules),
            priorContext: item.input.priorContext?.map((line) => redactText(line, rules)),
        },
        notes: item.notes ? redactText(item.notes, rules) : undefined,
    }
}
