import { Hono } from 'hono'
import { z } from 'zod'
import type { DecryptedMessage, Session, SyncEngine } from '../../sync/syncEngine'
import type { SSEManager } from '../../sse/sseManager'
import type { IStore, UserRole, StoredSession } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { resolveTokenSourceForAgent } from '../tokenSources'
import { requireMachine, requireSessionFromParam, requireSessionFromParamWithShareCheck, requireSyncEngine } from './guards'
import { buildInitPrompt, buildBrainInitPrompt } from '../prompts/initPrompt'
import { getLicenseService } from '../../license/licenseService'
import {
    BRAIN_CLAUDE_CHILD_MODELS,
    buildBrainSessionPreferences,
    extractBrainChildModelDefaults,
    extractBrainSessionPreferencesFromMetadata,
} from '../../brain/brainSessionPreferences'
import { getUnsupportedSessionSourceError, isSupportedSessionSource } from '../../sessionSourcePolicy'

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
}

type SessionViewer = {
    email: string
    clientId: string
    deviceType?: string
}

type SessionSummary = {
    id: string
    active: boolean
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
    viewers?: SessionViewer[]
    terminationReason?: string
}

function toSessionSummary(session: Session): SessionSummary {
    const pendingRequestsCount = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0

    const metadata: SessionSummaryMetadata | null = session.metadata ? {
        name: session.metadata.name,
        path: session.metadata.path,
        machineId: session.metadata.machineId ?? undefined,
        source: session.metadata.source,
        summary: session.metadata.summary ? { text: session.metadata.summary.text } : undefined,
        flavor: session.metadata.flavor ?? null,
        runtimeAgent: session.metadata.runtimeAgent,
        runtimeModel: session.metadata.runtimeModel,
        runtimeModelReasoningEffort: session.metadata.runtimeModelReasoningEffort,
        worktree: session.metadata.worktree,
        privacyMode: session.metadata.privacyMode === true ? true : undefined,
    } : null

    const todoProgress = session.todos?.length ? {
        completed: session.todos.filter(t => t.status === 'completed').length,
        total: session.todos.length
    } : null

    return {
        id: session.id,
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
        terminationReason: session.terminationReason,
    }
}

// Convert StoredSession (from database) to SessionSummary
function storedSessionToSummary(stored: StoredSession): SessionSummary {
    const meta = stored.metadata as SessionSummaryMetadata | null
    const todos = stored.todos as Array<{ status: string }> | null

    const todoProgress = todos?.length ? {
        completed: todos.filter(t => t.status === 'completed').length,
        total: todos.length
    } : null

    return {
        id: stored.id,
        active: stored.active,
        activeAt: stored.activeAt ?? stored.updatedAt,
        updatedAt: stored.updatedAt,
        lastMessageAt: stored.lastMessageAt,
        createdBy: stored.createdBy ?? undefined,
        metadata: meta,
        todoProgress,
        pendingRequestsCount: 0,  // Offline sessions have no pending requests
        thinking: false,
        modelMode: stored.modelMode as Session['modelMode'] | undefined,
        modelReasoningEffort: stored.modelReasoningEffort as Session['modelReasoningEffort'] | undefined,
        fastMode: stored.fastMode ?? undefined,
        terminationReason: stored.terminationReason ?? undefined,
    }
}

const permissionModeValues = ['bypassPermissions', 'read-only', 'safe-yolo', 'yolo'] as const
const modelModeValues = ['default', 'sonnet', 'opus', 'glm-5.1', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'] as const
const reasoningEffortValues = ['low', 'medium', 'high', 'xhigh'] as const
const claudeModelValues = ['sonnet', 'opus'] as const

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
    openrouterModel: z.string().min(1).optional(),
    permissionMode: z.enum(permissionModeValues).optional(),
    modelMode: z.enum(modelModeValues).optional(),
    modelReasoningEffort: z.enum(reasoningEffortValues).optional(),
    source: z.string().min(1).max(100).optional(),
})

