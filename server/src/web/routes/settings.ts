import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore, OrgRole, UserRole } from '../../store'
import {
    createTokenSourceForOrg,
    deleteTokenSourceForOrg,
    getLocalTokenSourceEnabledForOrg,
    getOrgRole,
    getTokenSourcesForOrg,
    serializeTokenSource,
    setLocalTokenSourceEnabledForOrg,
    tokenSourceInputSchema,
    tokenSourceUpdateSchema,
    updateTokenSourceForOrg,
} from '../tokenSources'

const addProjectSchema = z.object({
    name: z.string().min(1).max(100),
    path: z.string().min(1).max(500),
    description: z.string().max(500).optional(),
    machineId: z.string().nullable().optional(),
})

const updateProjectSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    path: z.string().min(1).max(500).optional(),
    description: z.string().max(500).nullable().optional(),
    machineId: z.string().nullable().optional(),
})

const setRolePromptSchema = z.object({
    prompt: z.string().max(10000)
})

const aiProfileRoleSchema = z.enum([
    'developer', 'architect', 'reviewer', 'pm', 'tester', 'devops',
    'INTP', 'INTJ', 'ENTP', 'ISTJ', 'ISTP', 'ENFP', 'INFJ',
])

const createAIProfileSchema = z.object({
    name: z.string().min(1).max(100),
    role: aiProfileRoleSchema,
    specialties: z.array(z.string().min(1).max(100)).max(20).optional(),
    behaviorAnchors: z.array(z.string().min(1).max(500)).max(10).optional(),
    personality: z.string().max(2000).nullable().optional(),
    greetingTemplate: z.string().max(500).nullable().optional(),
    preferredProjects: z.array(z.string().min(1).max(200)).max(20).optional(),
    workStyle: z.string().max(1000).nullable().optional(),
    avatarEmoji: z.string().min(1).max(20).optional(),
})

const updateAIProfileSchema = createAIProfileSchema.partial()

const brainSelfSystemSchema = z.object({
    enabled: z.boolean(),
    defaultProfileId: z.string().trim().min(1).nullable().optional(),
    memoryProvider: z.enum(['yoho-memory', 'none']),
}).strict().superRefine((value, ctx) => {
    if (value.enabled && !value.defaultProfileId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'defaultProfileId is required when selfSystem is enabled',
            path: ['defaultProfileId'],
        })
    }
})

const brainConfigExtraSchema = z.object({
    childClaudeModels: z.array(z.enum(['sonnet', 'opus', 'opus-4-7'])).optional(),
    childCodexModels: z.array(z.string().trim().min(1)).optional(),
    selfSystem: brainSelfSystemSchema.optional(),
}).passthrough()

type BrainSelfSystemInput = z.infer<typeof brainSelfSystemSchema>

function normalizeOptionalId(value: string | null | undefined): string | null {
    const trimmed = value?.trim()
    return trimmed ? trimmed : null
}

function extractStoredDefaultProfileId(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    const extra = value as { selfSystem?: unknown }
    if (!extra.selfSystem || typeof extra.selfSystem !== 'object') {
        return null
    }
    const selfSystem = extra.selfSystem as { defaultProfileId?: unknown }
    return normalizeOptionalId(typeof selfSystem.defaultProfileId === 'string' ? selfSystem.defaultProfileId : null)
}

function normalizeInvalidSelfSystemProfile(config: BrainSelfSystemInput): BrainSelfSystemInput {
    return {
        ...config,
        enabled: false,
        defaultProfileId: null,
    }
}

function canManageOrgSettings(role: OrgRole | null): boolean {
    return role === 'owner' || role === 'admin'
}

function getRequestedOrgId(c: Context<WebAppEnv>): string | null {
    return normalizeOptionalId(c.req.query('orgId'))
}

function hasOrgAccess(c: Context<WebAppEnv>, orgId: string): boolean {
    const role = c.get('role')
    if (role === 'operator') {
        return true
    }

    const orgs = c.get('orgs') || []
    return orgs.some((org) => org.id === orgId)
}

