import type { EnhancedMode } from '@/claude/loop';

export const DEFAULT_OPENAI_FALLBACK_MODEL = 'gpt-5.2';

function normalizeModel(model: string | undefined): string | null {
    const trimmed = model?.trim();
    return trimmed ? trimmed : null;
}

export function shouldUseOpenAiOverloadFallback(sessionSource: string | null | undefined): boolean {
    const source = sessionSource?.trim().toLowerCase();
    if (!source) {
        return false;
    }
    if (source === 'brain' || source.startsWith('brain-')) {
        return true;
    }
    if (source === 'openclaw' || source.startsWith('openclaw-')) {
        return true;
    }
    return false;
}

export function isClaudeOverloadError(errorMessage: string): boolean {
    if (!errorMessage) {
        return false;
    }
    return (
        /server\s+overloaded/i.test(errorMessage)
        || /"code"\s*:\s*"E012"/i.test(errorMessage)
        || /\bE012\b/.test(errorMessage)
        || /"status"\s*:\s*529/i.test(errorMessage)
        || /\bstatus\s*[:=]\s*529\b/i.test(errorMessage)
    );
}

export function resolveOpenAiOverloadFallbackMode(
    currentMode: EnhancedMode,
    openAiModel: string
): { mode: EnhancedMode; strategy: 'set_fallback_model' | 'switch_primary_model' } | null {
    const targetModel = normalizeModel(openAiModel);
    if (!targetModel) {
        return null;
    }

    const currentModel = normalizeModel(currentMode.model);
    const currentFallbackModel = normalizeModel(currentMode.fallbackModel);

    if (currentModel === targetModel) {
        return null;
    }

    if (currentFallbackModel !== targetModel) {
        return {
            mode: {
                ...currentMode,
                fallbackModel: targetModel
            },
            strategy: 'set_fallback_model'
        };
    }

    return {
        mode: {
            ...currentMode,
            model: targetModel,
            fallbackModel: undefined
        },
        strategy: 'switch_primary_model'
    };
}