const createBrainSessionSchema = z.object({
    machineId: z.string().min(1).optional(),
    agent: z.enum(['claude', 'codex']).optional(),
    tokenSourceId: z.string().min(1).optional(),
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

const RESUME_TIMEOUT_MS = 60_000
const RESUME_CONTEXT_MAX_LINES = 60
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

async function waitForSessionOnline(engine: SyncEngine, sessionId: string, timeoutMs: number): Promise<boolean> {
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

async function sendInitPrompt(engine: SyncEngine, sessionId: string, role: UserRole, userName?: string | null): Promise<void> {
    const session = engine.getSession(sessionId)
    const projectRoot = session?.metadata?.path?.trim() || null
    const source = session?.metadata?.source
    const brainPreferences = extractBrainSessionPreferencesFromMetadata((session?.metadata as Record<string, unknown> | null | undefined) ?? null)
    console.log(`[sendInitPrompt] sessionId=${sessionId}, role=${role}, projectRoot=${projectRoot}, userName=${userName}, source=${source}`)
    const prompt = source === 'brain'
        ? await buildBrainInitPrompt(role, { projectRoot, userName, brainPreferences })
        : await buildInitPrompt(role, { projectRoot, userName })
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

async function sendInitPromptAfterOnline(engine: SyncEngine, sessionId: string, role: UserRole, userName?: string | null): Promise<void> {
    const isOnline = await waitForSessionOnline(engine, sessionId, 60_000)
    if (!isOnline) {
        return
    }
    await sendInitPrompt(engine, sessionId, role, userName)
}

async function resolveSpawnTarget(
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

function extractUserText(content: unknown): string | null {
    if (!content || typeof content !== 'object') {
        return null
    }
    const record = content as Record<string, unknown>
    if (record.role !== 'user') {
        return null
    }
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

function buildResumeContextMessage(session: Session, messages: DecryptedMessage[]): string | null {
    const summary = session.metadata?.summary?.text?.trim()
    const lines: string[] = [
        '#InitPrompt-ResumeContext',
        '以下是从旧会话自动迁移的上下文（可能不完整）：'
    ]
    if (summary) {
        lines.push(`摘要：${summary}`)
    }

    const dialogLines: string[] = []
    for (const message of messages) {
        const userText = extractUserText(message.content)
        if (userText) {
            dialogLines.push(`用户：${userText}`)
            continue
        }
        const agentText = extractAgentText(message.content)
        if (agentText) {
            dialogLines.push(`助手：${agentText}`)
        }
    }

    if (dialogLines.length > RESUME_CONTEXT_MAX_LINES) {
        dialogLines.splice(0, dialogLines.length - RESUME_CONTEXT_MAX_LINES)
    }

    if (dialogLines.length > 0) {
        lines.push('最近对话片段：')
        lines.push(...dialogLines)
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
                openrouterModel: parsed.data.openrouterModel,
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
                await sendInitPrompt(engine, result.sessionId, role, userName)
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
        const childClaudeModels = parsed.data.childClaudeModels ?? childModelDefaults.childClaudeModels
        const childCodexModels = parsed.data.childCodexModels ?? childModelDefaults.childCodexModels

        // License check
        const licenseError = await checkSessionLicense(c, orgId)
        if (licenseError) return licenseError

        if ((childClaudeModels?.length ?? 0) === 0 && (childCodexModels?.length ?? 0) === 0) {
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
        }

        let result: Awaited<ReturnType<typeof engine.spawnSession>> | null = null
        for (const machine of compatibleMachines) {
            const homeDir = machine.metadata?.homeDir || '/tmp'
            const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`
            const brainPreferences = buildBrainSessionPreferences({
                machineSelectionMode: requestedMachineId ? 'manual' : 'auto',
                machineId: machine.id,
                childClaudeModels,
                childCodexModels,
            })
            const candidate = await engine.spawnSession(
                machine.id,
                brainDirectory,
                requestedAgent,
                true,        // yolo
                {
                    source: 'brain',
                    permissionMode: 'bypassPermissions',
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
            return c.json({ type: 'error', message: `Failed to create Brain session with agent "${requestedAgent}"` }, 503)
        }

        if (result.type === 'success') {
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
                await sendInitPrompt(engine, result.sessionId, role, userName)
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

            // Start with database data
            const summary = storedSessionToSummary(stored)

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

        // Sort: active first, then by pending requests, then by lastMessageAt (fallback updatedAt)
        const allSessions = sessionSummaries.sort((a, b) => {
            // Active sessions first
            if (a.active !== b.active) {
                return a.active ? -1 : 1
            }
            // Within active sessions, sort by pending requests count
            if (a.active && a.pendingRequestsCount !== b.pendingRequestsCount) {
                return b.pendingRequestsCount - a.pendingRequestsCount
            }
            // Then by lastMessageAt (fallback updatedAt for sessions with no real messages yet)
            return (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt)
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

        const shouldTerminate = sessionResult.session.active
        const forceParam = c.req.query('force')
        const force = forceParam === '1' || forceParam === 'true'
        try {
            const deleted = await engine.deleteSession(sessionResult.sessionId, { terminateSession: shouldTerminate, force })
            if (!deleted) {
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
            permissionMode: session.permissionMode,
            modelMode: session.modelMode,
            modelReasoningEffort: session.modelReasoningEffort
        }

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
            undefined,
            { sessionId, resumeSessionId, ...modeSettings }
        )

        if (resumeAttempt.type === 'success') {
            const online = await waitForSessionOnline(engine, sessionId, RESUME_TIMEOUT_MS)
            if (online) {
                // Set createdBy after session is confirmed online (exists in DB)
                const email = c.get('email')
                if (email) {
                    const namespace = c.get('namespace')
                    void store.setSessionCreatedBy(sessionId, email, namespace)
                }
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
            undefined,
            { resumeSessionId, ...modeSettings }
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

        const role = c.get('role')  // Role from Keycloak token
        const userName = c.get('name')
        await sendInitPrompt(engine, newSessionId, role, userName)

        if (!resumeSessionId) {
            const page = await engine.getMessagesPage(sessionId, { limit: RESUME_CONTEXT_MAX_LINES * 2, beforeSeq: null })
            const contextMessage = buildResumeContextMessage(session, page.messages)
            if (contextMessage) {
                await engine.sendMessage(newSessionId, { text: contextMessage, sentFrom: 'webapp' })
            }
        }

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
            permissionMode: session.permissionMode,
            modelMode: session.modelMode,
            modelReasoningEffort: session.modelReasoningEffort
        }

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
            undefined,
            { sessionId, resumeSessionId, ...modeSettings }
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
            await sendInitPrompt(engine, sessionId, role, userName)

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

        const claudeModels = new Set(['default', 'sonnet', 'opus'])
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
