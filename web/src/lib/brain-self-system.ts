export type BrainSelfSystemConfig = {
    enabled: boolean
    defaultProfileId: string | null
    memoryProvider: 'yoho-memory' | 'none'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

export function extractSelfSystemConfig(extra: unknown): BrainSelfSystemConfig {
    if (!isRecord(extra) || !isRecord(extra.selfSystem)) {
        return {
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory',
        }
    }

    const selfSystem = extra.selfSystem
    return {
        enabled: selfSystem.enabled === true,
        defaultProfileId: typeof selfSystem.defaultProfileId === 'string' && selfSystem.defaultProfileId.trim().length > 0
            ? selfSystem.defaultProfileId
            : null,
        memoryProvider: selfSystem.memoryProvider === 'none' ? 'none' : 'yoho-memory',
    }
}

export function applySelfSystemConfigPatch(
    current: BrainSelfSystemConfig,
    patch: Partial<BrainSelfSystemConfig>
): BrainSelfSystemConfig {
    return {
        ...current,
        ...patch,
    }
}

export function canEnableSelfSystem(config: BrainSelfSystemConfig): boolean {
    return Boolean(config.defaultProfileId)
}

export function isValidSelfSystemConfig(config: BrainSelfSystemConfig): boolean {
    return !config.enabled || canEnableSelfSystem(config)
}
