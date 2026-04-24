import { z } from 'zod'

export const BRAIN_CLAUDE_CHILD_MODELS = ['sonnet', 'opus', 'opus-4-7'] as const
export const BRAIN_CODEX_CHILD_MODELS = [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
] as const

export type BrainClaudeChildModel = typeof BRAIN_CLAUDE_CHILD_MODELS[number]
export type BrainCodexChildModel = typeof BRAIN_CODEX_CHILD_MODELS[number]
export type BrainChildAgent = 'claude' | 'codex'

export type BrainSessionPreferences = {
    machineSelection: {
        mode: 'auto' | 'manual'
        machineId: string
    }
    childModels: {
        claude: {
            allowed: BrainClaudeChildModel[]
            defaultModel: BrainClaudeChildModel
        }
        codex: {
            allowed: BrainCodexChildModel[]
            defaultModel: BrainCodexChildModel
        }
    }
}

export type BrainSessionPreferencesRepairRule =
    | 'rewrite_request_shape'
    | 'backfill_machine_id_from_metadata'
    | 'normalize_claude_allowed_models'
    | 'normalize_codex_allowed_models'
    | 'derive_claude_default_model'
    | 'derive_codex_default_model'

export type BrainSessionPreferencesRepairResult =
    | {
        status: 'valid' | 'migrated'
        preferences: BrainSessionPreferences
        rules: BrainSessionPreferencesRepairRule[]
    }
    | {
        status: 'manual'
        reasons: string[]
    }

const BrainSessionPreferencesSchema: z.ZodType<BrainSessionPreferences> = z.object({
    machineSelection: z.object({
        mode: z.enum(['auto', 'manual']),
        machineId: z.string().min(1),
    }),
    childModels: z.object({
        claude: z.object({
            allowed: z.array(z.enum(BRAIN_CLAUDE_CHILD_MODELS)),
            defaultModel: z.enum(BRAIN_CLAUDE_CHILD_MODELS),
        }),
        codex: z.object({
            allowed: z.array(z.enum(BRAIN_CODEX_CHILD_MODELS)),
            defaultModel: z.enum(BRAIN_CODEX_CHILD_MODELS),
        }),
    }),
})

