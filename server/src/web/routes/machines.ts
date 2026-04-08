import { Hono } from 'hono'
import { z } from 'zod'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { IStore, UserRole } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'
import { buildInitPrompt } from '../prompts/initPrompt'
import { requireMachine } from './guards'
import { isMachineBlocked } from './blocklist'
import { serializeMachine, sortMachinesForDisplay } from './machinePayload'

const spawnBodySchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'codez', 'opencode', 'gemini', 'glm', 'minimax', 'grok', 'openrouter', 'aider-cli', 'droid']).optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    claudeSettingsType: z.enum(['litellm', 'claude']).optional(),
    claudeAgent: z.string().min(1).optional(),
    opencodeModel: z.string().min(1).optional(),
    opencodeVariant: z.string().min(1).optional(),
    claudeModel: z.enum(['sonnet', 'opus', 'glm-5.1']).optional(),
    codexModel: z.string().min(1).optional(),
    droidModel: z.string().min(1).optional(),
    droidReasoningEffort: z.string().min(1).optional(),
    modelReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    source: z.string().min(1).max(100).optional()
})

const modelModeValues = ['default', 'sonnet', 'opus', 'glm-5.1', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'] as const
const isModelMode = (value: string): value is NonNullable<Session['modelMode']> => {
    return (modelModeValues as readonly string[]).includes(value)
}

const pathsExistsSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

async function sendInitPrompt(engine: SyncEngine, sessionId: string, role: UserRole, userName?: string | null, machineId?: string): Promise<void> {
    try {
        const session = engine.getSession(sessionId)
        const projectRoot = session?.metadata?.path?.trim()
            || session?.metadata?.worktree?.basePath?.trim()
            || null

        console.log(`[machines/sendInitPrompt] sessionId=${sessionId}, role=${role}, projectRoot=${projectRoot}, userName=${userName}`)
        const prompt = await buildInitPrompt(role, { projectRoot, userName })
        if (!prompt.trim()) {
            console.warn(`[machines/sendInitPrompt] Empty prompt for session ${sessionId}, skipping`)
            return
        }
        console.log(`[machines/sendInitPrompt] Sending prompt to session ${sessionId}, length=${prompt.length}`)
        await engine.sendMessage(sessionId, {
            text: prompt,
            sentFrom: 'webapp'
        })
        console.log(`[machines/sendInitPrompt] Successfully sent init prompt to session ${sessionId}`)
    } catch (err) {
        console.error(`[machines/sendInitPrompt] Failed for session ${sessionId}:`, err)
    }
}

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


export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null, store: IStore, getSseManager?: () => SSEManager | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const orgId = c.req.query('orgId')
        const machines = engine.getMachinesByNamespace(namespace)
            .filter((machine) => !orgId || machine.orgId === orgId || machine.orgId == null)
            .filter((m) => !isMachineBlocked(m))
        return c.json({ machines: sortMachinesForDisplay(machines).map(serializeMachine) })
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = spawnBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const rawSource = parsed.data.source?.trim()
        const source = rawSource ? rawSource : 'external-api'

        // 将 claudeModel / codexModel 转换为 modelMode
        let modelMode: Session['modelMode'] | undefined
        if (parsed.data.claudeModel) {
            modelMode = parsed.data.claudeModel
        } else if (parsed.data.codexModel) {
            const maybeModelMode = parsed.data.codexModel.replace('openai/', '')
            if (isModelMode(maybeModelMode)) {
                modelMode = maybeModelMode
            }
        }

        // Default worktreeName to caller's email slug when not specified
        let worktreeName = parsed.data.worktreeName
        if (parsed.data.sessionType === 'worktree' && !worktreeName) {
            const email = c.get('email')
            if (email) {
                worktreeName = email.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
            }
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.yolo,
            parsed.data.sessionType,
            worktreeName,
            { claudeSettingsType: parsed.data.claudeSettingsType, claudeAgent: parsed.data.claudeAgent, opencodeModel: parsed.data.opencodeModel, opencodeVariant: parsed.data.opencodeVariant, codexModel: parsed.data.codexModel, droidModel: parsed.data.droidModel, droidReasoningEffort: parsed.data.droidReasoningEffort, modelMode, modelReasoningEffort: parsed.data.modelReasoningEffort, source }
        )

        // 如果 spawn 成功，等 session online 后设置 createdBy 并发送初始化 prompt
        if (result.type === 'success') {
            const email = c.get('email')
            const namespace = c.get('namespace')
            const role = c.get('role')  // Role from Keycloak token
            const userName = c.get('name')
            // Wait for session to be online, then set createdBy and send init prompt
            void (async () => {
                console.log(`[machines/spawn] Waiting for session ${result.sessionId} to come online...`)
                const isOnline = await waitForSessionOnline(engine, result.sessionId, 60_000)
                if (!isOnline) {
                    console.warn(`[machines/spawn] Session ${result.sessionId} did not come online within 60s, skipping init prompt`)
                    return
                }
                console.log(`[machines/spawn] Session ${result.sessionId} is online, waiting for socket to join room...`)
                // Wait for CLI socket to actually join the session room (not just session-alive)
                const hasSocket = await engine.waitForSocketInRoom(result.sessionId, 5000)
                if (!hasSocket) {
                    console.warn(`[machines/spawn] No socket joined room for session ${result.sessionId} within 5s, sending anyway`)
                }
                console.log(`[machines/spawn] Sending init prompt to session ${result.sessionId}`)
                // Set createdBy after session is confirmed online (exists in DB)
                if (email) {
                    await store.setSessionCreatedBy(result.sessionId, email, namespace)
                }
                const orgId = c.req.query('orgId')
                if (orgId) {
                    await store.setSessionOrgId(result.sessionId, orgId, namespace)
                }
                await sendInitPrompt(engine, result.sessionId, role, userName, machineId)
            })().catch((err: unknown) => {
                console.error(`[machines/spawn] Post-spawn setup failed for session ${result.sessionId}:`, err)
            })
        }

        return c.json(result)
    })

    app.post('/machines/:id/paths/exists', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const machineId = c.req.param('id')
        const machine = requireMachine(c, engine, machineId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = pathsExistsSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const uniquePaths = Array.from(new Set(parsed.data.paths.map((path) => path.trim()).filter(Boolean)))
        if (uniquePaths.length === 0) {
            return c.json({ exists: {} })
        }

        try {
            const exists = await engine.checkPathsExist(machineId, uniquePaths)
            return c.json({ exists })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Failed to check paths' }, 500)
        }
    })

    return app
}
