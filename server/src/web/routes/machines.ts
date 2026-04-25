import { Hono } from 'hono'
import { z } from 'zod'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import type { IStore, UserRole } from '../../store'
import type { SSEManager } from '../../sse/sseManager'
import type { WebAppEnv } from '../middleware/auth'
import { resolvePersonalWorktreeSpawnOptions } from '../personalWorktree'
import { buildInitPrompt } from '../prompts/initPrompt'
import { buildSessionContextBundle, renderSessionContextBundlePrompt } from '../prompts/contextBundle'
import { resolveSessionSelfSystemContext, appendSelfSystemPrompt } from '../../brain/selfSystem'
import { resolveSessionCommunicationPlanContext, appendCommunicationPlanPrompt } from '../../brain/communicationPlan'
import { getLocalTokenSourceEnabledForOrg, resolveTokenSourceForAgent } from '../tokenSources'
import { requireMachine, requireMachineInOrg, requireRequestedOrgId } from './guards'
import { isMachineBlocked } from './blocklist'
import { serializeMachine, sortMachinesForDisplay } from './machinePayload'
import { getLicenseService } from '../../license/licenseService'
import { getSessionSourceFromMetadata, getUnsupportedSessionSourceError, isSupportedSessionSource } from '../../sessionSourcePolicy'
import { buildSessionIdentityContextPatch } from '../identityContext'

const spawnBodySchema = z.object({
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex', 'gemini', 'glm', 'minimax', 'grok', 'openrouter', 'aider-cli']).optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional(),
    tokenSourceId: z.string().min(1).optional(),
    claudeSettingsType: z.enum(['litellm', 'claude']).optional(),
    claudeAgent: z.string().min(1).optional(),
    claudeModel: z.enum(['sonnet', 'opus', 'opus-4-7']).optional(),
    codexModel: z.string().min(1).optional(),

    modelReasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    source: z.string().min(1).max(100).optional()
})