function normalizeCodexModelValue(value: string): string {
    return value.replace(/^openai\//, '').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function parseMachineSelectionMode(value: unknown): 'auto' | 'manual' | undefined {
    return value === 'auto' || value === 'manual' ? value : undefined
}

function normalizeAllowedList<T extends string>(
    values: readonly string[] | null | undefined,
    allowedValues: readonly T[],
): T[] {
    // `undefined` / `null` means "use defaults"; an explicit empty array means
    // the caller intentionally disabled that child agent.
    if (!values) {
        return [...allowedValues]
    }
    const allowed = new Set(allowedValues)
    const normalized = values
        .map((value) => value.trim())
        .filter((value): value is T => allowed.has(value as T))
    return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function resolveDefaultModel<T extends string>(
    allowed: readonly T[],
    preferred: T,
    fallbackPool: readonly T[],
): T {
    if (allowed.includes(preferred)) {
        return preferred
    }
    for (const candidate of fallbackPool) {
        if (allowed.includes(candidate)) {
            return candidate
        }
    }
    return allowed[0] ?? preferred
}

export function parseBrainSessionPreferences(value: unknown): BrainSessionPreferences | null {
    const parsed = BrainSessionPreferencesSchema.safeParse(value)
    if (!parsed.success) {
        return null
    }
    return parsed.data
}

export function buildBrainSessionPreferences(input: {
    machineSelectionMode: 'auto' | 'manual'
    machineId: string
    childClaudeModels?: readonly string[] | null
    childCodexModels?: readonly string[] | null
}): BrainSessionPreferences {
    const allowedClaude = normalizeAllowedList(input.childClaudeModels, BRAIN_CLAUDE_CHILD_MODELS)
    const allowedCodex = normalizeAllowedList(
        input.childCodexModels?.map(normalizeCodexModelValue),
        BRAIN_CODEX_CHILD_MODELS,
    )

    return {
        machineSelection: {
            mode: input.machineSelectionMode,
            machineId: input.machineId,
        },
        childModels: {
            claude: {
                allowed: allowedClaude,
                defaultModel: resolveDefaultModel(allowedClaude, 'sonnet', BRAIN_CLAUDE_CHILD_MODELS),
            },
            codex: {
                allowed: allowedCodex,
                defaultModel: resolveDefaultModel(allowedCodex, 'gpt-5.4', BRAIN_CODEX_CHILD_MODELS),
            },
        },
    }
}

type AllowedListRepair<T extends string> =
    | {
        ok: true
        allowed: T[]
        normalized: boolean
    }
    | {
        ok: false
        reason: string
    }

function repairAllowedList<T extends string>(args: {
    label: string
    raw: unknown
    allowedValues: readonly T[]
    normalizeValue?: (value: string) => string
}): AllowedListRepair<T> {
    if (!Array.isArray(args.raw)) {
        return { ok: false, reason: `${args.label} 缺少 allowed 数组` }
    }

    const stringValues = args.raw.filter((value): value is string => typeof value === 'string')
    if (stringValues.length !== args.raw.length) {
        return { ok: false, reason: `${args.label} allowed 数组包含非字符串值` }
    }

    const normalizeValue = args.normalizeValue ?? ((value: string) => value.trim())
    const normalizedValues = stringValues.map(normalizeValue)
    const allowedSet = new Set(args.allowedValues)
    const unsupportedValues = normalizedValues.filter((value): value is string => !allowedSet.has(value as T))
    if (unsupportedValues.length > 0) {
        return {
            ok: false,
            reason: `${args.label} allowed 数组包含无法安全迁移的模型: ${Array.from(new Set(unsupportedValues)).join(', ')}`,
        }
    }

    const uniqueValues = Array.from(new Set(normalizedValues as T[]))
    const normalized = uniqueValues.length !== stringValues.length
        || normalizedValues.some((value, index) => value !== stringValues[index]?.trim())

    return {
        ok: true,
        allowed: uniqueValues,
        normalized,
    }
}

function resolveRepairedDefaultModel<T extends string>(args: {
    raw: unknown
    allowed: readonly T[]
    preferred: T
    fallbackPool: readonly T[]
    normalizeValue?: (value: string) => string
}): {
    value: T
    derived: boolean
} {
    const normalizeValue = args.normalizeValue ?? ((value: string) => value.trim())
    const rawValue = typeof args.raw === 'string' ? normalizeValue(args.raw) : undefined
    if (rawValue && args.allowed.includes(rawValue as T)) {
        return {
            value: rawValue as T,
            derived: false,
        }
    }
    return {
        value: resolveDefaultModel(args.allowed, args.preferred, args.fallbackPool),
        derived: true,
    }
}

function sortReasons(reasons: Iterable<string>): string[] {
    return Array.from(new Set(reasons))
}

function repairCanonicalishBrainSessionPreferences(
    value: Record<string, unknown>,
    fallbackMachineId?: string,
): BrainSessionPreferencesRepairResult {
    const reasons = new Set<string>()
    const rules = new Set<BrainSessionPreferencesRepairRule>()
    const machineSelection = isRecord(value.machineSelection) ? value.machineSelection : null
    const machineSelectionMode = machineSelection ? parseMachineSelectionMode(machineSelection.mode) : undefined
    if (!machineSelectionMode) {
        reasons.add('缺少可识别的 machineSelection.mode')
    }

    const nestedMachineId = machineSelection ? asNonEmptyString(machineSelection.machineId) : undefined
    const resolvedMachineId = nestedMachineId ?? fallbackMachineId
    if (!resolvedMachineId) {
        reasons.add('缺少 machineSelection.machineId，且没有可用的 session metadata.machineId 作为回填')
    }
    if (!nestedMachineId && resolvedMachineId) {
        rules.add('backfill_machine_id_from_metadata')
    }

    const childModels = isRecord(value.childModels) ? value.childModels : null
    const rawClaude = childModels && isRecord(childModels.claude) ? childModels.claude : null
    const rawCodex = childModels && isRecord(childModels.codex) ? childModels.codex : null
    if (!rawClaude) {
        reasons.add('缺少 childModels.claude 配置')
    }
    if (!rawCodex) {
        reasons.add('缺少 childModels.codex 配置')
    }
    if (reasons.size > 0) {
        return { status: 'manual', reasons: sortReasons(reasons) }
    }

    const repairedRawClaude = rawClaude!
    const repairedRawCodex = rawCodex!

    const repairedClaudeAllowed = repairAllowedList({
        label: 'childModels.claude',
        raw: repairedRawClaude.allowed,
        allowedValues: BRAIN_CLAUDE_CHILD_MODELS,
    })
    if (!repairedClaudeAllowed.ok) {
        reasons.add(repairedClaudeAllowed.reason)
    } else if (repairedClaudeAllowed.normalized) {
        rules.add('normalize_claude_allowed_models')
    }

    const repairedCodexAllowed = repairAllowedList({
        label: 'childModels.codex',
        raw: repairedRawCodex.allowed,
        allowedValues: BRAIN_CODEX_CHILD_MODELS,
        normalizeValue: normalizeCodexModelValue,
    })
    if (!repairedCodexAllowed.ok) {
        reasons.add(repairedCodexAllowed.reason)
    } else if (repairedCodexAllowed.normalized) {
        rules.add('normalize_codex_allowed_models')
    }

    if (reasons.size > 0 || !repairedClaudeAllowed.ok || !repairedCodexAllowed.ok) {
        return { status: 'manual', reasons: sortReasons(reasons) }
    }

    const repairedClaudeDefault = resolveRepairedDefaultModel({
        raw: repairedRawClaude.defaultModel,
        allowed: repairedClaudeAllowed.allowed,
        preferred: 'sonnet',
        fallbackPool: BRAIN_CLAUDE_CHILD_MODELS,
    })
    if (repairedClaudeDefault.derived) {
        rules.add('derive_claude_default_model')
    }

    const repairedCodexDefault = resolveRepairedDefaultModel({
        raw: repairedRawCodex.defaultModel,
        allowed: repairedCodexAllowed.allowed,
        preferred: 'gpt-5.4',
        fallbackPool: BRAIN_CODEX_CHILD_MODELS,
        normalizeValue: normalizeCodexModelValue,
    })
    if (repairedCodexDefault.derived) {
        rules.add('derive_codex_default_model')
    }

    return {
        status: 'migrated',
        preferences: {
            machineSelection: {
                mode: machineSelectionMode!,
                machineId: resolvedMachineId!,
            },
            childModels: {
                claude: {
                    allowed: repairedClaudeAllowed.allowed,
                    defaultModel: repairedClaudeDefault.value,
                },
                codex: {
                    allowed: repairedCodexAllowed.allowed,
                    defaultModel: repairedCodexDefault.value,
                },
            },
        },
        rules: Array.from(rules),
    }
}

/**
 * Conservative legacy repair helper for offline tooling / audits.
 *
 * It only auto-migrates shapes whose semantics are fully reconstructible from
 * the payload itself (or an explicit outer metadata.machineId fallback). It
 * intentionally refuses to "repair" canonical-looking values produced by older
 * semantic bugs, such as empty allowlists being expanded to full allowlists or
 * child agents being trimmed by runtime availability, because the original user
 * intent cannot be recovered from brainPreferences alone.
 */
export function repairLegacyBrainSessionPreferences(
    value: unknown,
    options?: {
        fallbackMachineId?: string | null
    }
): BrainSessionPreferencesRepairResult {
    const parsed = parseBrainSessionPreferences(value)
    if (parsed) {
        return {
            status: 'valid',
            preferences: parsed,
            rules: [],
        }
    }

    if (!isRecord(value)) {
        return {
            status: 'manual',
            reasons: ['brainPreferences 不是对象，无法自动修复'],
        }
    }

    const fallbackMachineId = asNonEmptyString(options?.fallbackMachineId)
    const hasRequestShapeFields = 'machineSelectionMode' in value
        || 'childClaudeModels' in value
        || 'childCodexModels' in value
    if (hasRequestShapeFields) {
        const machineSelectionMode = parseMachineSelectionMode(value.machineSelectionMode)
        const machineId = asNonEmptyString(value.machineId) ?? fallbackMachineId
        if (!machineSelectionMode || !machineId) {
            return {
                status: 'manual',
                reasons: sortReasons([
                    !machineSelectionMode ? '旧 request 形状缺少合法的 machineSelectionMode' : '',
                    !machineId ? '旧 request 形状缺少 machineId，且没有可用的 session metadata.machineId 作为回填' : '',
                ].filter(Boolean)),
            }
        }

        const rules = new Set<BrainSessionPreferencesRepairRule>(['rewrite_request_shape'])
        if (!asNonEmptyString(value.machineId) && machineId) {
            rules.add('backfill_machine_id_from_metadata')
        }

        let repairedChildClaudeModels: string[] | undefined
        const childClaudeModels = value.childClaudeModels
        if (childClaudeModels !== undefined) {
            const repairedClaude = repairAllowedList({
                label: 'childClaudeModels',
                raw: childClaudeModels,
                allowedValues: BRAIN_CLAUDE_CHILD_MODELS,
            })
            if (!repairedClaude.ok) {
                return { status: 'manual', reasons: [repairedClaude.reason] }
            }
            if (repairedClaude.normalized) {
                rules.add('normalize_claude_allowed_models')
            }
            repairedChildClaudeModels = repairedClaude.allowed
        }

        let repairedChildCodexModels: string[] | undefined
        const childCodexModels = value.childCodexModels
        if (childCodexModels !== undefined) {
            const repairedCodex = repairAllowedList({
                label: 'childCodexModels',
                raw: childCodexModels,
                allowedValues: BRAIN_CODEX_CHILD_MODELS,
                normalizeValue: normalizeCodexModelValue,
            })
            if (!repairedCodex.ok) {
                return { status: 'manual', reasons: [repairedCodex.reason] }
            }
            if (repairedCodex.normalized) {
                rules.add('normalize_codex_allowed_models')
            }
            repairedChildCodexModels = repairedCodex.allowed
        }
        rules.add('derive_claude_default_model')
        rules.add('derive_codex_default_model')

        return {
            status: 'migrated',
            preferences: buildBrainSessionPreferences({
                machineSelectionMode,
                machineId,
                childClaudeModels: repairedChildClaudeModels,
                childCodexModels: repairedChildCodexModels,
            }),
            rules: Array.from(rules),
        }
    }

    return repairCanonicalishBrainSessionPreferences(value, fallbackMachineId)
}

export function repairBrainSessionPreferencesFromMetadata(
    metadata: Record<string, unknown> | null | undefined
): BrainSessionPreferencesRepairResult | null {
    if (!metadata || metadata.brainPreferences === undefined) {
        return null
    }

    return repairLegacyBrainSessionPreferences(metadata.brainPreferences, {
        fallbackMachineId: asNonEmptyString(metadata.machineId),
    })
}

export function extractBrainSessionPreferencesFromMetadata(
    metadata: Record<string, unknown> | null | undefined
): BrainSessionPreferences | null {
    if (!metadata) {
        return null
    }
    return parseBrainSessionPreferences(metadata['brainPreferences'])
}

export function extractBrainChildModelDefaults(
    extra: Record<string, unknown> | null | undefined
): {
    childClaudeModels?: BrainClaudeChildModel[]
    childCodexModels?: BrainCodexChildModel[]
} {
    if (!extra) {
        return {}
    }

    const childClaudeModels = normalizeAllowedList(
        Array.isArray(extra['childClaudeModels']) ? extra['childClaudeModels'].filter((value): value is string => typeof value === 'string') : null,
        BRAIN_CLAUDE_CHILD_MODELS,
    )
    const childCodexModels = normalizeAllowedList(
        Array.isArray(extra['childCodexModels'])
            ? extra['childCodexModels']
                .filter((value): value is string => typeof value === 'string')
                .map(normalizeCodexModelValue)
            : null,
        BRAIN_CODEX_CHILD_MODELS,
    )

    return {
        childClaudeModels,
        childCodexModels,
    }
}

export function getAllowedBrainChildAgents(preferences: BrainSessionPreferences | null): BrainChildAgent[] {
    if (!preferences) {
        return ['claude', 'codex']
    }

    const result: BrainChildAgent[] = []
    if (preferences.childModels.claude.allowed.length > 0) {
        result.push('claude')
    }
    if (preferences.childModels.codex.allowed.length > 0) {
        result.push('codex')
    }
    return result
}

export function resolveBrainSpawnPermissionMode(agent: BrainChildAgent): 'bypassPermissions' | 'yolo' {
    return agent === 'claude' ? 'bypassPermissions' : 'yolo'
}
