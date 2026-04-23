import { Hono } from 'hono'
import { z } from 'zod'
import {
    SessionActiveMonitorsSchema,
    type DecryptedMessage,
    type Session,
    type SyncEngine,
} from '../../sync/syncEngine'
import type { SSEManager } from '../../sse/sseManager'
import type { IStore, UserRole, StoredSession } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { getLocalTokenSourceEnabledForOrg, resolveTokenSourceForAgent } from '../tokenSources'
import { requireMachine, requireSessionFromParam, requireSessionFromParamWithShareCheck, requireSyncEngine } from './guards'
import { buildInitPrompt, buildBrainInitPrompt } from '../prompts/initPrompt'
import { getLicenseService } from '../../license/licenseService'
import {
    BRAIN_CLAUDE_CHILD_MODELS,
    buildBrainSessionPreferences,
    extractBrainChildModelDefaults,
    extractBrainSessionPreferencesFromMetadata,
    resolveBrainSpawnPermissionMode,
} from '../../brain/brainSessionPreferences'
import {
    filterBrainChildModelsByRuntimeAvailability,
    resolveBrainChildRuntimeAvailability,
} from '../../brain/brainChildRuntimeSupport'
import { SESSION_PERMISSION_MODE_VALUES, normalizeSessionPermissionMode } from '../../sessionPermissionMode'
import {
    getBrainChildMainSessionId,
    getUnsupportedSessionSourceError,
    isSupportedSessionSource,
} from '../../sessionSourcePolicy'
import {
    extractResumeSpawnExtras,
    extractResumeSpawnMetadata,
    getInvalidResumeMetadataReason,
    resolveResumeTokenSourceSpawnOptions,
} from '../../resumeSpawnMetadata'
import { getSessionSourceFromMetadata } from '../../sessionSourcePolicy'
import { appendSelfSystemPrompt, resolveBrainSelfSystemContext } from '../../brain/selfSystem'
import { buildSessionIdentityContextPatch } from '../identityContext'

/**
 * License 检查：如果指定了 orgId，校验是否可创建会话
 * 返回错误 Response 或 null（表示通过）
 */
async function checkSessionLicense(c: { json: (data: any, status: number) => any }, orgId: string | null | undefined): Promise<Response | null> {
    if (!orgId) return null
    try {
        const licenseService = getLicenseService()
        const licenseCheck = await licenseService.canCreateSession(orgId)
        if (!licenseCheck.valid) {
            return c.json({ type: 'error', message: licenseCheck.message, code: licenseCheck.code }, 403)
        }
    } catch { /* LicenseService not initialized */ }
    return null
}

type SessionSummaryMetadata = {
    name?: string
    path: string
    machineId?: string
    mainSessionId?: string
    source?: string
    summary?: { text: string }
    flavor?: string | null
    runtimeAgent?: string
    runtimeModel?: string
    runtimeModelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    worktree?: {
        basePath: string
        branch: string
        name: string
        worktreePath?: string
        createdAt?: number
    }
    privacyMode?: boolean  // 私密模式，true表示不分享给其他人
    selfSystemEnabled?: boolean
    selfProfileId?: string
    selfProfileName?: string
    selfProfileResolved?: boolean
    selfMemoryProvider?: 'yoho-memory' | 'none'
    selfMemoryAttached?: boolean
    selfMemoryStatus?: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error'
}

type SessionViewer = {
    email: string
    clientId: string
    deviceType?: string
}

type SessionSummary = {
    id: string
    createdAt: number
    active: boolean
    reconnecting?: boolean
    activeAt: number
    updatedAt: number
    lastMessageAt: number | null
    createdBy?: string
    ownerEmail?: string  // 当 session 来自其他用户时，显示来源用户
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    thinking: boolean
    modelMode?: Session['modelMode']
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
    activeMonitorCount?: number
    viewers?: SessionViewer[]
    terminationReason?: string
}

function getStoredActiveMonitorCount(stored: StoredSession): number | undefined {
    const parsed = SessionActiveMonitorsSchema.safeParse(stored.activeMonitors)
    if (!parsed.success) {
        return undefined
    }
    return parsed.data.length
}

function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        mainSessionId: getBrainChildMainSessionId(session.metadata),
        source: session.metadata.source,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        flavor: session.metadata.flavor ?? null,
        runtimeAgent: session.metadata.runtimeAgent,
        runtimeModel: session.metadata.runtimeModel,
        runtimeModelReasoningEffort: session.metadata.runtimeModelReasoningEffort,
        worktree: session.metadata.worktree,
        privacyMode: session.metadata.privacyMode === true ? true : undefined,
        selfSystemEnabled: session.metadata.selfSystemEnabled === true ? true : undefined,
        selfProfileId: typeof session.metadata.selfProfileId === 'string' ? session.metadata.selfProfileId : undefined,
        selfProfileName: typeof session.metadata.selfProfileName === 'string' ? session.metadata.selfProfileName : undefined,
        selfProfileResolved: session.metadata.selfProfileResolved === true ? true : undefined,
        selfMemoryProvider: session.metadata.selfMemoryProvider === 'none' ? 'none' : session.metadata.selfMemoryProvider === 'yoho-memory' ? 'yoho-memory' : undefined,
        selfMemoryAttached: session.metadata.selfMemoryAttached === true ? true : undefined,
        selfMemoryStatus: session.metadata.selfMemoryStatus === 'disabled'
            || session.metadata.selfMemoryStatus === 'skipped'
            || session.metadata.selfMemoryStatus === 'attached'
            || session.metadata.selfMemoryStatus === 'empty'
            || session.metadata.selfMemoryStatus === 'error'
            ? session.metadata.selfMemoryStatus
            : undefined,
    } : null

    const todoProgress = session.todos?.length ? {
        completed: session.todos.filter(t => t.status === 'completed').length,
        total: session.todos.length
    } : null

    return {
        id: session.id,
        createdAt: session.createdAt,
        active: session.active,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
        createdBy: session.createdBy,
        metadata,
        todoProgress,
        pendingRequestsCount,
        thinking: session.thinking ?? false,
        modelMode: session.modelMode,
        modelReasoningEffort: session.modelReasoningEffort,
        fastMode: session.fastMode,
        activeMonitorCount: session.activeMonitors.length,
        terminationReason: session.terminationReason,
    }
}

// Convert StoredSession (from database) to SessionSummary
function storedSessionToSummary(stored: StoredSession, reconnecting = false): SessionSummary {
    const meta = stored.metadata as SessionSummaryMetadata | null
    const todos = stored.todos as Array<{ status: string }> | null

    const todoProgress = todos?.length ? {
        completed: todos.filter(t => t.status === 'completed').length,
        total: todos.length
    } : null

    return {
        id: stored.id,
        createdAt: stored.createdAt,
        active: stored.active,
        ...(reconnecting && { reconnecting: true }),
        activeAt: stored.activeAt ?? stored.updatedAt,
        updatedAt: stored.updatedAt,
        lastMessageAt: stored.lastMessageAt,
        createdBy: stored.createdBy ?? undefined,
        metadata: meta ? {
            ...meta,
            mainSessionId: getBrainChildMainSessionId(meta),
        } : null,
        todoProgress,
        pendingRequestsCount: 0,  // Offline sessions have no pending requests
        thinking: false,
        modelMode: stored.modelMode as Session['modelMode'] | undefined,
        modelReasoningEffort: stored.modelReasoningEffort as Session['modelReasoningEffort'] | undefined,
        fastMode: stored.fastMode ?? undefined,
        activeMonitorCount: getStoredActiveMonitorCount(stored),
        terminationReason: stored.terminationReason ?? undefined,
    }
}

