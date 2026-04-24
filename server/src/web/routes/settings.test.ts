import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createSettingsRoutes } from './settings'

function createSettingsApp(
    store: Record<string, unknown>,
    options?: { role?: 'developer' | 'operator'; email?: string; orgId?: string; orgRole?: 'member' | 'owner' | 'admin' }
) {
    const app = new Hono<any>()
    app.use('/api/*', async (c, next) => {
        c.set('namespace', 'default')
        if (options?.role) {
            c.set('role', options.role)
        }
        if (options?.email) {
            c.set('email', options.email)
        }
        if (options?.orgId) {
            c.set('orgs', [{
                id: options.orgId,
                role: options.orgRole ?? 'owner',
            }])
        }
        await next()
    })
    app.route('/api', createSettingsRoutes(store as any))
    return app
}

describe('createSettingsRoutes projects', () => {
    it('passes machineId through when listing projects', async () => {
        const calls: Array<{ machineId: string | null | undefined; orgId: string | null | undefined }> = []
        const store = {
            getProjects: async (machineId?: string | null, orgId?: string | null) => {
                calls.push({ machineId, orgId })
                return [{
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId,
                    orgId,
                    createdAt: 1,
                    updatedAt: 1,
                }, {
                    id: 'project-legacy',
                    name: 'Legacy',
                    path: '/tmp/legacy',
                    description: null,
                    machineId,
                    orgId: null,
                    createdAt: 1,
                    updatedAt: 1,
                }]
            },
            getMachine: async () => ({
                id: 'machine-a',
                orgId: 'org-a',
            }),
        }

        const app = createSettingsApp(store, {
            role: 'developer',
            orgId: 'org-a',
        })

        const response = await app.request('/api/settings/projects?machineId=machine-a&orgId=org-a')
        expect(response.status).toBe(200)
        expect(calls).toEqual([
            { machineId: 'machine-a', orgId: 'org-a' },
        ])
        expect(await response.json()).toEqual({
            projects: [expect.objectContaining({ id: 'project-1', orgId: 'org-a' })],
        })
    })

    it('stores created and updated projects with machineId', async () => {
        const addCalls: Array<{
            machineId: string | null | undefined
            orgId: string | null | undefined
        }> = []
        const updateCalls: Array<{ machineId: string | null | undefined }> = []
        const store = {
            getProjects: async () => [],
            getProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: 'machine-a',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            addProject: async (_name: string, _path: string, _description?: string, machineId?: string | null, orgId?: string | null) => {
                addCalls.push({ machineId, orgId })
                return {
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId,
                    orgId,
                    createdAt: 1,
                    updatedAt: 1,
                }
            },
            updateProject: async (_id: string, fields: { machineId?: string | null }) => {
                updateCalls.push({ machineId: fields.machineId })
                return {
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId: fields.machineId ?? 'machine-a',
                    orgId: 'org-a',
                    createdAt: 1,
                    updatedAt: 2,
                }
            },
            getMachine: async () => ({
                id: 'machine-a',
                orgId: 'org-a',
            }),
        }

        const app = createSettingsApp(store, {
            role: 'developer',
            orgId: 'org-a',
        })

        const createResponse = await app.request('/api/settings/projects?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                machineId: 'machine-a'
            }),
        })
        expect(createResponse.status).toBe(200)

        const updateResponse = await app.request('/api/settings/projects/project-1?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
            }),
        })
        expect(updateResponse.status).toBe(200)

        expect(addCalls).toEqual([
            { machineId: 'machine-a', orgId: 'org-a' },
        ])
        expect(updateCalls).toEqual([
            { machineId: undefined },
        ])
    })

    it('refreshes machine-local project lists using the affected machine scope', async () => {
        const getProjectCalls: Array<{ machineId: string | null | undefined; orgId: string | null | undefined }> = []
        const store = {
            getProjects: async (machineId?: string | null, orgId?: string | null) => {
                getProjectCalls.push({ machineId, orgId })
                return []
            },
            getProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: 'machine-a',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            addProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: 'machine-a',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            updateProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: 'machine-a',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 2,
            }),
            removeProject: async () => true,
            getMachine: async () => ({
                id: 'machine-a',
                orgId: 'org-a',
            }),
        }

        const app = createSettingsApp(store, {
            role: 'developer',
            orgId: 'org-a',
        })

        const createResponse = await app.request('/api/settings/projects?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                machineId: 'machine-a'
            }),
        })
        expect(createResponse.status).toBe(200)

        const updateResponse = await app.request('/api/settings/projects/project-1?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                description: 'rename without scope change'
            }),
        })
        expect(updateResponse.status).toBe(200)

        const deleteResponse = await app.request('/api/settings/projects/project-1?orgId=org-a', {
            method: 'DELETE',
        })
        expect(deleteResponse.status).toBe(200)

        expect(getProjectCalls).toEqual([
            { machineId: 'machine-a', orgId: 'org-a' },
            { machineId: 'machine-a', orgId: 'org-a' },
            { machineId: 'machine-a', orgId: 'org-a' },
        ])
    })

    it('rejects project access for users outside the requested org', async () => {
        const store = {
            getProjects: async () => [],
        }

        const app = createSettingsApp(store, {
            role: 'developer',
            orgId: 'org-a',
        })

        const response = await app.request('/api/settings/projects?orgId=org-b')
        expect(response.status).toBe(403)
    })

    it('rejects creating projects on machines outside the requested org', async () => {
        const store = {
            getMachine: async () => ({
                id: 'machine-b',
                orgId: 'org-b',
            }),
        }

        const app = createSettingsApp(store, {
            role: 'developer',
            orgId: 'org-a',
        })

        const response = await app.request('/api/settings/projects?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'OtherOrgProject',
                path: '/tmp/other',
                machineId: 'machine-b',
            }),
        })

        expect(response.status).toBe(404)
    })
})

