import { z } from 'zod'

import { getSessionSourceFromMetadata } from '../sessionSourcePolicy'
import type { StoredSession } from '../store/types'
import {
    BRAIN_CLAUDE_CHILD_MODELS,
    BRAIN_CODEX_CHILD_MODELS,
    type BrainSessionPreferences,
} from './brainSessionPreferences'

export type BrainPreferencesPatchableSource = 'brain' | 'brain-child'

export type BrainPreferencesPatchPlanEntry = {
    sessionId: string
    namespace: string
    source: BrainPreferencesPatchableSource
    brainPreferences: BrainSessionPreferences
}

export type BrainPreferencesPatchManifestErrorCode =
    | 'invalid-manifest'
    | 'unknown-session'
    | 'unsupported-session-source'
    | 'active-session'
    | 'invalid-brainPreferences'

export type BrainPreferencesPatchManifestError = {
    sessionId: string | null
    code: BrainPreferencesPatchManifestErrorCode
    message: string
}

export type BrainPreferencesPatchPlanResult =
    | {
        ok: true
        dryRun: boolean
        entries: BrainPreferencesPatchPlanEntry[]
        summary: {
            checked: number
            accepted: number
        }
    }
    | {
        ok: false
        dryRun: boolean
        errors: BrainPreferencesPatchManifestError[]
    }

const CanonicalBrainSessionPreferencesSchema: z.ZodType<BrainSessionPreferences> = z.object({
    machineSelection: z.object({
        mode: z.enum(['auto', 'manual']),
        machineId: z.string().trim().min(1),
    }).strict(),
    childModels: z.object({
        claude: z.object({
            allowed: z.array(z.enum(BRAIN_CLAUDE_CHILD_MODELS)),
            defaultModel: z.enum(BRAIN_CLAUDE_CHILD_MODELS),
        }).strict(),
        codex: z.object({
            allowed: z.array(z.enum(BRAIN_CODEX_CHILD_MODELS)),
            defaultModel: z.enum(BRAIN_CODEX_CHILD_MODELS),
        }).strict(),
    }).strict(),
}).strict()

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as Record<string, unknown>
}

function getPatchableSource(session: StoredSession): BrainPreferencesPatchableSource | null {
    const source = getSessionSourceFromMetadata(session.metadata)
    return source === 'brain' || source === 'brain-child' ? source : null
}

function formatZodIssues(issues: z.ZodIssue[]): string {
    return issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
            return `${path}: ${issue.message}`
        })
        .join('; ')
}

export function buildBrainPreferencesPatchPlan(args: {
    manifest: unknown
    sessions: readonly StoredSession[]
    dryRun?: boolean
}): BrainPreferencesPatchPlanResult {
    const dryRun = args.dryRun !== false
    const manifestRecord = asRecord(args.manifest)
    if (!manifestRecord) {
        return {
            ok: false,
            dryRun,
            errors: [{
                sessionId: null,
                code: 'invalid-manifest',
                message: 'Patch manifest 必须是 { sessionId: brainPreferences } 对象',
            }],
        }
    }

    const sessionsById = new Map(args.sessions.map((session) => [session.id, session]))
    const errors: BrainPreferencesPatchManifestError[] = []
    const entries: BrainPreferencesPatchPlanEntry[] = []

    for (const [sessionId, rawBrainPreferences] of Object.entries(manifestRecord)) {
        const session = sessionsById.get(sessionId)
        if (!session) {
            errors.push({
                sessionId,
                code: 'unknown-session',
                message: `Session "${sessionId}" 不存在`,
            })
            continue
        }

        const source = getPatchableSource(session)
        if (!source) {
            errors.push({
                sessionId,
                code: 'unsupported-session-source',
                message: `Session "${sessionId}" 不是 brain/brain-child，会话来源不允许人工写入 brainPreferences`,
            })
            continue
        }

        if (session.active) {
            errors.push({
                sessionId,
                code: 'active-session',
                message: `Session "${sessionId}" 当前仍是 active，会话运行中禁止应用人工 brainPreferences patch`,
            })
            continue
        }

        const parsedBrainPreferences = CanonicalBrainSessionPreferencesSchema.safeParse(rawBrainPreferences)
        if (!parsedBrainPreferences.success) {
            errors.push({
                sessionId,
                code: 'invalid-brainPreferences',
                message: formatZodIssues(parsedBrainPreferences.error.issues),
            })
            continue
        }

        entries.push({
            sessionId,
            namespace: session.namespace,
            source,
            brainPreferences: parsedBrainPreferences.data,
        })
    }

    if (errors.length > 0) {
        return {
            ok: false,
            dryRun,
            errors,
        }
    }

    return {
        ok: true,
        dryRun,
        entries,
        summary: {
            checked: Object.keys(manifestRecord).length,
            accepted: entries.length,
        },
    }
}
