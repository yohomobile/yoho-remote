import { Hono } from 'hono'
import { z } from 'zod'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { IStore, UserRole } from '../../store'
import type { BrainStore } from '../../brain/store'
import type { AutoBrainService } from '../../brain/autoBrain'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'
import { buildInitPrompt } from '../prompts/initPrompt'
import { requireMachine } from './guards'
import { isMachineBlocked } from './blocklist'

const spawnBodySchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'opencode']).optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    claudeSettingsType: z.enum(['litellm', 'claude']).optional(),
    claudeAgent: z.string().min(1).optional(),
    opencodeModel: z.string().min(1).optional(),
    opencodeVariant: z.string().min(1).optional(),
    codexModel: z.string().min(1).optional(),
    modelReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    enableBrain: z.boolean().optional(),
    source: z.string().min(1).max(100).optional()
})

const modelModeValues = ['default', 'sonnet', 'opus', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.2'] as const
const isModelMode = (value: string): value is NonNullable<Session['modelMode']> => {
    return (modelModeValues as readonly string[]).includes(value)
}

const pathsExistsSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

async function sendInitPrompt(engine: SyncEngine, sessionId: string, role: UserRole, userName?: string | null, hasBrain?: boolean): Promise<void> {
    try {
        const session = engine.getSession(sessionId)
        const projectRoot = session?.metadata?.path?.trim()
            || session?.metadata?.worktree?.basePath?.trim()
            || null
        console.log(`[machines/sendInitPrompt] sessionId=${sessionId}, role=${role}, projectRoot=${projectRoot}, userName=${userName}, hasBrain=${hasBrain}`)
        const prompt = await buildInitPrompt(role, { projectRoot, userName, hasBrain })
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


export function createMachinesRoutes(getSyncEngine: () => SyncEngine | null, store: IStore, brainStore?: BrainStore, autoBrainService?: AutoBrainService, getSseManager?: () => SSEManager | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const namespace = c.get('namespace')
        const machines = engine.getOnlineMachinesByNamespace(namespace)
            .filter((m) => !isMachineBlocked(m))
        return c.json({ machines })
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

        // 将 codexModel 转换为 modelMode（如 'openai/gpt-5.3-codex' -> 'gpt-5.3-codex'）
        let modelMode: Session['modelMode'] | undefined
        if (parsed.data.codexModel) {
            const maybeModelMode = parsed.data.codexModel.replace('openai/', '')
            if (isModelMode(maybeModelMode)) {
                modelMode = maybeModelMode
            }
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            parsed.data.agent,
            parsed.data.yolo,
            parsed.data.sessionType,
            parsed.data.worktreeName,
            { claudeSettingsType: parsed.data.claudeSettingsType, claudeAgent: parsed.data.claudeAgent, opencodeModel: parsed.data.opencodeModel, opencodeVariant: parsed.data.opencodeVariant, codexModel: parsed.data.codexModel, modelMode, modelReasoningEffort: parsed.data.modelReasoningEffort, source }
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
                await sendInitPrompt(engine, result.sessionId, role, userName, parsed.data.enableBrain)

                // 如果启用 Brain，spawn 常驻 Brain session（与主 session 同样有持久 Claude 进程）
                if (parsed.data.enableBrain && brainStore) {
                    try {
                        console.log(`[machines/spawn] Creating persistent Brain session for ${result.sessionId}...`)

                        const existing = await brainStore.getActiveBrainSession(result.sessionId)
                        if (existing) {
                            console.log(`[machines/spawn] Brain session already exists: ${existing.id}`)
                            return
                        }

                        const mainSession = engine.getSession(result.sessionId)
                        const directory = mainSession?.metadata?.path
                        if (directory) {
                            // Spawn 真正的 Brain session（有持久 Claude 进程）
                            const brainSpawnResult = await engine.spawnSession(
                                machineId,
                                directory,
                                'claude',
                                false,  // yolo
                                'simple',
                                undefined,
                                {
                                    permissionMode: 'bypassPermissions',
                                    source: 'brain-sdk',
                                    mainSessionId: result.sessionId,
                                }
                            )

                            if (brainSpawnResult.type !== 'success') {
                                console.error(`[machines/spawn] Failed to spawn Brain session: ${brainSpawnResult.message}`)
                                return
                            }

                            const brainSessionId = brainSpawnResult.sessionId
                            console.log(`[machines/spawn] Brain session spawned: ${brainSessionId}`)

                            if (email) {
                                await store.setSessionCreatedBy(brainSessionId, email, namespace)
                            }

                            // 等待 Brain session 上线
                            console.log(`[machines/spawn] Waiting for Brain session ${brainSessionId} to come online...`)
                            const brainOnline = await waitForSessionOnline(engine, brainSessionId, 60_000)
                            if (!brainOnline) {
                                console.warn(`[machines/spawn] Brain session ${brainSessionId} did not come online within 60s`)
                                return
                            }
                            await engine.waitForSocketInRoom(brainSessionId, 5000)

                            // 发送 Brain init prompt（禁用所有内置 tools，只保留 MCP tools）
                            const brainInitPrompt = await buildInitPrompt(role, { isBrain: true, userName })
                            if (brainInitPrompt.trim()) {
                                await engine.sendMessage(brainSessionId, {
                                    text: brainInitPrompt,
                                    sentFrom: 'webapp',
                                    meta: {
                                        disallowedTools: [
                                            'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
                                            'Task', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit'
                                        ]
                                    }
                                })
                                console.log(`[machines/spawn] Sent init prompt to Brain session ${brainSessionId} (built-in tools disabled, MCP only)`)
                            }

                            // 构建上下文
                            const page = await engine.getMessagesPage(result.sessionId, { limit: 20, beforeSeq: null })
                            const contextMessages: string[] = []
                            for (const m of page.messages) {
                                const content = m.content as Record<string, unknown> | null
                                if (!content || content.role !== 'user') continue
                                const body = content.content as Record<string, unknown> | string | undefined
                                if (!body) continue
                                if (typeof body === 'string') {
                                    const trimmed = body.trim()
                                    if (trimmed) contextMessages.push(trimmed)
                                } else if (typeof body === 'object' && body.type === 'text' && typeof body.text === 'string') {
                                    const trimmed = (body.text as string).trim()
                                    if (trimmed) contextMessages.push(trimmed)
                                }
                            }
                            const contextSummary = contextMessages.join('\n') || 'New session'

                            // 创建 Brain session 记录
                            const brainSession = await brainStore.createBrainSession({
                                namespace,
                                mainSessionId: result.sessionId,
                                brainSessionId,
                                brainModel: 'claude',
                                contextSummary,
                            })
                            console.log(`[machines/spawn] Brain session record created: ${brainSession.id}`)

                            await brainStore.updateBrainSessionStatus(brainSession.id, 'active')

                            // SSE 广播 brain-ready
                            const sseManager = getSseManager?.()
                            if (sseManager) {
                                sseManager.broadcast({
                                    type: 'brain-sdk-progress',
                                    namespace,
                                    sessionId: result.sessionId,
                                    data: {
                                        brainSessionId,
                                        progressType: 'brain-ready',
                                        flow: 'review',
                                        data: {}
                                    }
                                } as unknown as import('../../sync/syncEngine.js').SyncEvent)
                            }

                            // 触发初始 Brain 分析（等待 brain session socket 就绪后再触发）
                            if (autoBrainService) {
                                // 等待 brain session 的 socket 真正加入 room
                                const brainSocketReady = await engine.waitForSocketInRoom(brainSessionId, 10000)
                                if (!brainSocketReady) {
                                    console.warn(`[machines/spawn] Brain session ${brainSessionId} socket not ready within 10s, triggering sync anyway`)
                                }
                                autoBrainService.triggerSync(result.sessionId).catch(err => {
                                    console.error('[machines/spawn] Failed to trigger brain sync:', err)
                                })
                            }
                        }
                    } catch (err) {
                        console.error(`[machines/spawn] Failed to create Brain session:`, err)
                    }
                }
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