describe('createSettingsRoutes role prompts', () => {
    it('only allows operator users to manage role prompts', async () => {
        const store = {
            getAllRolePrompts: async () => [{ role: 'developer', prompt: 'prompt', updatedAt: 1 }],
            setRolePrompt: async () => true,
            removeRolePrompt: async () => true,
            getRolePrompt: async () => 'prompt',
        }

        const memberApp = createSettingsApp(store, {
            role: 'developer',
            orgId: 'org-a',
        })
        const operatorApp = createSettingsApp(store, {
            role: 'operator',
            email: 'operator@example.com',
        })

        const memberResponse = await memberApp.request('/api/settings/role-prompts')
        expect(memberResponse.status).toBe(403)

        const operatorResponse = await operatorApp.request('/api/settings/role-prompts')
        expect(operatorResponse.status).toBe(200)
        expect(await operatorResponse.json()).toEqual({
            prompts: [{ role: 'developer', prompt: 'prompt', updatedAt: 1 }],
        })
    })
})

describe('createSettingsRoutes AI profiles', () => {
    function createNamespacedApp(
        store: Record<string, unknown>,
        namespace = 'default',
        options?: { email?: string; role?: 'developer' | 'operator'; orgId?: string; orgRole?: 'member' | 'owner' | 'admin' }
    ) {
        return createSettingsApp(store, {
            email: options?.email,
            role: options?.role,
            orgId: options?.orgId,
            orgRole: options?.orgRole,
        })
    }

    it('supports CRUD for AI profiles in the current org', async () => {
        let profile = {
            id: 'profile-1',
            namespace: 'org:org-a',
            orgId: 'org-a',
            name: 'K1',
            role: 'architect',
            specialties: ['TypeScript'],
            personality: 'Calm',
            greetingTemplate: '你好',
            preferredProjects: ['yoho-remote'],
            workStyle: 'Structured',
            avatarEmoji: '🤖',
            status: 'idle',
            stats: {
                tasksCompleted: 0,
                activeMinutes: 0,
                lastActiveAt: null,
            },
            createdAt: 1,
            updatedAt: 1,
        }

        const store = {
            getAIProfilesByOrg: async () => [profile],
            getAIProfileByOrgAndRole: async () => null,
            createAIProfile: async (input: Record<string, unknown>) => ({
                ...profile,
                ...input,
                id: 'profile-1',
            }),
            getAIProfile: async () => profile,
            updateAIProfile: async (_id: string, input: Record<string, unknown>) => {
                profile = {
                    ...profile,
                    ...input,
                    updatedAt: 2,
                }
                return profile
            },
            deleteAIProfileWithSelfSystemCleanup: async () => true,
            deleteAIProfile: async () => true,
        }

        const app = createNamespacedApp(store, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })

        const listResponse = await app.request('/api/settings/ai-profiles?orgId=org-a')
        expect(listResponse.status).toBe(200)
        expect(await listResponse.json()).toEqual({ profiles: [profile] })

        const createResponse = await app.request('/api/settings/ai-profiles?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'K1',
                role: 'architect',
                specialties: ['TypeScript'],
            }),
        })
        expect(createResponse.status).toBe(200)
        expect(await createResponse.json()).toEqual({
            ok: true,
            profile: expect.objectContaining({
                id: 'profile-1',
                namespace: 'org:org-a',
                orgId: 'org-a',
                name: 'K1',
                role: 'architect',
            }),
        })

        const updateResponse = await app.request('/api/settings/ai-profiles/profile-1?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                personality: 'Sharper',
            }),
        })
        expect(updateResponse.status).toBe(200)
        expect(await updateResponse.json()).toEqual({
            ok: true,
            profile: expect.objectContaining({
                id: 'profile-1',
                personality: 'Sharper',
            }),
        })

        const deleteResponse = await app.request('/api/settings/ai-profiles/profile-1?orgId=org-a', {
            method: 'DELETE',
        })
        expect(deleteResponse.status).toBe(200)
        expect(await deleteResponse.json()).toEqual({ ok: true })
    })

    it('rejects AI profile updates outside the current org', async () => {
        const store = {
            getAIProfile: async () => ({
                id: 'profile-foreign',
                namespace: 'org:org-b',
                orgId: 'org-b',
                name: 'Other',
                role: 'developer',
                specialties: [],
                personality: null,
                greetingTemplate: null,
                preferredProjects: [],
                workStyle: null,
                avatarEmoji: '🤖',
                status: 'idle',
                stats: {
                    tasksCompleted: 0,
                    activeMinutes: 0,
                    lastActiveAt: null,
                },
                createdAt: 1,
                updatedAt: 1,
            }),
        }

        const app = createNamespacedApp(store, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })
        const response = await app.request('/api/settings/ai-profiles/profile-foreign?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                personality: 'Nope',
            }),
        })

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'AI profile not found' })
    })

    it('allows org owners to write org-scoped AI profiles', async () => {
        const store = {
            getAIProfileByOrgAndRole: async () => null,
            createAIProfile: async (input: Record<string, unknown>) => ({
                id: 'profile-owner',
                namespace: input.namespace,
                orgId: input.orgId,
                name: input.name,
                role: input.role,
                specialties: [],
                personality: null,
                greetingTemplate: null,
                preferredProjects: [],
                workStyle: null,
                avatarEmoji: '🤖',
                status: 'idle',
                stats: {
                    tasksCompleted: 0,
                    activeMinutes: 0,
                    lastActiveAt: null,
                },
                createdAt: 1,
                updatedAt: 1,
            }),
        }

        const app = createNamespacedApp(store, 'default', {
            email: 'member@example.com',
            role: 'developer',
            orgId: 'org-a',
            orgRole: 'owner',
        })
        const response = await app.request('/api/settings/ai-profiles?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'K1',
                role: 'architect',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            profile: expect.objectContaining({
                namespace: 'org:org-a',
                orgId: 'org-a',
                name: 'K1',
            }),
        })
    })

    it('allows operator writes for org-scoped AI profiles', async () => {
        const store = {
            getAIProfileByOrgAndRole: async () => null,
            createAIProfile: async (input: Record<string, unknown>) => ({
                id: 'profile-1',
                namespace: input.namespace,
                orgId: input.orgId,
                name: input.name,
                role: input.role,
                specialties: [],
                personality: null,
                greetingTemplate: null,
                preferredProjects: [],
                workStyle: null,
                avatarEmoji: '🤖',
                status: 'idle',
                stats: {
                    tasksCompleted: 0,
                    activeMinutes: 0,
                    lastActiveAt: null,
                },
                createdAt: 1,
                updatedAt: 1,
            }),
        }

        const app = createNamespacedApp(store, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })
        const response = await app.request('/api/settings/ai-profiles?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'K1',
                role: 'architect',
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            profile: expect.objectContaining({
                namespace: 'org:org-a',
                orgId: 'org-a',
                name: 'K1',
            }),
        })
    })
})