function getCurrentOrgRole(c: Context<WebAppEnv>, orgId: string): OrgRole | null {
    const orgs = c.get('orgs') || []
    return orgs.find((org) => org.id === orgId)?.role ?? null
}

async function validateProjectMachineScope(
    store: IStore,
    machineId: string,
    orgId: string
): Promise<boolean> {
    const machine = await store.getMachine(machineId)
    return Boolean(machine && machine.orgId === orgId)
}

function filterProjectsForOrg(projects: Awaited<ReturnType<IStore['getProjects']>>, orgId: string) {
    return projects.filter((project) => project.orgId === orgId)
}

function requireOperatorAccess(c: Context<WebAppEnv>): Response | null {
    const role = c.get('role')
    if (!role) {
        return c.json({ error: 'Unauthorized' }, 401)
    }
    if (role !== 'operator') {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }
    return null
}

async function requireOrgAccess(c: Context<WebAppEnv>): Promise<{ orgId: string } | Response> {
    const role = c.get('role')
    if (!role) {
        return c.json({ error: 'Unauthorized' }, 401)
    }

    const orgId = getRequestedOrgId(c)
    if (!orgId) {
        return c.json({ error: 'orgId is required' }, 400)
    }
    if (!hasOrgAccess(c, orgId)) {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }

    return { orgId }
}

async function requireOrgManageAccess(c: Context<WebAppEnv>): Promise<{ orgId: string } | Response> {
    const access = await requireOrgAccess(c)
    if (access instanceof Response) {
        return access
    }

    if (c.get('role') === 'operator') {
        return access
    }
    if (!canManageOrgSettings(getCurrentOrgRole(c, access.orgId))) {
        return c.json({ error: 'Insufficient permissions' }, 403)
    }
    return access
}