const permissionModeValues = SESSION_PERMISSION_MODE_VALUES
const createSessionPermissionModeValues = ['bypassPermissions', 'read-only', 'safe-yolo', 'yolo'] as const
const modelModeValues = ['default', 'sonnet', 'opus', 'opus-4-7', 'glm-5.1', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'] as const
const reasoningEffortValues = ['low', 'medium', 'high', 'xhigh'] as const
const claudeModelValues = ['sonnet', 'opus', 'opus-4-7'] as const

const permissionModeSchema = z.object({
    mode: z.enum(permissionModeValues)
})

const modelModeSchema = z.object({
    model: z.enum(modelModeValues),
    reasoningEffort: z.enum(reasoningEffortValues).optional()
})

const createSessionSchema = z.object({
    machineId: z.string().min(1),
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex']).optional(),
    yolo: z.boolean().optional(),
    tokenSourceId: z.string().min(1).optional(),
    claudeModel: z.enum(claudeModelValues).optional(),
    codexModel: z.string().min(1).optional(),
    permissionMode: z.enum(createSessionPermissionModeValues).optional(),
    modelMode: z.enum(modelModeValues).optional(),
    modelReasoningEffort: z.enum(reasoningEffortValues).optional(),
    source: z.string().min(1).max(100).optional(),
})

const createBrainSessionSchema = z.object({
    machineId: z.string().min(1).optional(),
    agent: z.enum(['claude', 'codex']).optional(),
    tokenSourceId: z.string().min(1).optional(),
    claudeTokenSourceId: z.string().min(1).optional(),
    codexTokenSourceId: z.string().min(1).optional(),
    claudeSettingsType: z.enum(['litellm', 'claude']).optional(),
    claudeAgent: z.string().min(1).optional(),
    claudeModel: z.enum(claudeModelValues).optional(),
    codexModel: z.string().min(1).optional(),
    modelReasoningEffort: z.enum(reasoningEffortValues).optional(),
    childClaudeModels: z.array(z.enum(BRAIN_CLAUDE_CHILD_MODELS)).optional(),
    childCodexModels: z.array(z.string().min(1)).optional(),
})

function isModelMode(value: string): value is NonNullable<Session['modelMode']> {
    return (modelModeValues as readonly string[]).includes(value)
}

function resolveRequestedModelMode(options: {
    modelMode?: string
    claudeModel?: string
    codexModel?: string
}): Session['modelMode'] | undefined {
    if (options.claudeModel && isModelMode(options.claudeModel)) {
        return options.claudeModel
    }
    if (options.codexModel) {
        const maybeModelMode = options.codexModel.replace(/^openai\//, '')
        if (isModelMode(maybeModelMode)) {
            return maybeModelMode
        }
    }
    if (options.modelMode && isModelMode(options.modelMode)) {
        return options.modelMode
    }
    return undefined
}

export const RESUME_TIMEOUT_MS = 60_000
export const RESUME_CONTEXT_MAX_LINES = 60
const RESUME_CONTEXT_MAX_CHARS = 16_000
const RESUME_VERIFY_TIMEOUT_MS = 5_000

function extractBackendSessionId(session: Session | null | undefined, flavor: 'claude' | 'codex'): string | null {
    if (!session?.metadata) {
        return null
    }
    const raw = flavor === 'claude'
        ? session.metadata.claudeSessionId
        : session.metadata.codexSessionId
    if (typeof raw !== 'string') {
        return null
    }
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
}

async function waitForBackendSessionIdMismatch(
    engine: SyncEngine,
    sessionId: string,
    flavor: 'claude' | 'codex',
    expectedSessionId: string,
    timeoutMs: number
): Promise<string | null> {
    const checkMismatch = (): string | null => {
        const session = engine.getSession(sessionId)
        if (!session) {
            return null
        }
        const actual = extractBackendSessionId(session, flavor)
        if (!actual || actual === expectedSessionId) {
            return null
        }
        return actual
    }

    const immediate = checkMismatch()
    if (immediate) {
        return immediate
    }

    return await new Promise((resolve) => {
        let resolved = false
        let unsubscribe = () => {}

        const finalize = (result: string | null) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            unsubscribe()
            resolve(result)
        }

        const timer = setTimeout(() => finalize(null), timeoutMs)

        unsubscribe = engine.subscribe((event) => {
            if (event.sessionId !== sessionId) {
                return
            }
            if (event.type !== 'session-added' && event.type !== 'session-updated') {
                return
            }
            const mismatch = checkMismatch()
            if (mismatch) {
                finalize(mismatch)
            }
        })
    })
}

// Note: Role is now extracted from Keycloak token in auth middleware
// Use c.get('role') directly instead of the old resolveUserRole function

export async function waitForSessionOnline(engine: SyncEngine, sessionId: string, timeoutMs: number): Promise<boolean> {
    const existing = engine.getSession(sessionId)
    if (existing?.active) {
        return true
    }

    return await new Promise((resolve) => {
        let resolved = false
        let unsubscribe = () => {}

        const finalize = (result: boolean) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            unsubscribe()
            resolve(result)
        }

        const timer = setTimeout(() => finalize(false), timeoutMs)

        unsubscribe = engine.subscribe((event) => {
            if (event.sessionId !== sessionId) {
                return
            }
            if (event.type !== 'session-added' && event.type !== 'session-updated') {
                return
            }
            const session = engine.getSession(sessionId)
            if (session?.active) {
                finalize(true)
            }
        })

        const current = engine.getSession(sessionId)
        if (current?.active) {
            finalize(true)
        }
    })
}

async function waitForSessionInactive(engine: SyncEngine, sessionId: string, timeoutMs: number): Promise<boolean> {
    const existing = engine.getSession(sessionId)
    if (!existing?.active) {
        return true
    }

    return await new Promise((resolve) => {
        let resolved = false
        let unsubscribe = () => {}

        const finalize = (result: boolean) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            unsubscribe()
            resolve(result)
        }

        const timer = setTimeout(() => finalize(false), timeoutMs)

        unsubscribe = engine.subscribe((event) => {
            if (event.sessionId !== sessionId) {
                return
            }
            if (event.type !== 'session-updated') {
                return
            }
            const session = engine.getSession(sessionId)
            if (session && !session.active) {
                finalize(true)
            }
        })

        // Re-check after subscribing to avoid race condition
        const current = engine.getSession(sessionId)
        if (!current?.active) {
            finalize(true)
        }
    })
}

async function sendInitPrompt(
    engine: SyncEngine,
    store: IStore,
    sessionId: string,
    role: UserRole,
    userName?: string | null,
): Promise<void> {
    const session = engine.getSession(sessionId)
    const projectRoot = session?.metadata?.path?.trim() || null
    const source = getSessionSourceFromMetadata(session?.metadata)
    const brainPreferences = extractBrainSessionPreferencesFromMetadata((session?.metadata as Record<string, unknown> | null | undefined) ?? null)
    console.log(`[sendInitPrompt] sessionId=${sessionId}, role=${role}, projectRoot=${projectRoot}, userName=${userName}, source=${source}`)
    let prompt = source === 'brain'
        ? await buildBrainInitPrompt(role, { projectRoot, userName, brainPreferences })
        : await buildInitPrompt(role, { projectRoot, userName })

    if (source === 'brain' && session) {
        const selfSystem = await resolveBrainSelfSystemContext({
            store,
            namespace: session.namespace,
        })
        prompt = appendSelfSystemPrompt(prompt, selfSystem.prompt)
        if (typeof (engine as { patchSessionMetadata?: unknown }).patchSessionMetadata === 'function') {
            const patchResult = await engine.patchSessionMetadata(sessionId, selfSystem.metadataPatch)
            if (!patchResult.ok) {
                console.warn(`[sendInitPrompt] Failed to patch self system metadata for session ${sessionId}: ${patchResult.error}`)
            }
        }
    }

    if (!prompt.trim()) {
        console.warn(`[sendInitPrompt] Empty prompt for session ${sessionId}, skipping`)
        return
    }

    // Retry up to 3 times with backoff
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            console.log(`[sendInitPrompt] Sending prompt to session ${sessionId}, length=${prompt.length}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`)
            await engine.sendMessage(sessionId, {
                text: prompt,
                sentFrom: 'webapp'
            })
            console.log(`[sendInitPrompt] Successfully sent init prompt to session ${sessionId}`)
            return
        } catch (err) {
            lastError = err as Error
            if (attempt < 2) {
                const delay = (attempt + 1) * 2000
                console.warn(`[sendInitPrompt] Failed attempt ${attempt + 1}/3 for session ${sessionId}, retrying in ${delay}ms:`, (err as Error).message)
                await new Promise(r => setTimeout(r, delay))
            }
        }
    }
    console.error(`[sendInitPrompt] Failed for session ${sessionId} after 3 attempts:`, lastError)
}

async function sendInitPromptAfterOnline(
    engine: SyncEngine,
    store: IStore,
    sessionId: string,
    role: UserRole,
    userName?: string | null,
): Promise<void> {
    const isOnline = await waitForSessionOnline(engine, sessionId, 60_000)
    if (!isOnline) {
        return
    }
    await sendInitPrompt(engine, store, sessionId, role, userName)
}