describe('createSettingsRoutes brain config', () => {
    function createBrainConfigApp(
        store: Record<string, unknown>,
        namespace = 'default',
        options?: { email?: string; role?: 'developer' | 'operator'; orgId?: string; orgRole?: 'member' | 'owner' | 'admin' }
    ) {
        const app = new Hono<any>()
        app.use('/api/*', async (c, next) => {
            c.set('namespace', namespace)
            if (options?.email) {
                c.set('email', options.email)
            }
            if (options?.role) {
                c.set('role', options.role)
            }
            if (options?.orgId) {
                c.set('orgs', [{
                    id: options.orgId,
                    role: options.orgRole ?? 'owner',
                }])
            }
            await next()
        })
        app.route('/api', createSettingsRoutes(store as any))
        return app
    }

    it('allows org owners to update org-scoped brain config', async () => {
        const app = createBrainConfigApp({
            getBrainConfigByOrg: async () => null,
            getAIProfile: async () => ({
                id: 'profile-1',
                namespace: 'org:org-a',
                orgId: 'org-a',
            }),
            setBrainConfigByOrg: async (orgId: string, config: Record<string, unknown>) => ({
                namespace: `org:${orgId}`,
                orgId,
                agent: config.agent,
                claudeModelMode: config.claudeModelMode ?? 'opus',
                codexModel: config.codexModel ?? 'gpt-5.4',
                extra: config.extra ?? {},
                updatedAt: 1,
                updatedBy: config.updatedBy ?? null,
            }),
        }, 'default', {
            email: 'member@example.com',
            role: 'developer',
            orgId: 'org-a',
            orgRole: 'owner',
        })
        const response = await app.request('/api/settings/brain-config?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                agent: 'claude',
                extra: {
                    selfSystem: {
                        enabled: true,
                        defaultProfileId: 'profile-1',
                        memoryProvider: 'yoho-memory',
                    },
                },
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            config: expect.objectContaining({
                namespace: 'org:org-a',
                orgId: 'org-a',
                agent: 'claude',
            }),
        })
    })

    it('rejects invalid selfSystem config with 400', async () => {
        const app = createBrainConfigApp({}, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })
        const response = await app.request('/api/settings/brain-config?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                agent: 'claude',
                extra: {
                    selfSystem: {
                        enabled: true,
                        memoryProvider: 'yoho-memory',
                        unknownField: true,
                    },
                },
            }),
        })

        expect(response.status).toBe(400)
        const payload = await response.json() as { error: string }
        expect(payload.error).toBe('Invalid config')
    })

    it('rejects selfSystem defaultProfileId outside current org', async () => {
        const store = {
            getBrainConfigByOrg: async () => null,
            getAIProfile: async () => ({
                id: 'profile-foreign',
                namespace: 'org:org-b',
                orgId: 'org-b',
            }),
        }

        const app = createBrainConfigApp(store, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })
        const response = await app.request('/api/settings/brain-config?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                agent: 'claude',
                extra: {
                    selfSystem: {
                        enabled: true,
                        defaultProfileId: 'profile-foreign',
                        memoryProvider: 'yoho-memory',
                    },
                },
            }),
        })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Invalid config',
            details: [{
                path: ['extra', 'selfSystem', 'defaultProfileId'],
                message: 'AI profile not found in current org',
            }],
        })
    })

    it('normalizes stale org selfSystem defaultProfileId when clients resubmit it', async () => {
        let savedConfig: Record<string, unknown> | null = null
        const store = {
            getAIProfile: async () => null,
            getBrainConfigByOrg: async () => ({
                namespace: 'org:org-a',
                orgId: 'org-a',
                agent: 'claude',
                claudeModelMode: 'opus',
                codexModel: 'gpt-5.4',
                extra: {
                    selfSystem: {
                        enabled: true,
                        defaultProfileId: 'profile-stale',
                        memoryProvider: 'yoho-memory',
                    },
                },
                updatedAt: 1,
                updatedBy: 'operator@example.com',
            }),
            setBrainConfigByOrg: async (orgId: string, config: Record<string, unknown>) => {
                savedConfig = config
                return {
                    namespace: `org:${orgId}`,
                    orgId,
                    agent: config.agent,
                    claudeModelMode: config.claudeModelMode ?? 'opus',
                    codexModel: config.codexModel ?? 'gpt-5.4',
                    extra: config.extra ?? {},
                    updatedAt: 1,
                    updatedBy: config.updatedBy ?? null,
                }
            },
        }

        const app = createBrainConfigApp(store, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })
        const response = await app.request('/api/settings/brain-config?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                agent: 'claude',
                extra: {
                    selfSystem: {
                        enabled: true,
                        defaultProfileId: 'profile-stale',
                        memoryProvider: 'none',
                    },
                },
            }),
        })

        expect(response.status).toBe(200)
        expect(savedConfig).toMatchObject({
            extra: {
                selfSystem: {
                    enabled: false,
                    defaultProfileId: null,
                    memoryProvider: 'none',
                },
            },
        })
    })

    it('allows operator updates for org-scoped brain config', async () => {
        const store = {
            getBrainConfigByOrg: async () => null,
            getAIProfile: async () => ({
                id: 'profile-1',
                namespace: 'org:org-a',
                orgId: 'org-a',
            }),
            setBrainConfigByOrg: async (orgId: string, config: Record<string, unknown>) => ({
                namespace: `org:${orgId}`,
                orgId,
                agent: config.agent,
                claudeModelMode: config.claudeModelMode ?? 'opus',
                codexModel: config.codexModel ?? 'gpt-5.4',
                extra: config.extra ?? {},
                updatedAt: 1,
                updatedBy: config.updatedBy ?? null,
            }),
        }

        const app = createBrainConfigApp(store, 'default', {
            email: 'operator@example.com',
            role: 'operator',
            orgId: 'org-a',
        })
        const response = await app.request('/api/settings/brain-config?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                agent: 'claude',
                extra: {
                    selfSystem: {
                        enabled: true,
                        defaultProfileId: 'profile-1',
                        memoryProvider: 'yoho-memory',
                    },
                },
            }),
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            ok: true,
            config: expect.objectContaining({
                namespace: 'org:org-a',
                orgId: 'org-a',
                agent: 'claude',
            }),
        })
    })
})