export function createSettingsRoutes(
    store: IStore
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // ==================== 当前用户信息 ====================

    app.get('/settings/me', async (c) => {
        const email = c.get('email')
        const name = c.get('name')
        const role = c.get('role')
        const orgs = c.get('orgs')

        return c.json({
            email: email || null,
            name: name || null,
            role,
            orgs: orgs || [],
        })
    })

    // ==================== 项目管理 ====================

    // 获取项目列表：共享项目 + 当前机器的私有项目
    app.get('/settings/projects', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const machineId = c.req.query('machineId')
        if (machineId) {
            const machineInScope = await validateProjectMachineScope(store, machineId, access.orgId)
            if (!machineInScope) {
                return c.json({ error: 'Machine not found' }, 404)
            }
        }
        const projects = await store.getProjects(machineId, access.orgId)
        return c.json({ projects: filterProjectsForOrg(projects, access.orgId) })
    })

    // 添加项目
    app.post('/settings/projects', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const json = await c.req.json().catch(() => null)
        const parsed = addProjectSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid project data' }, 400)
        }

        const machineId = normalizeOptionalId(parsed.data.machineId)
        if (!machineId) {
            return c.json({ error: 'machineId is required' }, 400)
        }

        const machineInScope = await validateProjectMachineScope(store, machineId, access.orgId)
        if (!machineInScope) {
            return c.json({ error: 'Machine not found' }, 404)
        }

        const project = await store.addProject(
            parsed.data.name,
            parsed.data.path,
            parsed.data.description,
            machineId,
            access.orgId,
        )
        if (!project) {
            return c.json({ error: 'Failed to add project. Path may already exist.' }, 400)
        }

        const responseMachineId = machineId ?? undefined
        const projects = await store.getProjects(responseMachineId, access.orgId)
        return c.json({ ok: true, project, projects: filterProjectsForOrg(projects, access.orgId) })
    })

    // 更新项目
    app.put('/settings/projects/:id', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const id = c.req.param('id')
        const json = await c.req.json().catch(() => null)
        const parsed = updateProjectSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid project data' }, 400)
        }

        const existing = await store.getProject(id)
        if (!existing) return c.json({ error: 'Project not found or path already exists' }, 404)
        if (existing.orgId !== access.orgId) {
            return c.json({ error: 'Project not found or path already exists' }, 404)
        }

        const effectiveMachineId = parsed.data.machineId !== undefined
            ? normalizeOptionalId(parsed.data.machineId)
            : existing.machineId

        if (effectiveMachineId) {
            const machineInScope = await validateProjectMachineScope(store, effectiveMachineId, access.orgId)
            if (!machineInScope) {
                return c.json({ error: 'Machine not found' }, 404)
            }
        }

        const project = await store.updateProject(id, {
            name: parsed.data.name,
            path: parsed.data.path,
            description: parsed.data.description,
            machineId: parsed.data.machineId === undefined ? undefined : effectiveMachineId,
            orgId: access.orgId,
        })
        if (!project) {
            return c.json({ error: 'Project not found or path already exists' }, 404)
        }

        const responseMachineId = effectiveMachineId ?? undefined
        const projects = await store.getProjects(responseMachineId, access.orgId)
        return c.json({ ok: true, project, projects: filterProjectsForOrg(projects, access.orgId) })
    })

    // 删除项目
    app.delete('/settings/projects/:id', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const id = c.req.param('id')
        const existing = await store.getProject(id)
        if (!existing) return c.json({ error: 'Project not found' }, 404)
        if (existing.orgId !== access.orgId) {
            return c.json({ error: 'Project not found' }, 404)
        }

        const success = await store.removeProject(id)
        if (!success) {
            return c.json({ error: 'Project not found' }, 404)
        }

        const responseMachineId = existing.machineId ?? undefined
        const projects = await store.getProjects(responseMachineId, access.orgId)
        return c.json({ ok: true, projects: filterProjectsForOrg(projects, access.orgId) })
    })

    // ==================== Token Source 管理 ====================

    app.get('/settings/token-sources', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const orgId = c.req.query('orgId')
        if (!orgId) {
            return c.json({ error: 'orgId is required' }, 400)
        }

        const orgRole = await getOrgRole(store, orgId, email)
        if (!orgRole) {
            return c.json({ error: 'Not a member of this organization' }, 403)
        }

        const includeSecrets = c.req.query('includeSecrets') === '1' && canManageOrgSettings(orgRole)
        const [tokenSources, localEnabled] = await Promise.all([
            getTokenSourcesForOrg(store, orgId),
            getLocalTokenSourceEnabledForOrg(store, orgId),
        ])
        return c.json({
            tokenSources: tokenSources.map((item) => serializeTokenSource(item, includeSecrets)),
            canManage: canManageOrgSettings(orgRole),
            includeSecrets,
            localEnabled,
        })
    })

    const localTokenSourceToggleSchema = z.object({
        enabled: z.boolean(),
    })

    app.put('/settings/token-sources/local', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const orgId = c.req.query('orgId')
        if (!orgId) {
            return c.json({ error: 'orgId is required' }, 400)
        }

        const orgRole = await getOrgRole(store, orgId, email)
        if (!canManageOrgSettings(orgRole)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = localTokenSourceToggleSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid payload' }, 400)
        }

        const saved = await setLocalTokenSourceEnabledForOrg(store, orgId, parsed.data.enabled)
        if (!saved) {
            return c.json({ error: 'Failed to update setting' }, 500)
        }

        return c.json({ ok: true, localEnabled: parsed.data.enabled })
    })

    app.post('/settings/token-sources', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const orgId = c.req.query('orgId')
        if (!orgId) {
            return c.json({ error: 'orgId is required' }, 400)
        }

        const orgRole = await getOrgRole(store, orgId, email)
        if (!canManageOrgSettings(orgRole)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = tokenSourceInputSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid token source data' }, 400)
        }

        const tokenSource = await createTokenSourceForOrg(store, orgId, parsed.data)
        if (!tokenSource) {
            return c.json({ error: 'Failed to create token source' }, 500)
        }

        return c.json({ ok: true, tokenSource: serializeTokenSource(tokenSource, true) })
    })

    app.put('/settings/token-sources/:id', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const orgId = c.req.query('orgId')
        if (!orgId) {
            return c.json({ error: 'orgId is required' }, 400)
        }

        const orgRole = await getOrgRole(store, orgId, email)
        if (!canManageOrgSettings(orgRole)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = tokenSourceUpdateSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid token source data' }, 400)
        }

        const tokenSource = await updateTokenSourceForOrg(store, orgId, c.req.param('id'), parsed.data)
        if (!tokenSource) {
            return c.json({ error: 'Token source not found' }, 404)
        }

        return c.json({ ok: true, tokenSource: serializeTokenSource(tokenSource, true) })
    })

    app.delete('/settings/token-sources/:id', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const orgId = c.req.query('orgId')
        if (!orgId) {
            return c.json({ error: 'orgId is required' }, 400)
        }

        const orgRole = await getOrgRole(store, orgId, email)
        if (!canManageOrgSettings(orgRole)) {
            return c.json({ error: 'Insufficient permissions' }, 403)
        }

        const removed = await deleteTokenSourceForOrg(store, orgId, c.req.param('id'))
        if (!removed) {
            return c.json({ error: 'Token source not found' }, 404)
        }

        return c.json({ ok: true })
    })

    // ==================== 角色预设 Prompt ====================

    // 获取所有角色的预设 Prompt
    app.get('/settings/role-prompts', async (c) => {
        const authError = requireOperatorAccess(c)
        if (authError) {
            return authError
        }
        const prompts = await store.getAllRolePrompts()
        return c.json({ prompts })
    })

    // 获取指定角色的预设 Prompt
    app.get('/settings/role-prompts/:role', async (c) => {
        const authError = requireOperatorAccess(c)
        if (authError) {
            return authError
        }
        const role = c.req.param('role')
        if (role !== 'developer' && role !== 'operator') {
            return c.json({ error: 'Invalid role' }, 400)
        }
        const prompt = await store.getRolePrompt(role as UserRole)
        return c.json({ role, prompt })
    })

    // 设置角色的预设 Prompt
    app.put('/settings/role-prompts/:role', async (c) => {
        const authError = requireOperatorAccess(c)
        if (authError) {
            return authError
        }
        const role = c.req.param('role')
        if (role !== 'developer' && role !== 'operator') {
            return c.json({ error: 'Invalid role' }, 400)
        }

        const json = await c.req.json().catch(() => null)
        const parsed = setRolePromptSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid prompt data' }, 400)
        }

        const success = await store.setRolePrompt(role as UserRole, parsed.data.prompt)
        if (!success) {
            return c.json({ error: 'Failed to set prompt' }, 500)
        }

        const prompts = await store.getAllRolePrompts()
        return c.json({ ok: true, prompts })
    })

    // 删除角色的预设 Prompt
    app.delete('/settings/role-prompts/:role', async (c) => {
        const authError = requireOperatorAccess(c)
        if (authError) {
            return authError
        }
        const role = c.req.param('role')
        if (role !== 'developer' && role !== 'operator') {
            return c.json({ error: 'Invalid role' }, 400)
        }

        await store.removeRolePrompt(role as UserRole)
        const prompts = await store.getAllRolePrompts()
        return c.json({ ok: true, prompts })
    })

    // ==================== 用户隐私设置 ====================

    // 获取当前用户的设置
    app.get('/settings/user-preferences', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const [shareAllSessions, viewOthersSessions] = await Promise.all([
            store.getShareAllSessions(email),
            store.getViewOthersSessions(email)
        ])
        return c.json({ shareAllSessions, viewOthersSessions })
    })

    // 设置当前用户的偏好
    app.put('/settings/user-preferences', async (c) => {
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const json = await c.req.json().catch(() => null)
        if (!json) {
            return c.json({ error: 'Invalid data' }, 400)
        }

        const updates: Promise<boolean>[] = []
        if (typeof json.shareAllSessions === 'boolean') {
            updates.push(store.setShareAllSessions(email, json.shareAllSessions))
        }
        if (typeof json.viewOthersSessions === 'boolean') {
            updates.push(store.setViewOthersSessions(email, json.viewOthersSessions))
        }

        if (updates.length === 0) {
            return c.json({ error: 'No valid fields to update' }, 400)
        }

        const results = await Promise.all(updates)
        if (results.some(r => !r)) {
            return c.json({ error: 'Failed to update settings' }, 500)
        }

        // 返回更新后的值
        const [shareAllSessions, viewOthersSessions] = await Promise.all([
            store.getShareAllSessions(email),
            store.getViewOthersSessions(email)
        ])
        return c.json({ ok: true, shareAllSessions, viewOthersSessions })
    })

    // ========== AI Profiles ==========

    app.get('/settings/ai-profiles', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const profiles = await store.getAIProfilesByOrg(access.orgId)
        return c.json({ profiles })
    })

    app.post('/settings/ai-profiles', async (c) => {
        const access = await requireOrgManageAccess(c)
        if (access instanceof Response) {
            return access
        }

        const body = await c.req.json().catch(() => null)
        const parsed = createAIProfileSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid AI profile', details: parsed.error.issues }, 400)
        }

        const existingForRole = await store.getAIProfileByOrgAndRole(access.orgId, parsed.data.role)
        if (existingForRole) {
            return c.json({ error: 'AI profile role already exists for current org' }, 409)
        }
        const profile = await store.createAIProfile({
            namespace: `org:${access.orgId}`,
            orgId: access.orgId,
            ...parsed.data,
        })
        if (!profile) {
            return c.json({ error: 'Failed to create AI profile' }, 500)
        }

        return c.json({ ok: true, profile })
    })

    app.put('/settings/ai-profiles/:id', async (c) => {
        const access = await requireOrgManageAccess(c)
        if (access instanceof Response) {
            return access
        }

        const body = await c.req.json().catch(() => null)
        const parsed = updateAIProfileSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid AI profile', details: parsed.error.issues }, 400)
        }

        const existing = await store.getAIProfile(c.req.param('id'))
        if (!existing || existing.orgId !== access.orgId) {
            return c.json({ error: 'AI profile not found' }, 404)
        }
        if (parsed.data.role && parsed.data.role !== existing.role) {
            const existingForRole = await store.getAIProfileByOrgAndRole(access.orgId, parsed.data.role)
            if (existingForRole && existingForRole.id !== existing.id) {
                return c.json({ error: 'AI profile role already exists for current org' }, 409)
            }
        }

        const profile = await store.updateAIProfile(existing.id, parsed.data)
        if (!profile) {
            return c.json({ error: 'AI profile not found' }, 404)
        }

        return c.json({ ok: true, profile })
    })

    app.delete('/settings/ai-profiles/:id', async (c) => {
        const access = await requireOrgManageAccess(c)
        if (access instanceof Response) {
            return access
        }

        const existing = await store.getAIProfile(c.req.param('id'))
        if (!existing || existing.orgId !== access.orgId) {
            return c.json({ error: 'AI profile not found' }, 404)
        }

        const email = c.get('email') || null
        const deleteAIProfileWithSelfSystemCleanup = (store as IStore & {
            deleteAIProfileWithSelfSystemCleanup?: (orgId: string, profileId: string, updatedBy?: string | null) => Promise<boolean>
        }).deleteAIProfileWithSelfSystemCleanup
        const deleted = typeof deleteAIProfileWithSelfSystemCleanup === 'function'
            ? await deleteAIProfileWithSelfSystemCleanup(access.orgId, existing.id, email)
            : await (async () => {
                await store.clearSelfSystemProfileReferences(access.orgId, existing.id, email)
                return await store.deleteAIProfile(existing.id)
            })()
        if (!deleted) {
            return c.json({ error: 'AI profile not found' }, 404)
        }

        return c.json({ ok: true })
    })

    // ========== Brain Config ==========

    const brainConfigSchema = z.object({
        agent: z.enum(['claude', 'codex']),
        claudeModelMode: z.string().optional(),
        codexModel: z.string().optional(),
        extra: brainConfigExtraSchema.optional(),
    })

    app.get('/settings/brain-config', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const config = await store.getBrainConfigByOrg(access.orgId)
        if (!config) {
            return c.json({
                namespace: `org:${access.orgId}`,
                orgId: access.orgId,
                agent: 'claude' as const,
                claudeModelMode: 'opus',
                codexModel: 'gpt-5.4',
                extra: {},
                updatedAt: 0,
                updatedBy: null,
            })
        }
        return c.json(config)
    })

    app.put('/settings/brain-config', async (c) => {
        const access = await requireOrgManageAccess(c)
        if (access instanceof Response) {
            return access
        }

        const body = await c.req.json()
        const parsed = brainConfigSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid config', details: parsed.error.issues }, 400)
        }

        const email = c.get('email') || null
        const currentConfig = await store.getBrainConfigByOrg(access.orgId)
        let selfSystem = parsed.data.extra?.selfSystem
        if (selfSystem?.defaultProfileId) {
            const profile = await store.getAIProfile(selfSystem.defaultProfileId)
            if (!profile || profile.orgId !== access.orgId) {
                const currentDefaultProfileId = extractStoredDefaultProfileId(currentConfig?.extra)
                if (currentDefaultProfileId === selfSystem.defaultProfileId) {
                    selfSystem = normalizeInvalidSelfSystemProfile(selfSystem)
                } else {
                    return c.json({ error: 'Invalid config', details: [{ path: ['extra', 'selfSystem', 'defaultProfileId'], message: 'AI profile not found in current org' }] }, 400)
                }
            }
        }
        const result = await store.setBrainConfigByOrg(access.orgId, {
            ...parsed.data,
            extra: selfSystem
                ? {
                    ...(parsed.data.extra ?? {}),
                    selfSystem,
                }
                : parsed.data.extra,
            updatedBy: email,
        })
        return c.json({ ok: true, config: result })
    })

    app.get('/settings/self-system', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }
        const config = await store.getUserSelfSystemConfig(access.orgId, email)
        return c.json(config ?? {
            orgId: access.orgId,
            userEmail: email,
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'yoho-memory' as const,
            updatedAt: 0,
            updatedBy: null,
        })
    })

    app.put('/settings/self-system', async (c) => {
        const access = await requireOrgAccess(c)
        if (access instanceof Response) {
            return access
        }
        const email = c.get('email')
        if (!email) {
            return c.json({ error: 'Unauthorized' }, 401)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = brainSelfSystemSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid config', details: parsed.error.issues }, 400)
        }
        const currentConfig = await store.getUserSelfSystemConfig(access.orgId, email)
        let nextConfig = parsed.data
        if (nextConfig.defaultProfileId) {
            const profile = await store.getAIProfile(nextConfig.defaultProfileId)
            if (!profile || profile.orgId !== access.orgId) {
                const currentDefaultProfileId = normalizeOptionalId(currentConfig?.defaultProfileId)
                if (currentDefaultProfileId === nextConfig.defaultProfileId) {
                    nextConfig = normalizeInvalidSelfSystemProfile(nextConfig)
                } else {
                    return c.json({ error: 'Invalid config', details: [{ path: ['defaultProfileId'], message: 'AI profile not found in current org' }] }, 400)
                }
            }
        }

        const config = await store.setUserSelfSystemConfig({
            orgId: access.orgId,
            userEmail: email,
            enabled: nextConfig.enabled,
            defaultProfileId: nextConfig.defaultProfileId ?? null,
            memoryProvider: nextConfig.memoryProvider,
            updatedBy: email,
        })
        return c.json({ ok: true, config })
    })

    return app
}
