import type { ModelMode, ModelReasoningEffort } from '@/types/api'

type SessionModelLabelInput = {
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
    fastMode?: boolean
    runtimeModel?: string | null
    runtimeModelReasoningEffort?: ModelReasoningEffort | null
}

export function formatSessionModelLabel(input: SessionModelLabelInput): string | null {
    const runtimeModel = input.runtimeModel?.trim()
    const displayModel = input.modelMode && input.modelMode !== 'default'
        ? input.modelMode
        : runtimeModel

    if (!displayModel) {
        return input.fastMode ? '\u21af Fast' : null
    }

    const parts: string[] = [displayModel]
    const displayEffort = input.modelReasoningEffort ?? input.runtimeModelReasoningEffort ?? undefined
    if (displayEffort) {
        parts.push(`(${displayEffort})`)
    }
    if (input.fastMode) {
        parts.push('\u21af')
    }
    return parts.join(' ')
}