describe('createSettingsRoutes self system', () => {
    function createSelfSystemApp(
        store: Record<string, unknown>,
        namespace = 'default',
        options?: { email?: string; role?: 'developer' | 'operator'; orgId?: string; orgRole?: 'member' | 'owner' | 'admin' }
    ) {
        const app = new Hono<any>()
        app.use('/api/*', async (c, next) => {
            c.set('namespace', namespace)
            if (options?.email) {
                c.set('email', options.email)
            }
            if (options?.role) {
                c.set('role', options.role)
            }
            if (options?.orgId) {
                c.set('orgs', [{
                    id: options.orgId,
                    role: options.orgRole ?? 'owner',
                }])
            }
            await next()
        })
        app.route('/api', createSettingsRoutes(store as any))
        return app
    }

    it('normalizes stale user selfSystem defaultProfileId when clients resubmit it', async () => {
        let savedConfig: Record<string, unknown> | null = null
        const store = {
            getAIProfile: async () => null,
            getUserSelfSystemConfig: async () => ({
                orgId: 'org-a',
                userEmail: 'member@example.com',
                enabled: true,
                defaultProfileId: 'profile-stale',
                memoryProvider: 'yoho-memory',
                updatedAt: 1,
                updatedBy: 'member@example.com',
            }),
            setUserSelfSystemConfig: async (config: Record<string, unknown>) => {
                savedConfig = config
                return {
                    ...config,
                    updatedAt: 2,
                }
            },
        }

        const app = createSelfSystemApp(store, 'default', {
            email: 'member@example.com',
            role: 'developer',
            orgId: 'org-a',
            orgRole: 'member',
        })
        const response = await app.request('/api/settings/self-system?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                defaultProfileId: 'profile-stale',
                memoryProvider: 'none',
            }),
        })

        expect(response.status).toBe(200)
        expect(savedConfig).toMatchObject({
            orgId: 'org-a',
            userEmail: 'member@example.com',
            enabled: false,
            defaultProfileId: null,
            memoryProvider: 'none',
            updatedBy: 'member@example.com',
        })
    })
})