export async function resolveSpawnTarget(
    engine: SyncEngine,
    machineId: string,
    session: Session
): Promise<{ ok: true; directory: string } | { ok: false; error: string }> {
    const metadata = session.metadata
    if (!metadata) {
        return { ok: false, error: 'Session metadata missing' }
    }

    const worktree = metadata.worktree
    const worktreePath = worktree?.worktreePath?.trim()
    if (worktreePath) {
        try {
            const exists = await engine.checkPathsExist(machineId, [worktreePath])
            if (exists[worktreePath]) {
                return { ok: true, directory: worktreePath }
            }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to check worktree path' }
        }
    }

    const worktreeBase = worktree?.basePath?.trim()
    if (worktreeBase) {
        try {
            const exists = await engine.checkPathsExist(machineId, [worktreeBase])
            if (!exists[worktreeBase]) {
                return { ok: false, error: `Worktree base path not found: ${worktreeBase}` }
            }
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to check worktree base path' }
        }
        return { ok: true, directory: worktreeBase }
    }

    const sessionPath = metadata.path?.trim()
    if (!sessionPath) {
        return { ok: false, error: 'Session path missing' }
    }

    try {
        const exists = await engine.checkPathsExist(machineId, [sessionPath])
        if (!exists[sessionPath]) {
            return { ok: false, error: `Session path not found: ${sessionPath}` }
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to check session path' }
    }

    return { ok: true, directory: sessionPath }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function extractMessageSentFrom(content: unknown): string | null {
    if (!isObject(content)) {
        return null
    }
    const meta = isObject(content.meta) ? content.meta : null
    return typeof meta?.sentFrom === 'string' ? meta.sentFrom : null
}

function extractTaggedValue(text: string, tagName: string): string | null {
    const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i')
    const match = text.match(pattern)
    const value = match?.[1]?.trim()
    return value && value.length > 0 ? value : null
}

function extractTodoReminderText(items: unknown): string | null {
    if (!Array.isArray(items)) {
        return null
    }

    const lines = items
        .map((item) => {
            if (!isObject(item)) return null
            const content = typeof item.content === 'string' ? item.content.trim() : ''
            const status = typeof item.status === 'string' ? item.status : 'pending'
            if (!content) return null
            return `- [${status}] ${content}`
        })
        .filter((line): line is string => Boolean(line))

    if (lines.length === 0) {
        return null
    }

    return `当前待办：\n${lines.join('\n')}`
}

function extractClaudeAttachmentText(dataRecord: Record<string, unknown>): string | null {
    if (dataRecord.type !== 'attachment') {
        return null
    }

    const attachment = isObject(dataRecord.attachment) ? dataRecord.attachment : null
    if (!attachment) {
        return null
    }

    const attachmentType = typeof attachment.type === 'string' ? attachment.type : null
    if (attachmentType === 'plan_file_reference') {
        const planFilePath = typeof attachment.planFilePath === 'string' ? attachment.planFilePath.trim() : ''
        const planContent = typeof attachment.planContent === 'string' ? attachment.planContent.trim() : ''
        if (planContent) {
            return planFilePath
                ? `当前计划文件（${planFilePath}）：\n${planContent}`
                : `当前计划文件：\n${planContent}`
        }
        if (planFilePath) {
            return `当前计划文件：${planFilePath}`
        }
        return null
    }

    if (attachmentType === 'todo_reminder') {
        return extractTodoReminderText(attachment.content)
    }

    if (attachmentType === 'plan_mode') {
        const planFilePath = typeof attachment.planFilePath === 'string' ? attachment.planFilePath.trim() : ''
        return planFilePath
            ? `当前处于计划模式（计划文件：${planFilePath}）`
            : '当前处于计划模式'
    }

    if (attachmentType === 'queued_command') {
        const prompt = typeof attachment.prompt === 'string' ? attachment.prompt.trim() : ''
        if (!prompt) {
            return null
        }
        const summary = extractTaggedValue(prompt, 'summary')
        if (summary) {
            return summary
        }
        if (attachment.commandMode === 'prompt') {
            return `排队命令：${prompt}`
        }
    }

    return null
}

function extractUserText(content: unknown): string | null {
    if (!content || typeof content !== 'object') {
        return null
    }
    const record = content as Record<string, unknown>

    const extractClaudeUserMessageText = (value: unknown): string | null => {
        if (typeof value === 'string') {
            return value.trim() || null
        }
        if (!Array.isArray(value)) {
            return null
        }
        const texts = value
            .map((item) => {
                if (!item || typeof item !== 'object') return null
                const itemRecord = item as Record<string, unknown>
                if (itemRecord.type === 'text' && typeof itemRecord.text === 'string') {
                    return itemRecord.text.trim()
                }
                if (itemRecord.type === 'image') {
                    const source = itemRecord.source
                    const mediaType = source && typeof source === 'object'
                        ? (source as Record<string, unknown>).media_type
                        : undefined
                    return `[Image: ${typeof mediaType === 'string' ? mediaType : 'image'}]`
                }
                if (itemRecord.type === 'document') {
                    const source = itemRecord.source
                    const mediaType = source && typeof source === 'object'
                        ? (source as Record<string, unknown>).media_type
                        : undefined
                    return `[Document: ${typeof mediaType === 'string' ? mediaType : 'file'}]`
                }
                return null
            })
            .filter((text): text is string => Boolean(text))
        if (texts.length === 0) {
            return null
        }
        return texts.join('\n')
    }

    if (record.role === 'user') {
        const body = record.content as Record<string, unknown> | string | undefined
        if (!body) {
            return null
        }
        if (typeof body === 'string') {
            return body.trim() || null
        }
        if (typeof body === 'object' && body.type === 'text' && typeof body.text === 'string') {
            return body.text.trim() || null
        }
        return null
    }

    if (record.role !== 'agent') {
        return null
    }

    const payload = record.content as Record<string, unknown> | undefined
    if (!payload || payload.type !== 'output') {
        return null
    }

    const data = payload.data
    if (!data || typeof data !== 'object') {
        return null
    }

    const dataRecord = data as Record<string, unknown>
    if (dataRecord.type !== 'user' || typeof dataRecord.message !== 'object') {
        return null
    }

    const message = dataRecord.message as Record<string, unknown>
    return extractClaudeUserMessageText(message.content)
}

function extractAgentText(content: unknown): string | null {
    if (!content || typeof content !== 'object') {
        return null
    }
    const record = content as Record<string, unknown>
    if (record.role !== 'agent') {
        return null
    }
    const payload = record.content as Record<string, unknown> | undefined
    const data = payload?.data
    if (!data || (typeof data !== 'object' && typeof data !== 'string')) {
        return null
    }
    if (typeof data === 'string') {
        return data.trim() || null
    }
    const dataRecord = data as Record<string, unknown>
    if (typeof dataRecord.message === 'string') {
        return dataRecord.message.trim() || null
    }
    if (dataRecord.type === 'message' && typeof dataRecord.message === 'string') {
        return dataRecord.message.trim() || null
    }
    if (dataRecord.type === 'tool_use_summary' && typeof dataRecord.summary === 'string') {
        return dataRecord.summary.trim() || null
    }
    if (dataRecord.type === 'result' && typeof dataRecord.result === 'string') {
        return dataRecord.result.trim() || null
    }
    const attachmentText = extractClaudeAttachmentText(dataRecord)
    if (attachmentText) {
        return attachmentText
    }
    if (dataRecord.type === 'assistant' && typeof dataRecord.message === 'object') {
        const message = dataRecord.message as Record<string, unknown>
        const contentValue = message.content
        if (typeof contentValue === 'string') {
            return contentValue.trim() || null
        }
        if (Array.isArray(contentValue)) {
            const texts = contentValue
                .map((item) => {
                    if (!item || typeof item !== 'object') return null
                    const itemRecord = item as Record<string, unknown>
                    if (itemRecord.type === 'text' && typeof itemRecord.text === 'string') {
                        return itemRecord.text.trim()
                    }
                    return null
                })
                .filter((text): text is string => Boolean(text))
            if (texts.length > 0) {
                return texts.join('\n')
            }
        }
    }
    return null
}

type ResumeDialogLine = {
    speaker: '用户' | '助手'
    text: string
    sentFrom: string | null
}

function appendResumeDialogLine(lines: ResumeDialogLine[], next: ResumeDialogLine): void {
    const text = next.text.trim()
    if (!text) {
        return
    }

    const candidate = { ...next, text }
    const previous = lines.at(-1)
    if (!previous) {
        lines.push(candidate)
        return
    }

    if (previous.speaker === candidate.speaker) {
        if (
            candidate.speaker === '用户'
            && previous.text === candidate.text
            && (previous.sentFrom === 'cli' || candidate.sentFrom === 'cli')
        ) {
            if (previous.sentFrom === 'cli' && candidate.sentFrom !== 'cli') {
                lines[lines.length - 1] = candidate
            }
            return
        }

        if (candidate.speaker === '助手') {
            if (previous.text === candidate.text) {
                return
            }
            if (candidate.text.startsWith(previous.text) && candidate.text.length > previous.text.length) {
                lines[lines.length - 1] = candidate
                return
            }
            if (previous.text.startsWith(candidate.text) && previous.text.length > candidate.text.length) {
                return
            }
        }
    }

    lines.push(candidate)
}

export function buildResumeContextMessage(session: Session, messages: DecryptedMessage[]): string | null {
    const summary = session.metadata?.summary?.text?.trim()
    const lines: string[] = [
        '#InitPrompt-ResumeContext',
        '以下是从旧会话自动迁移的上下文（可能不完整）：'
    ]
    if (summary) {
        lines.push(`摘要：${summary}`)
    }

    const dialogLines: ResumeDialogLine[] = []
    for (const message of messages) {
        const userText = extractUserText(message.content)
        if (userText) {
            appendResumeDialogLine(dialogLines, {
                speaker: '用户',
                text: userText,
                sentFrom: extractMessageSentFrom(message.content)
            })
            continue
        }
        const agentText = extractAgentText(message.content)
        if (agentText) {
            appendResumeDialogLine(dialogLines, {
                speaker: '助手',
                text: agentText,
                sentFrom: extractMessageSentFrom(message.content)
            })
        }
    }

    if (dialogLines.length > RESUME_CONTEXT_MAX_LINES) {
        dialogLines.splice(0, dialogLines.length - RESUME_CONTEXT_MAX_LINES)
    }

    if (dialogLines.length > 0) {
        lines.push('最近对话片段：')
        lines.push(...dialogLines.map((line) => `${line.speaker}：${line.text}`))
    }

    if (lines.length <= 2) {
        return null
    }

    const content = lines.join('\n')
    if (content.length <= RESUME_CONTEXT_MAX_CHARS) {
        return content
    }
    return `${content.slice(0, RESUME_CONTEXT_MAX_CHARS)}...`
}

export function createSessionsRoutes(
    getSyncEngine: () => SyncEngine | null,
    getSseManager: () => SSEManager | null,
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.post('/sessions', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = createSessionSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        const machine = requireMachine(c, engine, parsed.data.machineId)
        if (machine instanceof Response) {
            return machine
        }

        // License check: if orgId is specified, validate license
        const orgId = c.req.query('orgId')
        const licenseError = await checkSessionLicense(c, orgId)
        if (licenseError) return licenseError

        const rawSource = parsed.data.source?.trim()
        if (!isSupportedSessionSource(rawSource)) {
            return c.json({ error: getUnsupportedSessionSourceError(rawSource) }, 400)
        }
        const source = rawSource ? rawSource : 'external-api'
        const email = c.get('email')
        const requestedAgent = parsed.data.agent ?? 'claude'
        // 将 claudeModel/codexModel 转换为 modelMode
        const modelMode = resolveRequestedModelMode({
            modelMode: parsed.data.modelMode,
            claudeModel: parsed.data.claudeModel,
            codexModel: parsed.data.codexModel,
        })

        let resolvedTokenSource: Awaited<ReturnType<typeof resolveTokenSourceForAgent>> | null = null
        if (parsed.data.tokenSourceId) {
            if (!orgId) {
                return c.json({ error: 'orgId is required when using Token Source' }, 400)
            }
            resolvedTokenSource = await resolveTokenSourceForAgent(
                store,
                orgId,
                parsed.data.tokenSourceId,
                requestedAgent
            )
            if ('error' in resolvedTokenSource) {
                return c.json({ error: resolvedTokenSource.error }, resolvedTokenSource.status as 400 | 404)
            }
        } else if (orgId) {
            const localEnabled = await getLocalTokenSourceEnabledForOrg(store, orgId)
            if (!localEnabled) {
                return c.json({ error: 'Local Token Source is disabled for this organization' }, 400)
            }
        }

        const result = await engine.spawnSession(
            parsed.data.machineId,
            parsed.data.directory,
            requestedAgent,
            parsed.data.yolo,
            {
                tokenSourceId: resolvedTokenSource?.tokenSource.id,
                tokenSourceName: resolvedTokenSource?.tokenSource.name,
                tokenSourceType: resolvedTokenSource?.tokenSource.supportedAgents.includes('codex') && requestedAgent === 'codex'
                    ? 'codex'
                    : resolvedTokenSource?.tokenSource.supportedAgents.includes('claude') && requestedAgent === 'claude'
                        ? 'claude'
                        : undefined,
                tokenSourceBaseUrl: resolvedTokenSource?.tokenSource.baseUrl,
                tokenSourceApiKey: resolvedTokenSource?.tokenSource.apiKey,
                permissionMode: parsed.data.permissionMode,
                modelMode: modelMode as Session['modelMode'] | undefined,
                modelReasoningEffort: parsed.data.modelReasoningEffort,
                source,
            }
        )

        if (result.type === 'success') {
            const namespace = c.get('namespace')
            const role = c.get('role')  // Role from Keycloak token
            const userName = c.get('name')
            // Wait for session to be online, then set createdBy and send init prompt
            void (async () => {
                console.log(`[spawnSession] Waiting for session ${result.sessionId} to come online...`)
                const isOnline = await waitForSessionOnline(engine, result.sessionId, 60_000)
                if (!isOnline) {
                    console.warn(`[spawnSession] Session ${result.sessionId} did not come online within 60s, skipping init prompt`)
                    return
                }
                console.log(`[spawnSession] Session ${result.sessionId} is online, waiting for socket to join room...`)
                // Wait for CLI socket to actually join the session room (not just session-alive)
                const hasSocket = await engine.waitForSocketInRoom(result.sessionId, 5000)
                if (!hasSocket) {
                    console.warn(`[spawnSession] No socket joined room for session ${result.sessionId} within 5s, sending anyway`)
                }
                console.log(`[spawnSession] Sending init prompt to session ${result.sessionId}`)
                // Set createdBy after session is confirmed online (exists in DB)
                if (email) {
                    await store.setSessionCreatedBy(result.sessionId, email, namespace)
                }
                const orgId = c.req.query('orgId')
                if (orgId) {
                    await store.setSessionOrgId(result.sessionId, orgId, namespace)
                }
                const identityPatch = buildSessionIdentityContextPatch(c.get('identityActor'))
                if (identityPatch && typeof (engine as { patchSessionMetadata?: unknown }).patchSessionMetadata === 'function') {
                    await engine.patchSessionMetadata(result.sessionId, identityPatch)
                }
                await sendInitPrompt(engine, store, result.sessionId, role, userName)
            })()
        }

        return c.json(result)
    })

    // Brain: one-click create (auto-selects machine + directory)
    app.post('/brain/sessions', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const body = await c.req.json().catch(() => ({}))
        const parsed = createBrainSessionSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        const namespace = c.get('namespace')
        const email = c.get('email')
        const role = c.get('role')
        const userName = c.get('name')
        const orgId = c.req.query('orgId')
        const brainConfig = await store.getBrainConfig(namespace || 'default')
        const childModelDefaults = extractBrainChildModelDefaults(brainConfig?.extra)
        const requestedAgent = parsed.data.agent ?? brainConfig?.agent ?? 'claude'
        const modelMode = resolveRequestedModelMode({
            claudeModel: requestedAgent === 'claude'
                ? (parsed.data.claudeModel ?? brainConfig?.claudeModelMode)
                : undefined,
            codexModel: requestedAgent === 'codex'
                ? (parsed.data.codexModel ?? brainConfig?.codexModel)
                : undefined,
        })
        const childClaudeModels = parsed.data.childClaudeModels ?? childModelDefaults.childClaudeModels ?? []
        const childCodexModels = parsed.data.childCodexModels ?? childModelDefaults.childCodexModels ?? []

        // License check
        const licenseError = await checkSessionLicense(c, orgId)
        if (licenseError) return licenseError

        if (childClaudeModels.length === 0 && childCodexModels.length === 0) {
            return c.json({ type: 'error', message: 'At least one child-session model must be enabled for Brain.' }, 400)
        }

        const requestedMachineId = parsed.data.machineId?.trim()
        const candidateMachines = requestedMachineId
            ? (() => {
                const selected = requireMachine(c, engine, requestedMachineId)
                if (selected instanceof Response) {
                    return selected
                }
                return [selected]
            })()
            : engine.getOnlineMachinesByNamespace(namespace, orgId ?? undefined)
        if (candidateMachines instanceof Response) {
            return candidateMachines
        }
        const onlineCandidateMachines = candidateMachines.filter((machine) => machine.active)
        if (onlineCandidateMachines.length === 0) {
            return c.json({ type: 'error', message: 'No machines online' }, 503)
        }

        const compatibleMachines = onlineCandidateMachines.filter((machine) => !machine.supportedAgents || machine.supportedAgents.includes(requestedAgent))
        if (compatibleMachines.length === 0) {
            return c.json({ type: 'error', message: requestedMachineId
                ? `Selected machine does not support agent "${requestedAgent}"`
                : `No online machines support agent "${requestedAgent}"` }, 503)
        }

        const brainTokenSourceIds: { claude?: string; codex?: string } = {}
        if (parsed.data.claudeTokenSourceId) brainTokenSourceIds.claude = parsed.data.claudeTokenSourceId
        if (parsed.data.codexTokenSourceId) brainTokenSourceIds.codex = parsed.data.codexTokenSourceId
        if (parsed.data.tokenSourceId && !brainTokenSourceIds[requestedAgent]) {
            brainTokenSourceIds[requestedAgent] = parsed.data.tokenSourceId
        }

        const localEnabled = orgId
            ? await getLocalTokenSourceEnabledForOrg(store, orgId)
            : true
        let resolvedTokenSource: Awaited<ReturnType<typeof resolveTokenSourceForAgent>> | null = null
        const ownTokenSourceId = brainTokenSourceIds[requestedAgent]
        if (ownTokenSourceId) {
            if (!orgId) {
                return c.json({ error: 'orgId is required when using Token Source' }, 400)
            }
            resolvedTokenSource = await resolveTokenSourceForAgent(
                store,
                orgId,
                ownTokenSourceId,
                requestedAgent
            )
            if ('error' in resolvedTokenSource) {
                return c.json({ error: resolvedTokenSource.error }, resolvedTokenSource.status as 400 | 404)
            }
        } else if (!localEnabled) {
            return c.json({ error: 'Local Token Source is disabled for this organization' }, 400)
        }

        const otherAgent: 'claude' | 'codex' = requestedAgent === 'claude' ? 'codex' : 'claude'
        const otherTokenSourceId = brainTokenSourceIds[otherAgent]
        if (otherTokenSourceId) {
            if (!orgId) {
                return c.json({ error: 'orgId is required when using Token Source' }, 400)
            }
            const otherResolved = await resolveTokenSourceForAgent(
                store,
                orgId,
                otherTokenSourceId,
                otherAgent
            )
            if ('error' in otherResolved) {
                return c.json({ error: otherResolved.error }, otherResolved.status as 400 | 404)
            }
        }

        let result: Awaited<ReturnType<typeof engine.spawnSession>> | null = null
        let childCapabilityFailureMessage: string | null = null
        for (const machine of compatibleMachines) {
            const homeDir = machine.metadata?.homeDir || '/tmp'
            const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`
            const runtimeAvailability = resolveBrainChildRuntimeAvailability({
                // Child-session capability is a Brain-level allowlist. Do not bind it
                // to the Brain host machine, or we silently break explicit cross-machine
                // child spawning for agents that are runnable elsewhere.
                machineSupportedAgents: null,
                localTokenSourceEnabled: localEnabled,
                tokenSourceIds: brainTokenSourceIds,
            })
            const effectiveChildModels = filterBrainChildModelsByRuntimeAvailability({
                availability: runtimeAvailability,
                childClaudeModels,
                childCodexModels,
            })
            if (
                effectiveChildModels.childClaudeModels.length === 0
                && effectiveChildModels.childCodexModels.length === 0
            ) {
                childCapabilityFailureMessage = 'Current Token Source / Local configuration does not provide any runnable child-session agent for this Brain'
                continue
            }
            const brainPreferences = buildBrainSessionPreferences({
                machineSelectionMode: requestedMachineId ? 'manual' : 'auto',
                machineId: machine.id,
                childClaudeModels: effectiveChildModels.childClaudeModels,
                childCodexModels: effectiveChildModels.childCodexModels,
            })
            const candidate = await engine.spawnSession(
                machine.id,
                brainDirectory,
                requestedAgent,
                true,        // yolo
                {
                    source: 'brain',
                    permissionMode: resolveBrainSpawnPermissionMode(requestedAgent),
                    tokenSourceId: resolvedTokenSource?.tokenSource.id,
                    tokenSourceName: resolvedTokenSource?.tokenSource.name,
                    tokenSourceType: resolvedTokenSource?.tokenSource.supportedAgents.includes('codex') && requestedAgent === 'codex'
                        ? 'codex'
                        : resolvedTokenSource?.tokenSource.supportedAgents.includes('claude') && requestedAgent === 'claude'
                            ? 'claude'
                            : undefined,
                    tokenSourceBaseUrl: resolvedTokenSource?.tokenSource.baseUrl,
                    tokenSourceApiKey: resolvedTokenSource?.tokenSource.apiKey,
                    claudeSettingsType: requestedAgent === 'claude' ? parsed.data.claudeSettingsType : undefined,
                    claudeAgent: requestedAgent === 'claude' ? parsed.data.claudeAgent : undefined,
                    modelMode,
                    modelReasoningEffort: requestedAgent === 'codex' ? parsed.data.modelReasoningEffort : undefined,
                    brainPreferences,
                }
            )
            if (candidate.type === 'success') {
                result = candidate
                break
            }
            if (candidate.message.includes('AGENT_NOT_AVAILABLE')) {
                continue
            }
            result = candidate
            break
        }

        if (!result) {
            if (childCapabilityFailureMessage) {
                return c.json({ type: 'error', message: childCapabilityFailureMessage }, requestedMachineId ? 400 : 503)
            }
            return c.json({ type: 'error', message: `Failed to create Brain session with agent "${requestedAgent}"` }, 503)
        }

        if (result.type === 'success') {
            // brainTokenSourceIds: server-owned per-agent ID map used by /cli/brain/spawn to choose a child's TS.
            // Separate from metadata.tokenSourceId/Type, which CLI runClaude.ts writes as the *Brain process itself's*
            // runtime snapshot. Both exist in the same session.metadata JSONB but carry different semantics.
            if (brainTokenSourceIds.claude || brainTokenSourceIds.codex) {
                await engine.patchSessionMetadata(result.sessionId, { brainTokenSourceIds })
            }
            void (async () => {
                const isOnline = await waitForSessionOnline(engine, result.sessionId, 60_000)
                if (!isOnline) return
                await engine.waitForSocketInRoom(result.sessionId, 5000)
                if (email) {
                    await store.setSessionCreatedBy(result.sessionId, email, namespace)
                }
                if (orgId) {
                    await store.setSessionOrgId(result.sessionId, orgId, namespace)
                }
                const identityPatch = buildSessionIdentityContextPatch(c.get('identityActor'))
                if (identityPatch && typeof (engine as { patchSessionMetadata?: unknown }).patchSessionMetadata === 'function') {
                    await engine.patchSessionMetadata(result.sessionId, identityPatch)
                }
                await sendInitPrompt(engine, store, result.sessionId, role, userName)
            })()
        }

        return c.json(result)
    })

    app.get('/sessions', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const getPendingCount = (s: Session) => s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0

        const namespace = c.get('namespace')
        const email = c.get('email')
        const sseManager = getSseManager()

        // Keycloak users (namespace='default') see only their own sessions (created_by matches their email)
        // CLI users (with custom namespace) see only sessions in their namespace
        const isKeycloakUser = namespace === 'default'

        // Get sessions from database
        let storedSessions: StoredSession[]
        if (isKeycloakUser) {
            const orgId = c.req.query('orgId') || null
            storedSessions = await store.getSessions(orgId)
        } else {
            // CLI users see only their namespace
            storedSessions = await store.getSessionsByNamespace(namespace)
        }

        // Filter by created_by for Keycloak users
        // 用于标记 session 来自哪个用户（如果来自开启了 shareAllSessions 的其他用户）
        const sessionOwnerMap = new Map<string, string>()

        if (isKeycloakUser && email) {
            // Keycloak用户看到：
            // 1) 自己创建的 session
            // 2) 被共享给自己的 session
            // 3) 如果我开启了 viewOthersSessions，则看到开启了 shareAllSessions 的用户的所有 session
            const sharedWithMe = await store.getSessionsSharedWithUser(email)
            const sharedSet = new Set(sharedWithMe)

            // 检查当前用户是否开启了"查看别人 session"
            const viewOthersEnabled = await store.getViewOthersSessions(email)

            // 获取开启了 shareAllSessions 的用户列表（只有当我开启了 viewOthersSessions 才需要查询）
            let shareAllUsersSet = new Set<string>()
            if (viewOthersEnabled) {
                const usersWithShareAll = await store.getUsersWithShareAllSessions()
                shareAllUsersSet = new Set(usersWithShareAll)
                // 排除自己（不需要标记自己的 session）
                shareAllUsersSet.delete(email)
            }

            storedSessions = storedSessions.filter(s => {
                // Brain sessions should always be visible (飞书群创建的 session)
                const meta = s.metadata as { source?: string } | null
                if (meta?.source === 'brain') {
                    return true
                }

                // 自己创建的，或者没有 createdBy 的 session
                if (!s.createdBy || s.createdBy === email) {
                    return true
                }
                // 被共享给自己的 session
                if (sharedSet.has(s.id)) {
                    return true
                }
                // 如果我开启了 viewOthersSessions，且 session 来自开启了 shareAllSessions 的用户
                if (viewOthersEnabled && shareAllUsersSet.has(s.createdBy)) {
                    // 检查是否开启了私密模式
                    const meta = s.metadata as { privacyMode?: boolean } | null
                    if (meta?.privacyMode === true) {
                        // 私密模式，不显示
                        return false
                    }
                    // 记录这个 session 的来源用户
                    sessionOwnerMap.set(s.id, s.createdBy)
                    return true
                }
                return false
            })
        }

        // Get sessions from memory (SyncEngine) - these have live data
        const memorySessions = isKeycloakUser
            ? engine.getSessions()
            : engine.getSessionsByNamespace(namespace)
        const memorySessionMap = new Map(memorySessions.map(s => [s.id, s]))

        // Determine if a session is truly active:
        // - Database active=false means session is archived (source of truth for offline state)
        // - If database says active=true, check memory state
        // - Must have recent activeAt (within 2 minutes) to be considered truly active
        const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000 // 2 minutes
        const now = Date.now()

        const isSessionTrulyActive = (stored: StoredSession, memorySession: Session | undefined): boolean => {
            const reconnecting = typeof (engine as Partial<SyncEngine>).isSessionStartupRecovering === 'function'
                ? engine.isSessionStartupRecovering(stored.id)
                : false

            if (reconnecting) {
                return false
            }

            // Database active=false is the source of truth for archived sessions
            if (!stored.active) return false

            // If not in memory (e.g. server restarted), also check activeAt freshness
            // Previously this returned stored.active blindly, causing zombie sessions to show as "running"
            // Always verify liveness via heartbeat recency
            if (!memorySession) {
                const dbActiveAt = stored.activeAt ?? stored.updatedAt
                const timeSinceDbActive = now - dbActiveAt
                return timeSinceDbActive < ACTIVE_THRESHOLD_MS
            }

            if (!memorySession.active) return false
            // Check if activeAt is recent (CLI is sending heartbeats)
            const timeSinceActive = now - memorySession.activeAt
            return timeSinceActive < ACTIVE_THRESHOLD_MS
        }

        // Build session summaries from database, enhanced with memory data
        const sessionSummaries: SessionSummary[] = storedSessions.map((stored) => {
            const memorySession = memorySessionMap.get(stored.id)
            const trulyActive = isSessionTrulyActive(stored, memorySession)
            const reconnecting = typeof (engine as Partial<SyncEngine>).isSessionStartupRecovering === 'function'
                ? engine.isSessionStartupRecovering(stored.id)
                : false

            // Start with database data
            const summary = storedSessionToSummary(stored, reconnecting)

            // 如果这是来自其他用户（开启了 shareAllSessions）的 session，标注来源
            const ownerEmail = sessionOwnerMap.get(stored.id)
            if (ownerEmail) {
                summary.ownerEmail = ownerEmail
            }

            // Override active status based on combined memory + DB state
            summary.active = trulyActive
            if (memorySession) {
                summary.activeAt = memorySession.activeAt
            }

            // If session is in memory, enhance with live data
            if (memorySession) {
                // Use memory's thinking state (live data, DB value is stale)
                summary.thinking = memorySession.thinking

                // Use memory's pending requests count (live data)
                summary.pendingRequestsCount = memorySession.agentState?.requests
                    ? Object.keys(memorySession.agentState.requests).length
                    : 0
                summary.modelMode = memorySession.modelMode ?? summary.modelMode
                summary.modelReasoningEffort = memorySession.modelReasoningEffort ?? summary.modelReasoningEffort
                summary.fastMode = memorySession.fastMode ?? summary.fastMode
                summary.activeMonitorCount = memorySession.activeMonitors.length
                summary.terminationReason = memorySession.terminationReason ?? summary.terminationReason

                // Add viewers info
                if (sseManager) {
                    const viewers = sseManager.getSessionViewers(namespace, stored.id)
                    if (viewers.length > 0) {
                        summary.viewers = viewers.map(v => ({
                            email: v.email,
                            clientId: v.clientId,
                            deviceType: v.deviceType
                        }))
                    }
                }
            }

            return summary
        })

        // Sort: active first, then by recent activity, and only use pending requests as a tie-breaker.
        const allSessions = sessionSummaries.sort((a, b) => {
            // Active sessions first
            if (a.active !== b.active) {
                return a.active ? -1 : 1
            }
            // Prefer the most recently active session within the same active bucket.
            const activityDiff = (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)
            if (activityDiff !== 0) {
                return activityDiff
            }
            // Pending requests still matter, but should not permanently pin stale sessions to the top.
            return b.pendingRequestsCount - a.pendingRequestsCount
        })

        return c.json({ sessions: allSessions })
    })

    app.get('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const session = sessionResult.session
        const askRequests = session.agentState?.requests
            ? Object.entries(session.agentState.requests).filter(([, r]) => r.tool === 'AskUserQuestion' || r.tool === 'ask_user_question')
            : []
        if (askRequests.length > 0) {
            console.log(`[AskUserQuestion] GET /sessions/:id returning session with AskUserQuestion requests`, {
                sessionId: sessionResult.sessionId,
                askRequestIds: askRequests.map(([id]) => id),
                totalRequests: session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0,
                completedRequests: session.agentState?.completedRequests ? Object.keys(session.agentState.completedRequests).length : 0,
            })
        }

        engine.noteResumeClientEvent(sessionResult.sessionId, 'session-get')
        return c.json({ session })
    })

    app.delete('/sessions/:id', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const forceParam = c.req.query('force')
        const force = forceParam === '1' || forceParam === 'true'
        const purgeParam = c.req.query('purge')
        const purge = purgeParam === '1' || purgeParam === 'true'
        try {
            const ok = purge
                ? await engine.deleteSession(sessionResult.sessionId, { terminateSession: true, force })
                : await engine.archiveSession(sessionResult.sessionId, {
                    terminateSession: true,
                    force,
                    archivedBy: 'user',
                    archiveReason: 'User archived session',
                })
            if (!ok) {
                return c.json({ error: 'Session not found' }, 404)
            }
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to terminate session'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/abort', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.abortSession(sessionResult.sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/switch', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        await engine.switchSession(sessionResult.sessionId, 'remote')
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/resume', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionId = sessionResult.sessionId
        const session = sessionResult.session

        if (session.active) {
            if (session.metadata?.lifecycleState === 'archived') {
                const unarchiveResult = await engine.unarchiveSession(sessionId, { actor: 'manual-resume-already-active' })
                if (!unarchiveResult.ok) {
                    console.warn(`[resume] Failed to clear archive metadata for already-active session ${sessionId}: ${unarchiveResult.error}`)
                }
            }
            return c.json({ type: 'already-active', sessionId })
        }

        // License check: session 可能在归档后 license 已过期（orgId 来自 DB）
        const storedForResume = await store.getSession(sessionId)
        const licenseError = await checkSessionLicense(c, storedForResume?.orgId)
        if (licenseError) return licenseError

        const flavor = session.metadata?.flavor ?? 'claude'
        if (flavor !== 'claude' && flavor !== 'codex') {
            return c.json({ error: 'Resume not supported for this session flavor' }, 400)
        }

        const machineId = session.metadata?.machineId?.trim()
        if (!machineId) {
            return c.json({ error: 'Session machine not found' }, 409)
        }

        const machine = engine.getMachineByNamespace(machineId, c.get('namespace'))
        if (!machine || !machine.active) {
            return c.json({ error: 'Machine is offline' }, 409)
        }

        const spawnTarget = await resolveSpawnTarget(engine, machineId, session)
        if (!spawnTarget.ok) {
            return c.json({ error: spawnTarget.error }, 409)
        }

        // Preserve mode settings from original session
        const modeSettings = {
            permissionMode: normalizeSessionPermissionMode({
                flavor: session.metadata?.flavor,
                permissionMode: session.permissionMode,
                metadata: session.metadata,
            }),
            modelMode: session.modelMode,
            modelReasoningEffort: session.modelReasoningEffort
        }
        const invalidResumeMetadataReason = getInvalidResumeMetadataReason(session.metadata)
        if (invalidResumeMetadataReason) {
            return c.json({ error: invalidResumeMetadataReason }, 409)
        }
        const resumeMetadata = extractResumeSpawnMetadata(session.metadata)
        const { yolo: resumeYolo, ...resumeExtras } = extractResumeSpawnExtras(session.metadata)
        const tokenSourceSpawnOptions = await resolveResumeTokenSourceSpawnOptions(
            store, storedForResume?.orgId ?? null, session.metadata, flavor
        )

        // Extract native session ID for Claude/Codex resume
        const resumeSessionId = (() => {
            const value = flavor === 'claude'
                ? session.metadata?.claudeSessionId
                : session.metadata?.codexSessionId
            return typeof value === 'string' && value.trim() ? value : undefined
        })()

        // Pre-activate session in DB and memory so heartbeats are accepted
        // and subsequent resume requests are rejected as already-active
        // (archived sessions have active=false which blocks heartbeats)
        const namespace = c.get('namespace')
        const now = Date.now()
        await store.setSessionActive(sessionId, true, now, namespace)
        session.active = true
        session.activeAt = now
        // Reset thinking state so resumed session starts clean
        session.thinking = false
        // Guard: prevent session-end from old process (killed by daemon dedup) from
        // undoing pre-activate. Without this, the old CLI's death event races with
        // the new CLI's first heartbeat and blocks resume for 60s.
        session.resumingUntil = now + RESUME_TIMEOUT_MS

        // Primary attempt: spawn with both yoho-remote session ID and native resume ID
        // so the CLI binds to this session AND Claude/Codex resumes the old conversation
        const resumeAttempt = await engine.spawnSession(
            machineId,
            spawnTarget.directory,
            flavor,
            resumeYolo,
            { sessionId, resumeSessionId, ...modeSettings, ...resumeMetadata, ...resumeExtras, ...(tokenSourceSpawnOptions ?? {}) }
        )

        if (resumeAttempt.type === 'success') {
            const online = await waitForSessionOnline(engine, sessionId, RESUME_TIMEOUT_MS)
            if (online) {
                if (session.metadata?.lifecycleState === 'archived') {
                    const unarchiveResult = await engine.unarchiveSession(sessionId, { actor: 'manual-resume' })
                    if (!unarchiveResult.ok) {
                        console.warn(`[resume] Failed to clear archive metadata for ${sessionId}: ${unarchiveResult.error}`)
                    }
                }
                // Set createdBy after session is confirmed online (exists in DB)
                const email = c.get('email')
                if (email) {
                    const namespace = c.get('namespace')
                    void store.setSessionCreatedBy(sessionId, email, namespace)
                }
                engine.markSessionResumeReady(sessionId, 'manual-resume')
                return c.json({ type: 'resumed', sessionId })
            }
        }

        // Primary attempt failed or timed out — kill any orphaned process before fallback
        // The daemon may have spawned a process that's still starting up but will never
        // become "online" for this session. Kill it to avoid ghost duplicate processes.
        await engine.terminateSessionProcess(sessionId)
        // Reset session to inactive so it doesn't block future operations
        session.active = false
        session.thinking = false
        session.resumingUntil = undefined
        await store.setSessionActive(sessionId, false, Date.now(), namespace)

        // Fallback: spawn a new session with only the native resume ID
        const fallbackResult = await engine.spawnSession(
            machineId,
            spawnTarget.directory,
            flavor,
            resumeYolo,
            { resumeSessionId, ...modeSettings, ...resumeMetadata, ...resumeExtras, ...(tokenSourceSpawnOptions ?? {}) }
        )

        if (fallbackResult.type !== 'success') {
            return c.json({ error: fallbackResult.message }, 409)
        }

        const newSessionId = fallbackResult.sessionId

        const online = await waitForSessionOnline(engine, newSessionId, RESUME_TIMEOUT_MS)
        if (!online) {
            return c.json({ error: 'Session resume timed out' }, 409)
        }

        // Set createdBy and orgId after session is confirmed online (exists in DB)
        const email = c.get('email')
        if (email) {
            void store.setSessionCreatedBy(newSessionId, email, namespace)
        }
        // Inherit org from original session
        const originalStored = await store.getSession(sessionId)
        if (originalStored?.orgId) {
            void store.setSessionOrgId(newSessionId, originalStored.orgId, namespace)
        }

        const resumedSource = getSessionSourceFromMetadata(session.metadata)
        if (resumedSource === 'brain' && newSessionId !== sessionId) {
            const childSessions = engine.getSessionsByNamespace(namespace).filter((candidate) => {
                const metadata = candidate.metadata as { source?: unknown; mainSessionId?: unknown } | null | undefined
                return getSessionSourceFromMetadata(metadata) === 'brain-child' && metadata?.mainSessionId === sessionId
            })

            for (const child of childSessions) {
                const patchResult = await engine.patchSessionMetadata(child.id, { mainSessionId: newSessionId })
                if (!patchResult.ok) {
                    console.warn(`[resume] Failed to rebind brain-child ${child.id} to resumed brain session ${newSessionId}: ${patchResult.error}`)
                }
            }
        }

        const role = c.get('role')  // Role from Keycloak token
        const userName = c.get('name')
        await sendInitPrompt(engine, store, newSessionId, role, userName)

        if (!resumeSessionId) {
            const page = await engine.getMessagesPage(sessionId, { limit: RESUME_CONTEXT_MAX_LINES * 2, beforeSeq: null })
            const contextMessage = buildResumeContextMessage(session, page.messages)
            if (contextMessage) {
                await engine.sendMessage(newSessionId, { text: contextMessage, sentFrom: 'webapp' })
            }
        }

        engine.markSessionResumeReady(newSessionId, 'manual-resume')
        return c.json({
            type: 'created',
            sessionId: newSessionId,
            resumedFrom: sessionId,
            usedResume: Boolean(resumeSessionId)
        })
    })

    // 刷新账号：原地重启 Claude 进程，使用新账号，保留同一 session 和所有消息
    app.post('/sessions/:id/refresh-account', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionId = sessionResult.sessionId
        const session = sessionResult.session

        // License check: 刷新账号前校验 license 是否仍有效（orgId 来自 DB）
        const storedForRefresh = await store.getSession(sessionId)
        const refreshLicenseError = await checkSessionLicense(c, storedForRefresh?.orgId)
        if (refreshLicenseError) return refreshLicenseError

        const flavor = session.metadata?.flavor ?? 'claude'
        if (flavor !== 'claude') {
            return c.json({ error: 'Refresh account only supported for Claude sessions' }, 400)
        }

        const machineId = session.metadata?.machineId?.trim()
        if (!machineId) {
            return c.json({ error: 'Session machine not found' }, 409)
        }

        const machine = engine.getMachineByNamespace(machineId, c.get('namespace'))
        if (!machine || !machine.active) {
            return c.json({ error: 'Machine is offline' }, 409)
        }

        const spawnTarget = await resolveSpawnTarget(engine, machineId, session)
        if (!spawnTarget.ok) {
            return c.json({ error: spawnTarget.error }, 409)
        }

        // Preserve mode settings from original session
        const modeSettings = {
            permissionMode: normalizeSessionPermissionMode({
                flavor: session.metadata?.flavor,
                permissionMode: session.permissionMode,
                metadata: session.metadata,
            }),
            modelMode: session.modelMode,
            modelReasoningEffort: session.modelReasoningEffort
        }
        const invalidRefreshMetadataReason = getInvalidResumeMetadataReason(session.metadata)
        if (invalidRefreshMetadataReason) {
            return c.json({
                error: invalidRefreshMetadataReason === 'Session has invalid brainPreferences metadata; repair it before resuming'
                    ? 'Session has invalid brainPreferences metadata; repair it before refreshing account'
                    : invalidRefreshMetadataReason
            }, 409)
        }
        const resumeMetadata = extractResumeSpawnMetadata(session.metadata)
        const { yolo: refreshYolo, ...refreshExtras } = extractResumeSpawnExtras(session.metadata)
        const tokenSourceSpawnOptions = await resolveResumeTokenSourceSpawnOptions(
            store, storedForRefresh?.orgId ?? null, session.metadata, flavor
        )

        // Kill the old Claude process (fire-and-forget, tolerate failure)
        if (session.active) {
            try {
                await engine.killSession(sessionId)
            } catch (error) {
                console.warn(`[refresh-account] killSession failed for ${sessionId}:`, error)
            }
            // Wait for the old process to go inactive (max 10s)
            await waitForSessionInactive(engine, sessionId, 10_000)
        }

        // Pre-activate session in DB (same pattern as resume) so heartbeats are accepted
        const namespace = c.get('namespace')
        const now = Date.now()
        await store.setSessionActive(sessionId, true, now, namespace)
        session.active = true
        session.activeAt = now
        session.thinking = false

        // Extract Claude Code's internal session ID for --resume (full conversation history)
        const resumeSessionId = (() => {
            const value = session.metadata?.claudeSessionId
            return typeof value === 'string' && value.trim() ? value : undefined
        })()
        console.log(`[refresh-account] sessionId=${sessionId}, resumeSessionId=${resumeSessionId ?? 'NONE'}`)

        // Spawn new Claude process with the SAME YR session ID + Claude --resume
        const spawnResult = await engine.spawnSession(
            machineId,
            spawnTarget.directory,
            flavor,
            refreshYolo,
            { sessionId, resumeSessionId, ...modeSettings, ...resumeMetadata, ...refreshExtras, ...(tokenSourceSpawnOptions ?? {}) }
        )

        if (spawnResult.type !== 'success') {
            // Revert pre-activation on failure
            await store.setSessionActive(sessionId, false, Date.now(), namespace)
            session.active = false
            return c.json({ error: spawnResult.message }, 409)
        }

        const online = await waitForSessionOnline(engine, sessionId, RESUME_TIMEOUT_MS)
        if (!online) {
            // Revert pre-activation since process didn't come online
            await store.setSessionActive(sessionId, false, Date.now(), namespace)
            return c.json({ error: 'Session failed to come online after refresh' }, 409)
        }

        const hasSocket = await engine.waitForSocketInRoom(sessionId, 5000)
        if (!hasSocket) {
            console.warn(`[refresh-account] No socket joined room for session ${sessionId} within 5s, sending anyway`)
        }

        // Set createdBy after session is confirmed online
        const email = c.get('email')
        if (email) {
            void store.setSessionCreatedBy(sessionId, email, namespace)
        }

        // Only send init prompt and context if we couldn't use Claude --resume,
        // OR when we attempted --resume but Claude started a new backend session anyway.
        // (This happens when the session file can't be found under the new CLAUDE_CONFIG_DIR.)
        let resumeVerified = Boolean(resumeSessionId)
        let resumeMismatchSessionId: string | null = null
        if (resumeSessionId) {
            resumeMismatchSessionId = await waitForBackendSessionIdMismatch(
                engine,
                sessionId,
                'claude',
                resumeSessionId,
                RESUME_VERIFY_TIMEOUT_MS
            )
            if (resumeMismatchSessionId) {
                resumeVerified = false
                console.warn(
                    `[refresh-account] resume not applied: expected=${resumeSessionId}, actual=${resumeMismatchSessionId}; sending ResumeContext fallback`
                )
            }
        }

        if (!resumeSessionId || !resumeVerified) {
            const role = c.get('role')
            const userName = c.get('name')
            await sendInitPrompt(engine, store, sessionId, role, userName)

            const page = await engine.getMessagesPage(sessionId, { limit: RESUME_CONTEXT_MAX_LINES * 2, beforeSeq: null })
            const contextMessage = buildResumeContextMessage(session, page.messages)
            if (contextMessage) {
                await engine.sendMessage(sessionId, { text: contextMessage, sentFrom: 'webapp' })
            }
        }

        return c.json({
            type: 'success',
            sessionId,
            usedResume: Boolean(resumeSessionId),
            resumeVerified,
            resumeMismatchSessionId
        })
    })

    app.post('/sessions/:id/permission-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = permissionModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        const mode = parsed.data.mode
        const claudeModes = new Set(['bypassPermissions'])
        const codexModes = new Set(['default', 'read-only', 'safe-yolo', 'yolo'])

        if (flavor === 'gemini') {
            return c.json({ error: 'Permission mode not supported for Gemini sessions' }, 400)
        }

        if (flavor === 'codex' ? !codexModes.has(mode) : !claudeModes.has(mode)) {
            return c.json({ error: 'Invalid permission mode for session flavor' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, { permissionMode: mode })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply permission mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/model', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const body = await c.req.json().catch(() => null)
        const parsed = modelModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor === 'gemini') {
            return c.json({ error: 'Model mode is not supported for Gemini sessions' }, 400)
        }

        const claudeModels = new Set(['default', 'sonnet', 'opus', 'opus-4-7'])
        const codexModels = new Set(['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2'])
        const grokModels = new Set(['grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-code-fast-1', 'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning', 'grok-4-0709', 'grok-3-mini', 'grok-3'])
        const reasoningLevels = new Set(['low', 'medium', 'high', 'xhigh'])

        if (flavor === 'claude' && !claudeModels.has(parsed.data.model)) {
            return c.json({ error: 'Invalid model for Claude sessions' }, 400)
        }
        if (flavor === 'codex' && parsed.data.model !== 'default' && !codexModels.has(parsed.data.model)) {
            return c.json({ error: 'Invalid model for Codex sessions' }, 400)
        }
        if (flavor === 'grok' && parsed.data.model !== 'default' && !grokModels.has(parsed.data.model)) {
            return c.json({ error: 'Invalid model for Grok sessions' }, 400)
        }
        // OpenRouter accepts any model string (provider/model format)
        if (flavor === 'openrouter' && !parsed.data.model.includes('/')) {
            return c.json({ error: 'Invalid model for OpenRouter sessions (expected format: provider/model)' }, 400)
        }
        if (parsed.data.reasoningEffort && !reasoningLevels.has(parsed.data.reasoningEffort)) {
            return c.json({ error: 'Invalid reasoning level' }, 400)
        }

        try {
            console.log('[session model] apply', {
                sessionId: sessionResult.sessionId,
                flavor,
                model: parsed.data.model,
                reasoningEffort: parsed.data.reasoningEffort ?? null
            })
            const applied = await engine.applySessionConfig(sessionResult.sessionId, {
                modelMode: parsed.data.model,
                modelReasoningEffort: parsed.data.reasoningEffort
            })
            console.log('[session model] applied', {
                sessionId: sessionResult.sessionId,
                applied
            })
            return c.json({ ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to apply model mode'
            return c.json({ error: message }, 409)
        }
    })

    app.post('/sessions/:id/fast-mode', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const flavor = sessionResult.session.metadata?.flavor ?? 'claude'
        if (flavor !== 'claude') {
            return c.json({ error: 'Fast mode is only supported for Claude sessions' }, 400)
        }

        const body = await c.req.json().catch(() => null)
        if (!body || typeof body.fastMode !== 'boolean') {
            return c.json({ error: 'Invalid body, expected { fastMode: boolean }' }, 400)
        }

        try {
            await engine.applySessionConfig(sessionResult.sessionId, {
                fastMode: body.fastMode
            })
            return c.json({ ok: true, fastMode: body.fastMode })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to toggle fast mode'
            return c.json({ error: message }, 409)
        }
    })

    app.get('/sessions/:id/slash-commands', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        // Session must exist but doesn't need to be active
        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        // Get agent type from session metadata, default to 'claude'
        const agent = sessionResult.session.metadata?.flavor ?? 'claude'
        engine.noteResumeClientEvent(sessionResult.sessionId, 'slash-commands-get')

        try {
            const result = await engine.listSlashCommands(sessionResult.sessionId, agent)
            return c.json(result)
        } catch (error) {
            return c.json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to list slash commands'
            })
        }
    })

    // 获取在线用户
    app.get('/online-users', (c) => {
        const sseManager = getSseManager()
        if (!sseManager) {
            return c.json({ users: [] })
        }

        const namespace = c.get('namespace')
        const users = sseManager.getOnlineUsers(namespace)
        return c.json({ users })
    })

    // 广播用户输入状态
    app.post('/sessions/:id/typing', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        engine.noteResumeClientEvent(sessionResult.sessionId, 'typing')

        const body = await c.req.json().catch(() => null)
        if (!body || typeof body.text !== 'string') {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const email = c.get('email') ?? 'anonymous'
        const clientId = c.get('clientId') ?? 'unknown'
        const namespace = c.get('namespace')

        // 广播 typing 事件给同一 session 的其他用户
        engine.emit({
            type: 'typing-changed',
            namespace,
            sessionId: sessionResult.sessionId,
            typing: {
                email,
                clientId,
                text: body.text,
                updatedAt: Date.now()
            }
        })

        return c.json({ ok: true })
    })

    // ==================== Session Notification Subscriptions ====================

    /**
     * 订阅 session 通知
     * POST /sessions/:id/subscribe
     * Body: { chatId?: string, clientId?: string }
     * 至少需要提供 chatId 或 clientId 其中之一
     */
    app.post('/sessions/:id/subscribe', async (c) => {
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)

        if (!body) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const chatId = typeof body.chatId === 'string' ? body.chatId : null
        const clientId = typeof body.clientId === 'string' ? body.clientId : null

        if (!chatId && !clientId) {
            return c.json({ error: 'Either chatId or clientId is required' }, 400)
        }

        let subscription
        if (chatId) {
            subscription = await store.subscribeToSessionNotifications(sessionId, chatId, namespace)
        } else if (clientId) {
            subscription = await store.subscribeToSessionNotificationsByClientId(sessionId, clientId, namespace)
        }

        if (!subscription) {
            return c.json({ error: 'Failed to subscribe' }, 500)
        }

        return c.json({ ok: true, subscription })
    })

    /**
     * 取消订阅 session 通知
     * DELETE /sessions/:id/subscribe
     * Body: { chatId?: string, clientId?: string }
     */
    app.delete('/sessions/:id/subscribe', async (c) => {
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)

        if (!body) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const chatId = typeof body.chatId === 'string' ? body.chatId : null
        const clientId = typeof body.clientId === 'string' ? body.clientId : null

        if (!chatId && !clientId) {
            return c.json({ error: 'Either chatId or clientId is required' }, 400)
        }

        let success = false
        if (chatId) {
            // First try to remove from subscriptions table
            success = await store.unsubscribeFromSessionNotifications(sessionId, chatId)
            // Also check if this chatId is the creator and clear it
            const creatorChatId = await store.getSessionCreatorChatId(sessionId)
            if (creatorChatId === chatId) {
                const cleared = await store.clearSessionCreatorChatId(sessionId, namespace)
                success = success || cleared
            }
        } else if (clientId) {
            success = await store.unsubscribeFromSessionNotificationsByClientId(sessionId, clientId)
        }

        return c.json({ ok: success })
    })

    /**
     * 获取 session 的所有订阅者
     * GET /sessions/:id/subscribers
     */
    app.get('/sessions/:id/subscribers', async (c) => {
        const sessionId = c.req.param('id')
        const chatIdSubscribers = await store.getSessionNotificationSubscribers(sessionId)
        const clientIdSubscribers = await store.getSessionNotificationSubscriberClientIds(sessionId)
        const creatorChatId = await store.getSessionCreatorChatId(sessionId)
        const recipients = await store.getSessionNotificationRecipients(sessionId)

        return c.json({
            sessionId,
            creatorChatId,
            subscribers: chatIdSubscribers,          // Telegram chatId 订阅者
            clientIdSubscribers: clientIdSubscribers, // clientId 订阅者
            totalRecipients: recipients.length + clientIdSubscribers.length
        })
    })

    /**
     * 设置 session 的创建者 chatId
     * POST /sessions/:id/creator
     * Body: { chatId: string }
     */
    app.post('/sessions/:id/creator', async (c) => {
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const body = await c.req.json().catch(() => null)

        if (!body || typeof body.chatId !== 'string') {
            return c.json({ error: 'Invalid body, expected { chatId: string }' }, 400)
        }

        const success = await store.setSessionCreatorChatId(sessionId, body.chatId, namespace)
        return c.json({ ok: success })
    })

    /**
     * 移除指定订阅者（owner 或任何人都可以操作）
     * DELETE /sessions/:id/subscribers/:subscriberId
     * subscriberId 可以是 chatId 或 clientId
     * Query: type=chatId|clientId （可选，默认为 chatId）
     */
    app.delete('/sessions/:id/subscribers/:subscriberId', async (c) => {
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')
        const subscriberId = c.req.param('subscriberId')
        const type = c.req.query('type') || 'chatId'

        let success = false
        if (type === 'clientId') {
            success = await store.unsubscribeFromSessionNotificationsByClientId(sessionId, subscriberId)
        } else {
            // chatId - 同时检查是否是 creator
            success = await store.unsubscribeFromSessionNotifications(sessionId, subscriberId)
            const creatorChatId = await store.getSessionCreatorChatId(sessionId)
            if (creatorChatId === subscriberId) {
                const cleared = await store.clearSessionCreatorChatId(sessionId, namespace)
                success = success || cleared
            }
        }

        return c.json({ ok: success })
    })

    /**
     * 清除所有订阅者（owner 操作）
     * DELETE /sessions/:id/subscribers
     * 清除所有订阅者，包括 creator
     */
    app.delete('/sessions/:id/subscribers', async (c) => {
        const sessionId = c.req.param('id')
        const namespace = c.get('namespace')

        // 清除所有 chatId 订阅者
        const chatIdSubscribers = await store.getSessionNotificationSubscribers(sessionId)
        for (const chatId of chatIdSubscribers) {
            await store.unsubscribeFromSessionNotifications(sessionId, chatId)
        }

        // 清除所有 clientId 订阅者
        const clientIdSubscribers = await store.getSessionNotificationSubscriberClientIds(sessionId)
        for (const clientId of clientIdSubscribers) {
            await store.unsubscribeFromSessionNotificationsByClientId(sessionId, clientId)
        }

        // 清除 creator
        await store.clearSessionCreatorChatId(sessionId, namespace)

        return c.json({
            ok: true,
            removed: {
                chatIds: chatIdSubscribers.length,
                clientIds: clientIdSubscribers.length,
                creator: true
            }
        })
    })

    // ==================== Session Shares (Keycloak用户之间的session共享) ====================

    /**
     * 获取session的共享列表
     * GET /sessions/:id/shares
     */
    app.get('/sessions/:id/shares', async (c) => {
        const sessionId = c.req.param('id')
        const email = c.get('email')

        if (!email) {
            return c.json({ error: 'Email required' }, 400)
        }

        // 验证session存在且用户有权限（是创建者或已被共享）
        const storedSession = await store.getSession(sessionId)
        if (!storedSession) {
            return c.json({ error: 'Session not found' }, 404)
        }

        // 检查权限：必须是创建者或已被共享的用户
        if (storedSession.createdBy !== email) {
            const isShared = await store.isSessionSharedWith(sessionId, email)
            if (!isShared) {
                return c.json({ error: 'Forbidden' }, 403)
            }
        }

        const shares = await store.getSessionShares(sessionId)
        return c.json({ shares })
    })

    /**
     * 添加session共享
     * POST /sessions/:id/shares
     * Body: { email: string }
     */
    app.post('/sessions/:id/shares', async (c) => {
        const sessionId = c.req.param('id')
        const email = c.get('email')

        if (!email) {
            return c.json({ error: 'Email required' }, 400)
        }

        const body = await c.req.json().catch(() => null)
        if (!body || typeof body.email !== 'string') {
            return c.json({ error: 'Invalid body, expected { email: string }' }, 400)
        }

        const sharedWithEmail = body.email.trim()

        // 验证session存在
        const storedSession = await store.getSession(sessionId)
        if (!storedSession) {
            return c.json({ error: 'Session not found' }, 404)
        }

        // 只有创建者可以分享
        if (storedSession.createdBy !== email) {
            return c.json({ error: 'Only session owner can share' }, 403)
        }

        // 不能分享给自己
        if (sharedWithEmail === email) {
            return c.json({ error: 'Cannot share with yourself' }, 400)
        }

        // 验证被分享用户存在于allowed_emails中
        const isAllowed = await store.isEmailAllowed(sharedWithEmail)
        if (!isAllowed) {
            return c.json({ error: 'User not found' }, 404)
        }

        const success = await store.addSessionShare(sessionId, sharedWithEmail, email)
        if (!success) {
            return c.json({ error: 'Failed to share session' }, 500)
        }

        return c.json({ ok: true })
    })

    /**
     * 移除session共享
     * DELETE /sessions/:id/shares/:email
     */
    app.delete('/sessions/:id/shares/:email', async (c) => {
        const sessionId = c.req.param('id')
        const email = c.get('email')
        const sharedWithEmail = c.req.param('email')

        if (!email) {
            return c.json({ error: 'Email required' }, 400)
        }

        // 验证session存在
        const storedSession = await store.getSession(sessionId)
        if (!storedSession) {
            return c.json({ error: 'Session not found' }, 404)
        }

        // 只有创建者可以移除共享
        if (storedSession.createdBy !== email) {
            return c.json({ error: 'Only session owner can unshare' }, 403)
        }

        const success = await store.removeSessionShare(sessionId, sharedWithEmail)
        return c.json({ ok: success })
    })

    /**
     * 获取所有允许的用户列表（用于分享时选择）
     * GET /users/allowed
     */
    app.get('/users/allowed', async (c) => {
        const allowedUsers = await store.getAllowedUsers()
        return c.json({ users: allowedUsers.map(u => ({ email: u.email, role: u.role })) })
    })

    // ==================== Session Privacy Mode (私密模式) ====================

    /**
     * 获取session的隐私模式
     * GET /sessions/:id/privacy-mode
     */
    app.get('/sessions/:id/privacy-mode', async (c) => {
        const sessionId = c.req.param('id')
        const email = c.get('email')

        // 验证session存在
        const storedSession = await store.getSession(sessionId)
        if (!storedSession) {
            return c.json({ error: 'Session not found' }, 404)
        }

        // 检查权限：必须是创建者
        if (storedSession.createdBy !== email) {
            return c.json({ error: 'Forbidden' }, 403)
        }

        const privacyMode = await store.getSessionPrivacyMode(sessionId)
        return c.json({ privacyMode })
    })

    /**
     * 设置session的隐私模式
     * PUT /sessions/:id/privacy-mode
     * Body: { privacyMode: boolean }
     */
    app.put('/sessions/:id/privacy-mode', async (c) => {
        const sessionId = c.req.param('id')
        const email = c.get('email')
        const namespace = c.get('namespace')

        if (!email) {
            return c.json({ error: 'Email required' }, 400)
        }

        const body = await c.req.json().catch(() => null)
        if (!body || typeof body.privacyMode !== 'boolean') {
            return c.json({ error: 'Invalid body, expected { privacyMode: boolean }' }, 400)
        }

        // 验证session存在
        const storedSession = await store.getSession(sessionId)
        if (!storedSession) {
            return c.json({ error: 'Session not found' }, 404)
        }

        // 只有创建者可以设置隐私模式
        if (storedSession.createdBy !== email) {
            return c.json({ error: 'Only session owner can set privacy mode' }, 403)
        }

        const success = await store.setSessionPrivacyMode(sessionId, body.privacyMode, namespace)
        if (!success) {
            return c.json({ error: 'Failed to set privacy mode' }, 500)
        }

        return c.json({ ok: true, privacyMode: body.privacyMode })
    })

    return app
}
