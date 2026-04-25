import type { IStore } from './store/interface'
import { parseBrainSessionPreferences, type BrainSessionPreferences } from './brain/brainSessionPreferences'
import {
    getSessionMetadataInvariantError,
    normalizeSessionMetadataInvariants,
} from './sessionSourcePolicy'
import { pickDefaultTokenSourceForAgent, resolveTokenSourceForAgent } from './web/tokenSources'

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }

    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type ResumeSpawnMetadata = {
    source?: string
    caller?: string
    mainSessionId?: string
    brainPreferences?: BrainSessionPreferences
}

export function extractResumeSpawnMetadata(metadata: unknown): ResumeSpawnMetadata {
    const invariantError = getSessionMetadataInvariantError(metadata)
    if (invariantError) {
        return {}
    }

    const normalizedMetadata = normalizeSessionMetadataInvariants(metadata)
    if (!isRecord(normalizedMetadata)) {
        return {}
    }

    const source = asNonEmptyString(normalizedMetadata.source)
    const caller = asNonEmptyString(normalizedMetadata.caller)
    const mainSessionId = asNonEmptyString(normalizedMetadata.mainSessionId)
    const rawBrainPreferences = normalizedMetadata.brainPreferences
    const brainPreferences = rawBrainPreferences === undefined
        ? undefined
        : parseBrainSessionPreferences(rawBrainPreferences) ?? undefined

    return {
        ...(source ? { source } : {}),
        ...(caller ? { caller } : {}),
        ...(mainSessionId ? { mainSessionId } : {}),
        ...(brainPreferences ? { brainPreferences } : {}),
    }
}

export function hasInvalidResumeBrainPreferences(metadata: unknown): boolean {
    const normalizedMetadata = normalizeSessionMetadataInvariants(metadata)
    if (!isRecord(normalizedMetadata) || normalizedMetadata.brainPreferences === undefined) {
        return false
    }
    return parseBrainSessionPreferences(normalizedMetadata.brainPreferences) === null
}

export function getInvalidResumeMetadataReason(metadata: unknown): string | null {
    const invariantError = getSessionMetadataInvariantError(metadata)
    if (invariantError) {
        return invariantError
    }
    if (hasInvalidResumeBrainPreferences(metadata)) {
        return 'Session has invalid brainPreferences metadata; repair it before resuming'
    }
    return null
}

export type ResumeSpawnExtras = {
    yolo?: boolean
    claudeSettingsType?: 'litellm' | 'claude'
    claudeAgent?: string
}

/**
 * Extract spawn-time configuration that the CLI persisted into session metadata
 * so that resume paths (manual / refresh / auto-resume) can reapply the same
 * flags as the original spawn. claudeAgent piggybacks on the existing
 * `runtimeAgent` field that runClaude already populates from `--agent`.
 */
export function extractResumeSpawnExtras(metadata: unknown): ResumeSpawnExtras {
    if (!isRecord(metadata)) {
        return {}
    }

    const yolo = metadata.yolo === true ? true : undefined
    const rawSettingsType = asNonEmptyString(metadata.claudeSettingsType)
    const claudeSettingsType: 'litellm' | 'claude' | undefined =
        rawSettingsType === 'litellm' || rawSettingsType === 'claude' ? rawSettingsType : undefined
    const claudeAgent = asNonEmptyString(metadata.runtimeAgent)

    return {
        ...(yolo ? { yolo: true } : {}),
        ...(claudeSettingsType ? { claudeSettingsType } : {}),
        ...(claudeAgent ? { claudeAgent } : {}),
    }
}

function readTokenSourceIdFromMetadata(metadata: unknown): string | undefined {
    if (!isRecord(metadata)) return undefined
    return asNonEmptyString(metadata.tokenSourceId)
}

export type ResumeTokenSourceSpawnOptions = {
    tokenSourceId: string
    tokenSourceName: string
    tokenSourceType: 'claude' | 'codex'
    tokenSourceBaseUrl: string
    tokenSourceApiKey: string
}

/**
 * Resolve the Token Source attached to a resuming session so the CLI daemon
 * can re-apply ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY (Claude) or
 * model_provider config (Codex) for the resumed process. Returns null when
 * the session was never created with a Token Source, when orgId is missing,
 * or when the Token Source no longer exists / no longer supports the agent.
 */
export async function resolveResumeTokenSourceSpawnOptions(
    store: IStore,
    orgId: string | null | undefined,
    metadata: unknown,
    flavor: string | null | undefined,
): Promise<ResumeTokenSourceSpawnOptions | null> {
    const tokenSourceId = readTokenSourceIdFromMetadata(metadata)
    if (!tokenSourceId) {
        return null
    }
    if (!orgId) {
        console.warn(`[resume] Session has tokenSourceId=${tokenSourceId} but no orgId; skipping Token Source reattach`)
        return null
    }
    const agent = flavor === 'codex' ? 'codex' : flavor === 'claude' ? 'claude' : null
    if (!agent) {
        return null
    }

    const resolved = await resolveTokenSourceForAgent(store, orgId, tokenSourceId, agent)
    if ('error' in resolved) {
        console.warn(`[resume] Failed to resolve Token Source ${tokenSourceId} for agent=${agent}: ${resolved.error}. Trying fallback to default ${agent} Token Source.`)
        const fallback = await pickDefaultTokenSourceForAgent(store, orgId, agent)
        if (!fallback) {
            console.warn(`[resume] No fallback ${agent} Token Source available for org ${orgId}; skipping Token Source reattach`)
            return null
        }
        console.log(`[resume] Falling back to Token Source "${fallback.name}" (${fallback.id}) for agent=${agent}`)
        return {
            tokenSourceId: fallback.id,
            tokenSourceName: fallback.name,
            tokenSourceType: agent,
            tokenSourceBaseUrl: fallback.baseUrl,
            tokenSourceApiKey: fallback.apiKey,
        }
    }

    return {
        tokenSourceId: resolved.tokenSource.id,
        tokenSourceName: resolved.tokenSource.name,
        tokenSourceType: agent,
        tokenSourceBaseUrl: resolved.tokenSource.baseUrl,
        tokenSourceApiKey: resolved.tokenSource.apiKey,
    }
}
