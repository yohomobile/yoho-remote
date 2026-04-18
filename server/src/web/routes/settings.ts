import { Hono } from 'hono'
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

function normalizeOptionalId(value: string | null | undefined): string | null {
    const trimmed = value?.trim()
    return trimmed ? trimmed : null
}

function canManageOrgSettings(role: OrgRole | null): boolean {
    return role === 'owner' || role === 'admin'
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
        const orgId = c.req.query('orgId')
        const machineId = c.req.query('machineId')
        const projects = await store.getProjects(machineId, orgId)
        return c.json({ projects })
    })

    // 添加项目
    app.post('/settings/projects', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = addProjectSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid project data' }, 400)
        }

        const machineId = normalizeOptionalId(parsed.data.machineId)
        if (!machineId) {
            return c.json({ error: 'machineId is required' }, 400)
        }

        const orgId = c.req.query('orgId')
        const project = await store.addProject(
            parsed.data.name,
            parsed.data.path,
            parsed.data.description,
            machineId,
            orgId,
        )
        if (!project) {
            return c.json({ error: 'Failed to add project. Path may already exist.' }, 400)
        }

        const responseMachineId = machineId ?? undefined
        const projects = await store.getProjects(responseMachineId, orgId)
        return c.json({ ok: true, project, projects })
    })

    // 更新项目
    app.put('/settings/projects/:id', async (c) => {
        const id = c.req.param('id')
        const json = await c.req.json().catch(() => null)
        const parsed = updateProjectSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid project data' }, 400)
        }

        const orgId = c.req.query('orgId')
        const existing = await store.getProject(id)
        if (!existing) return c.json({ error: 'Project not found or path already exists' }, 404)
        if (existing.orgId !== null && existing.orgId !== orgId) {
            return c.json({ error: 'Project not found or path already exists' }, 404)
        }

        const effectiveMachineId = parsed.data.machineId !== undefined
            ? normalizeOptionalId(parsed.data.machineId)
            : existing.machineId

        const project = await store.updateProject(id, {
            name: parsed.data.name,
            path: parsed.data.path,
            description: parsed.data.description,
            machineId: parsed.data.machineId === undefined ? undefined : effectiveMachineId,
            orgId,
        })
        if (!project) {
            return c.json({ error: 'Project not found or path already exists' }, 404)
        }

        const responseMachineId = effectiveMachineId ?? undefined
        const projects = await store.getProjects(responseMachineId, orgId)
        return c.json({ ok: true, project, projects })
    })

    // 删除项目
    app.delete('/settings/projects/:id', async (c) => {
        const id = c.req.param('id')
        const orgId = c.req.query('orgId')
        const existing = await store.getProject(id)
        if (!existing) return c.json({ error: 'Project not found' }, 404)
        if (existing.orgId !== null && existing.orgId !== orgId) {
            return c.json({ error: 'Project not found' }, 404)
        }

        const success = await store.removeProject(id)
        if (!success) {
            return c.json({ error: 'Project not found' }, 404)
        }

        const responseMachineId = existing.machineId ?? undefined
        const projects = await store.getProjects(responseMachineId, orgId)
        return c.json({ ok: true, projects })
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
    app.get('/settings/role-prompts', async (_c) => {
        const prompts = await store.getAllRolePrompts()
        return _c.json({ prompts })
    })

    // 获取指定角色的预设 Prompt
    app.get('/settings/role-prompts/:role', async (c) => {
        const role = c.req.param('role')
        if (role !== 'developer' && role !== 'operator') {
            return c.json({ error: 'Invalid role' }, 400)
        }
        const prompt = await store.getRolePrompt(role as UserRole)
        return c.json({ role, prompt })
    })

    // 设置角色的预设 Prompt
    app.put('/settings/role-prompts/:role', async (c) => {
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

    // ========== Brain Config ==========

    const brainConfigSchema = z.object({
        agent: z.enum(['claude', 'codex']),
        claudeModelMode: z.string().optional(),
        codexModel: z.string().optional(),
        extra: z.record(z.string(), z.unknown()).optional(),
    })

    app.get('/settings/brain-config', async (c) => {
        const namespace = c.get('namespace') || 'default'
        const config = await store.getBrainConfig(namespace)
        if (!config) {
            return c.json({
                namespace,
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
        const body = await c.req.json()
        const parsed = brainConfigSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid config', details: parsed.error.issues }, 400)
        }

        const namespace = c.get('namespace') || 'default'
        const email = c.get('email') || null
        const result = await store.setBrainConfig(namespace, {
            ...parsed.data,
            updatedBy: email,
        })
        return c.json({ ok: true, config: result })
    })

    return app
}
