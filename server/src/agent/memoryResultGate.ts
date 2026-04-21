export type SkillSearchConsumptionDecision = {
    directUseAllowed: boolean
    reason: string
    suggestedNextAction: string | null
    suggestDiscover: boolean
    hasLocalMatch: boolean
    confidence: number | null
    scopeMatched?: boolean | null
    unmatchedScopeReasons?: string[]
}

export type RecallConsumptionDecision = {
    reliable: boolean
    reason: string
    confidence: number | null
    resultCount: number | null
    scopeMatched?: boolean | null
    unmatchedScopeReasons?: string[]
}

const SKILL_SEARCH_MIN_CONFIDENCE = 0.65
const RECALL_MIN_CONFIDENCE = 0.5

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.flatMap(item => typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : [])
        : []
}

function parseJsonText(value: string): unknown {
    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

export function unwrapMcpTextPayload(value: unknown): unknown {
    if (typeof value === 'string') {
        return parseJsonText(value)
    }

    if (isRecord(value) && Array.isArray(value.content)) {
        const textBlocks = value.content
            .map(block => isRecord(block) && block.type === 'text' ? readString(block.text) : null)
            .filter((text): text is string => Boolean(text))
        if (textBlocks.length === 1) {
            return parseJsonText(textBlocks[0])
        }
        if (textBlocks.length > 1) {
            return parseJsonText(textBlocks.join('\n'))
        }
    }

    return value
}

function readConfidence(payload: Record<string, unknown>): number | null {
    const direct = readNumber(payload.confidence)
        ?? readNumber(payload.maxConfidence)
        ?? readNumber(payload.bestConfidence)
    if (direct !== null) return direct

    for (const key of ['bestMatch', 'topMatch', 'match']) {
        const nested = payload[key]
        if (isRecord(nested)) {
            const nestedConfidence = readNumber(nested.confidence) ?? readNumber(nested.score)
            if (nestedConfidence !== null) return nestedConfidence
        }
    }

    for (const key of ['matches', 'results', 'items']) {
        const values = payload[key]
        if (!Array.isArray(values)) continue
        const confidences = values
            .map(item => isRecord(item) ? (readNumber(item.confidence) ?? readNumber(item.score)) : null)
            .filter((confidence): confidence is number => confidence !== null)
        if (confidences.length > 0) {
            return Math.max(...confidences)
        }
    }

    return null
}

function readDeclaredResultCount(payload: Record<string, unknown>): number | null {
    return readNumber(payload.resultCount)
        ?? readNumber(payload.resultsCount)
        ?? readNumber(payload.count)
        ?? readNumber(payload.filesSearched)
        ?? readNumber(payload.files_searched)
}

function readResultCount(payload: Record<string, unknown>): number | null {
    const direct = readDeclaredResultCount(payload)
    if (direct !== null) return direct

    for (const key of ['results', 'matches', 'sources', 'items']) {
        const values = payload[key]
        if (Array.isArray(values)) return values.length
    }

    return null
}

function readScopeDecision(payload: Record<string, unknown>): { matched: boolean | null; unmatchedReasons: string[] } {
    const scope = isRecord(payload.scope) ? payload.scope : null
    const matched = scope
        ? readBoolean(scope.matched)
            ?? readBoolean(scope.isMatched)
            ?? readBoolean(scope.is_match)
        : readBoolean(payload.scopeMatched)
            ?? readBoolean(payload.scope_matched)
    const unmatchedReasons = scope
        ? [
            ...readStringArray(scope.unmatchedReasons),
            ...readStringArray(scope.unmatched_reasons),
            ...readStringArray(scope.unmatched),
        ]
        : [
            ...readStringArray(payload.unmatchedScopeReasons),
            ...readStringArray(payload.unmatched_scope_reasons),
        ]

    return { matched, unmatchedReasons }
}

export function evaluateSkillSearchConsumption(value: unknown): SkillSearchConsumptionDecision {
    const payload = unwrapMcpTextPayload(value)
    if (!isRecord(payload)) {
        return {
            directUseAllowed: false,
            reason: 'skill_search 未返回结构化结果，不能直接引用或自动 skill_get',
            suggestedNextAction: null,
            suggestDiscover: false,
            hasLocalMatch: false,
            confidence: null,
        }
    }

    const suggestedNextAction = readString(payload.suggestedNextAction)
        ?? readString(payload.suggested_next_action)
        ?? null
    const suggestDiscover = readBoolean(payload.suggestDiscover)
        ?? readBoolean(payload.suggest_discover)
        ?? suggestedNextAction === 'discover'
    const hasLocalMatch = readBoolean(payload.hasLocalMatch)
        ?? readBoolean(payload.has_local_match)
        ?? null
    const confidence = readConfidence(payload)
    const explicitDirectUseAllowed = readBoolean(payload.directUseAllowed)
        ?? readBoolean(payload.direct_use_allowed)
    const scope = readScopeDecision(payload)

    if (explicitDirectUseAllowed === false) {
        return {
            directUseAllowed: false,
            reason: 'directUseAllowed=false，服务端明确禁止直接引用或自动 skill_get',
            suggestedNextAction,
            suggestDiscover,
            hasLocalMatch: hasLocalMatch ?? false,
            confidence,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (scope.matched === false || scope.unmatchedReasons.length > 0) {
        return {
            directUseAllowed: false,
            reason: scope.unmatchedReasons.length > 0
                ? `skill_search scope 不匹配：${scope.unmatchedReasons.join('；')}`
                : 'skill_search scope.matched=false，不能直接引用或自动 skill_get',
            suggestedNextAction,
            suggestDiscover,
            hasLocalMatch: hasLocalMatch ?? false,
            confidence,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (explicitDirectUseAllowed !== true && suggestedNextAction !== 'use_results') {
        return {
            directUseAllowed: false,
            reason: `suggestedNextAction=${suggestedNextAction ?? 'missing'}，必须视为不可直接引用`,
            suggestedNextAction,
            suggestDiscover,
            hasLocalMatch: hasLocalMatch ?? false,
            confidence,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (hasLocalMatch !== true) {
        return {
            directUseAllowed: false,
            reason: `hasLocalMatch=${hasLocalMatch === null ? 'missing' : 'false'}，不能直接引用或自动 skill_get`,
            suggestedNextAction,
            suggestDiscover,
            hasLocalMatch: hasLocalMatch ?? false,
            confidence,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (confidence === null || confidence < SKILL_SEARCH_MIN_CONFIDENCE) {
        return {
            directUseAllowed: false,
            reason: `confidence=${confidence ?? 'missing'}，低于 ${SKILL_SEARCH_MIN_CONFIDENCE}`,
            suggestedNextAction,
            suggestDiscover,
            hasLocalMatch: true,
            confidence,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    return {
        directUseAllowed: true,
        reason: 'use_results + hasLocalMatch + confidence 足够，可作为候选 skill 直接使用',
        suggestedNextAction,
        suggestDiscover,
        hasLocalMatch: true,
        confidence,
        scopeMatched: scope.matched,
        unmatchedScopeReasons: scope.unmatchedReasons,
    }
}

export function evaluateRecallConsumption(
    value: unknown,
    options?: {
        matchTerms?: string[]
        minConfidence?: number
        requireResultCount?: boolean
    },
): RecallConsumptionDecision {
    const payload = unwrapMcpTextPayload(value)
    if (!isRecord(payload)) {
        return {
            reliable: false,
            reason: 'recall 未返回结构化结果，不能自动注入为事实',
            confidence: null,
            resultCount: null,
        }
    }

    const answer = readString(payload.answer)
        ?? readString(payload.summary)
        ?? readString(payload.content)
    const confidence = readConfidence(payload)
    const requireResultCount = options?.requireResultCount ?? true
    const resultCount = requireResultCount ? readDeclaredResultCount(payload) : readResultCount(payload)
    const minConfidence = options?.minConfidence ?? RECALL_MIN_CONFIDENCE
    const explicitDirectlyUsable = readBoolean(payload.isDirectlyUsable)
        ?? readBoolean(payload.is_directly_usable)
        ?? readBoolean(payload.directUseAllowed)
        ?? readBoolean(payload.direct_use_allowed)
    const scope = readScopeDecision(payload)

    if (explicitDirectlyUsable === false) {
        return {
            reliable: false,
            reason: 'isDirectlyUsable=false，服务端明确禁止直接注入为事实',
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (scope.matched === false || scope.unmatchedReasons.length > 0) {
        return {
            reliable: false,
            reason: scope.unmatchedReasons.length > 0
                ? `recall scope 不匹配：${scope.unmatchedReasons.join('；')}`
                : 'recall scope.matched=false，不能自动注入为事实',
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (!answer) {
        return {
            reliable: false,
            reason: 'recall answer 为空',
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (requireResultCount && resultCount === null) {
        return {
            reliable: false,
            reason: 'recall 缺少 resultCount/filesSearched，不能确认结果数',
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (requireResultCount && resultCount !== null && resultCount <= 0) {
        return {
            reliable: false,
            reason: 'recall 结果数为 0',
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    if (confidence !== null && confidence < minConfidence) {
        return {
            reliable: false,
            reason: `recall confidence=${confidence}，低于 ${minConfidence}`,
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
        }
    }

    const matchTerms = (options?.matchTerms ?? [])
        .map(term => term.trim().toLowerCase())
        .filter(term => term.length > 0)
    if (matchTerms.length > 0) {
        const sources = Array.isArray(payload.sources) ? payload.sources : []
        const sourceText = sources
            .map(source => typeof source === 'string' ? source : JSON.stringify(source))
            .join('\n')
        const searchable = `${answer}\n${sourceText}`.toLowerCase()
        if (!matchTerms.some(term => searchable.includes(term))) {
            return {
                reliable: false,
                reason: 'recall 结果缺少当前 scope / identity 匹配项',
                confidence,
                resultCount,
                scopeMatched: scope.matched,
                unmatchedScopeReasons: scope.unmatchedReasons,
            }
        }
    }

    return {
        reliable: true,
        reason: 'recall 结果满足基础可靠性门槛',
        confidence,
        resultCount,
        scopeMatched: scope.matched,
        unmatchedScopeReasons: scope.unmatchedReasons,
    }
}