describe('createSettingsRoutes token sources', () => {
    function createAuthedApp(store: Record<string, unknown>, email = 'owner@example.com') {
        const app = new Hono<any>()
        app.use('/api/*', async (c, next) => {
            c.set('email', email)
            await next()
        })
        app.route('/api', createSettingsRoutes(store as any))
        return app
    }

    it('hides apiKey from non-admin members', async () => {
        const store = {
            getUserOrgRole: async () => 'member',
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {
                    tokenSources: [
                        {
                            id: 'ts-1',
                            name: 'Shared Claude',
                            baseUrl: 'https://proxy.example.com/v1',
                            apiKey: 'secret-token-value',
                            supportedAgents: ['claude'],
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
            }),
        }

        const app = createAuthedApp(store, 'member@example.com')
        const response = await app.request('/api/settings/token-sources?orgId=org-a&includeSecrets=1')
        expect(response.status).toBe(200)

        const data = await response.json() as {
            canManage: boolean
            includeSecrets: boolean
            tokenSources: Array<{ apiKey?: string; apiKeyMasked?: string | null }>
        }
        expect(data.canManage).toBe(false)
        expect(data.includeSecrets).toBe(false)
        expect(data.tokenSources[0]?.apiKey).toBeUndefined()
        expect(data.tokenSources[0]?.apiKeyMasked).toBeTruthy()
    })

    it('supports admin CRUD with org-backed settings storage', async () => {
        let settings: Record<string, unknown> = {}
        const store = {
            getUserOrgRole: async () => 'admin',
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings,
            }),
            updateOrganization: async (_id: string, data: { settings?: Record<string, unknown> }) => {
                settings = data.settings ?? settings
                return {
                    id: 'org-a',
                    name: 'Org A',
                    slug: 'org-a',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: Date.now(),
                    settings,
                }
            },
        }

        const app = createAuthedApp(store)

        const createResponse = await app.request('/api/settings/token-sources?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'Codex Proxy',
                baseUrl: 'https://proxy.example.com/v1/',
                apiKey: 'codex-secret',
                supportedAgents: ['codex'],
            }),
        })
        expect(createResponse.status).toBe(200)
        const created = await createResponse.json() as { tokenSource: { id: string; apiKey?: string; baseUrl: string } }
        expect(created.tokenSource.apiKey).toBe('codex-secret')
        expect(created.tokenSource.baseUrl).toBe('https://proxy.example.com/v1')

        const listResponse = await app.request('/api/settings/token-sources?orgId=org-a&includeSecrets=1')
        expect(listResponse.status).toBe(200)
        const listed = await listResponse.json() as { includeSecrets: boolean; tokenSources: Array<{ id: string; apiKey?: string }> }
        expect(listed.includeSecrets).toBe(true)
        expect(listed.tokenSources[0]?.apiKey).toBe('codex-secret')

        const updateResponse = await app.request(`/api/settings/token-sources/${created.tokenSource.id}?orgId=org-a`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'Unified Proxy',
                supportedAgents: ['claude', 'codex'],
            }),
        })
        expect(updateResponse.status).toBe(200)
        const updated = await updateResponse.json() as { tokenSource: { name: string; supportedAgents: string[]; apiKey?: string } }
        expect(updated.tokenSource.name).toBe('Unified Proxy')
        expect(updated.tokenSource.supportedAgents).toEqual(['claude', 'codex'])
        expect(updated.tokenSource.apiKey).toBe('codex-secret')

        const deleteResponse = await app.request(`/api/settings/token-sources/${created.tokenSource.id}?orgId=org-a`, {
            method: 'DELETE',
        })
        expect(deleteResponse.status).toBe(200)

        const finalList = await app.request('/api/settings/token-sources?orgId=org-a&includeSecrets=1')
        const finalData = await finalList.json() as { tokenSources: unknown[] }
        expect(finalData.tokenSources).toHaveLength(0)
    })

    it('returns localEnabled=true by default and flips via admin PUT', async () => {
        let settings: Record<string, unknown> = {}
        const store = {
            getUserOrgRole: async () => 'admin',
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings,
            }),
            updateOrganization: async (_id: string, data: { settings?: Record<string, unknown> }) => {
                settings = data.settings ?? settings
                return {
                    id: 'org-a',
                    name: 'Org A',
                    slug: 'org-a',
                    createdBy: 'owner@example.com',
                    createdAt: 1,
                    updatedAt: Date.now(),
                    settings,
                }
            },
        }

        const app = createAuthedApp(store)

        const initial = await app.request('/api/settings/token-sources?orgId=org-a')
        expect(initial.status).toBe(200)
        const initialData = await initial.json() as { localEnabled: boolean }
        expect(initialData.localEnabled).toBe(true)

        const disableResponse = await app.request('/api/settings/token-sources/local?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        })
        expect(disableResponse.status).toBe(200)

        const afterDisable = await app.request('/api/settings/token-sources?orgId=org-a')
        const afterDisableData = await afterDisable.json() as { localEnabled: boolean }
        expect(afterDisableData.localEnabled).toBe(false)
    })

    it('rejects non-admin PUT to /token-sources/local with 403', async () => {
        const store = {
            getUserOrgRole: async () => 'member',
            getOrganization: async () => ({
                id: 'org-a',
                name: 'Org A',
                slug: 'org-a',
                createdBy: 'owner@example.com',
                createdAt: 1,
                updatedAt: 1,
                settings: {},
            }),
            updateOrganization: async () => null,
        }

        const app = createAuthedApp(store, 'member@example.com')
        const response = await app.request('/api/settings/token-sources/local?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        })
        expect(response.status).toBe(403)
    })
})