const modelModeValues = ['default', 'sonnet', 'opus', 'opus-4-7', 'glm-5.1', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'] as const
const isModelMode = (value: string): value is NonNullable<Session['modelMode']> => {
    return (modelModeValues as readonly string[]).includes(value)
}

const pathsExistsSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

async function sendInitPrompt(
    engine: SyncEngine,
    store: IStore,
    sessionId: string,
    role: UserRole,
    userName?: string | null,
    userEmail?: string | null,
    orgId?: string | null,
    machineId?: string,
    personId?: string | null,
): Promise<void> {
    try {
        const session = engine.getSession(sessionId)
        const worktree = session?.metadata?.worktree
        const projectRoot = session?.metadata?.path?.trim()
            || worktree?.basePath?.trim()
            || null
        const resolvedOrgId = orgId ?? session?.orgId ?? null
        const contextBundlePrompt = renderSessionContextBundlePrompt(await buildSessionContextBundle(store, {
            orgId: resolvedOrgId,
            sessionId,
            projectRoot,
        }))

        console.log(`[machines/sendInitPrompt] sessionId=${sessionId}, role=${role}, projectRoot=${projectRoot}, userName=${userName}`)
        let prompt = await buildInitPrompt(role, { projectRoot, userName, worktree, contextBundlePrompt })

        if (session) {
            const source = getSessionSourceFromMetadata(session.metadata)
            try {
                const selfSystem = await resolveSessionSelfSystemContext({
                    store,
                    orgId: resolvedOrgId,
                    userEmail: userEmail ?? null,
                    source,
                })
                prompt = appendSelfSystemPrompt(prompt, selfSystem.prompt)
                if (typeof (engine as { patchSessionMetadata?: unknown }).patchSessionMetadata === 'function') {
                    await engine.patchSessionMetadata(sessionId, selfSystem.metadataPatch)
                }
            } catch (selfErr) {
                console.error(`[machines/sendInitPrompt] Self-system resolution failed for session ${sessionId}, continuing with base prompt:`, selfErr)
            }

            try {
                const communicationPlan = await resolveSessionCommunicationPlanContext({
                    store,
                    orgId: resolvedOrgId,
                    personId: personId ?? null,
                })
                prompt = appendCommunicationPlanPrompt(prompt, communicationPlan.prompt)
                if (typeof (engine as { patchSessionMetadata?: unknown }).patchSessionMetadata === 'function') {
                    await engine.patchSessionMetadata(sessionId, communicationPlan.metadataPatch)
                }
                if (communicationPlan.metadataPatch.communicationPlanStatus === 'attached') {
                    console.log(
                        `[machines/sendInitPrompt] communication plan attached session=${sessionId}` +
                        ` personId=${communicationPlan.metadataPatch.communicationPlanPersonId}` +
                        ` planId=${communicationPlan.metadataPatch.communicationPlanId}` +
                        ` version=${communicationPlan.metadataPatch.communicationPlanVersion}`
                    )
                }
            } catch (planErr) {
                console.error(`[machines/sendInitPrompt] Communication plan resolution failed for session ${sessionId}, continuing:`, planErr)
            }
        }

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
    const getEngineMachinesByOrg = (engine: SyncEngine, orgId: string): Machine[] => {
        if (typeof engine.getMachinesByOrg === 'function') {
            return engine.getMachinesByOrg(orgId)
        }
        return (engine as { getMachinesByNamespace?: (namespace: string) => Machine[] })
            .getMachinesByNamespace?.(orgId) ?? []
    }

    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const orgId = requireRequestedOrgId(c)
        if (orgId instanceof Response) {
            return orgId
        }
        const machines = getEngineMachinesByOrg(engine, orgId)
            .filter((m) => !isMachineBlocked(m))
        return c.json({ machines: sortMachinesForDisplay(machines).map(serializeMachine) })
    })

    app.post('/machines/:id/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not connected' }, 503)
        }

        const requestedOrgId = requireRequestedOrgId(c)
        if (requestedOrgId instanceof Response) {
            return requestedOrgId
        }

        const machineId = c.req.param('id')
        const machine = requireMachineInOrg(c, engine, machineId, requestedOrgId)
        if (machine instanceof Response) {
            return machine
        }

        const body = await c.req.json().catch(() => null)
        const parsed = spawnBodySchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        // License check: 优先用 query param orgId，fallback 到 machine 自身的 orgId
        const orgIdForLicense = requestedOrgId
        if (orgIdForLicense) {
            try {
                const licenseService = getLicenseService()
                const licenseCheck = await licenseService.canCreateSession(orgIdForLicense)
                if (!licenseCheck.valid) {
                    return c.json({ type: 'error', message: licenseCheck.message, code: licenseCheck.code }, 403)
                }
            } catch { /* LicenseService not initialized */ }
        }

        const rawSource = parsed.data.source?.trim()
        if (!isSupportedSessionSource(rawSource)) {
            return c.json({ error: getUnsupportedSessionSourceError(rawSource) }, 400)
        }
        const source = rawSource ? rawSource : 'external-api'
        const email = c.get('email')
        const spawnTarget = resolvePersonalWorktreeSpawnOptions({
            machine,
            email,
            sessionType: parsed.data.sessionType,
            worktreeName: parsed.data.worktreeName,
        })

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

        const requestedAgent = parsed.data.agent ?? 'claude'
        let resolvedTokenSource: Awaited<ReturnType<typeof resolveTokenSourceForAgent>> | null = null
        if (parsed.data.tokenSourceId) {
            if (!orgIdForLicense) {
                return c.json({ error: 'orgId is required when using Token Source' }, 400)
            }
            resolvedTokenSource = await resolveTokenSourceForAgent(
                store,
                orgIdForLicense,
                parsed.data.tokenSourceId,
                requestedAgent
            )
            if ('error' in resolvedTokenSource) {
                return c.json({ error: resolvedTokenSource.error }, resolvedTokenSource.status as 400 | 404)
            }
        } else if (orgIdForLicense) {
            const localEnabled = typeof store.getOrganization === 'function'
                ? await getLocalTokenSourceEnabledForOrg(store, orgIdForLicense)
                : true
            if (!localEnabled) {
                return c.json({ error: 'Local Token Source is disabled for this organization' }, 400)
            }
        }

        const result = await engine.spawnSession(
            machineId,
            parsed.data.directory,
            requestedAgent,
            parsed.data.yolo,
            {
                sessionType: spawnTarget.sessionType,
                worktreeName: spawnTarget.worktreeName,
                tokenSourceId: resolvedTokenSource?.tokenSource.id,
                tokenSourceName: resolvedTokenSource?.tokenSource.name,
                tokenSourceType: resolvedTokenSource?.tokenSource.supportedAgents.includes('codex') && requestedAgent === 'codex'
                    ? 'codex'
                    : resolvedTokenSource?.tokenSource.supportedAgents.includes('claude') && requestedAgent === 'claude'
                        ? 'claude'
                        : undefined,
                tokenSourceBaseUrl: resolvedTokenSource?.tokenSource.baseUrl,
                tokenSourceApiKey: resolvedTokenSource?.tokenSource.apiKey,
                claudeSettingsType: parsed.data.claudeSettingsType,
                claudeAgent: parsed.data.claudeAgent,
                codexModel: parsed.data.codexModel,
                modelMode,
                modelReasoningEffort: parsed.data.modelReasoningEffort,
                source,
                reuseExistingWorktree: spawnTarget.reuseExistingWorktree,
            }
        )

        // 如果 spawn 成功，等 session online 后设置 createdBy 并发送初始化 prompt
        if (result.type === 'success') {
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
                    await store.setSessionCreatedBy(result.sessionId, email, requestedOrgId)
                }
                await store.setSessionOrgId(result.sessionId, requestedOrgId)
                const identityPatch = buildSessionIdentityContextPatch(c.get('identityActor'))
                if (identityPatch && typeof (engine as { patchSessionMetadata?: unknown }).patchSessionMetadata === 'function') {
                    await engine.patchSessionMetadata(result.sessionId, identityPatch)
                }
                await sendInitPrompt(engine, store, result.sessionId, role, userName, email, requestedOrgId, machineId, c.get('identityActor')?.personId ?? null)
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

    // ========== Supported Agents 配置 ==========

    const supportedAgentsSchema = z.object({
        supportedAgents: z.array(z.enum(['claude', 'codex'])).nullable().transform(v => v && v.length === 0 ? null : v)
    })

    app.put('/machines/:id/supported-agents', async (c) => {
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
        const parsed = supportedAgentsSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body. Expected { supportedAgents: ["claude", "codex"] | null }' }, 400)
        }

        const { supportedAgents } = parsed.data
        if (!machine.orgId) {
            return c.json({ error: 'Machine orgId missing' }, 409)
        }
        const ok = await store.setMachineSupportedAgents(machine.id, supportedAgents, machine.orgId)
        if (!ok) {
            return c.json({ error: 'Failed to update supported agents' }, 500)
        }

        machine.supportedAgents = supportedAgents
        machine.updatedAt = Date.now()
        machine.seq += 1
        engine.emit({ type: 'machine-updated', machineId: machine.id, data: machine })
        return c.json({ ok: true, machine: serializeMachine(machine) })
    })

    return app
}
