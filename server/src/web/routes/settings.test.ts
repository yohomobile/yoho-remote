import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createSettingsRoutes } from './settings'

describe('createSettingsRoutes projects', () => {
    it('passes machineId through when listing projects', async () => {
        const calls: Array<{ machineId: string | null | undefined; orgId: string | null | undefined }> = []
        const store = {
            getProjects: async (machineId?: string | null, orgId?: string | null) => {
                calls.push({ machineId, orgId })
                return []
            },
        }

        const app = new Hono()
        app.route('/api', createSettingsRoutes(store as any))

        const response = await app.request('/api/settings/projects?machineId=machine-a&orgId=org-a')
        expect(response.status).toBe(200)
        expect(calls).toEqual([
            { machineId: 'machine-a', orgId: 'org-a' },
        ])
    })

    it('stores created and updated projects with machine and workspace-group scope', async () => {
        const addCalls: Array<{
            machineId: string | null | undefined
            orgId: string | null | undefined
            workspaceGroupId: string | null | undefined
        }> = []
        const updateCalls: Array<{ machineId: string | null | undefined; workspaceGroupId: string | null | undefined }> = []
        const store = {
            getProjects: async () => [],
            getProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: null,
                workspaceGroupId: 'workspace-a',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            addProject: async (_name: string, _path: string, _description?: string, machineId?: string | null, orgId?: string | null, workspaceGroupId?: string | null) => {
                addCalls.push({ machineId, orgId, workspaceGroupId })
                return {
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId: null,
                    workspaceGroupId,
                    orgId,
                    createdAt: 1,
                    updatedAt: 1,
                }
            },
            updateProject: async (_id: string, fields: { machineId?: string | null; workspaceGroupId?: string | null }) => {
                updateCalls.push({ machineId: fields.machineId, workspaceGroupId: fields.workspaceGroupId })
                return {
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId: null,
                    workspaceGroupId: fields.workspaceGroupId ?? null,
                    orgId: 'org-a',
                    createdAt: 1,
                    updatedAt: 2,
                }
            },
        }

        const app = new Hono()
        app.route('/api', createSettingsRoutes(store as any))

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
                workspaceGroupId: 'workspace-a'
            }),
        })
        expect(updateResponse.status).toBe(200)

        expect(addCalls).toEqual([
            { machineId: 'machine-a', orgId: 'org-a', workspaceGroupId: null },
        ])
        expect(updateCalls).toEqual([
            { machineId: undefined, workspaceGroupId: 'workspace-a' },
        ])
    })

    it('rejects shared projects without a workspace group', async () => {
        let addCalled = false
        let updateCalled = false
        const store = {
            getProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: null,
                workspaceGroupId: null,
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            addProject: async () => {
                addCalled = true
                return null
            },
            updateProject: async () => {
                updateCalled = true
                return null
            },
        }

        const app = new Hono()
        app.route('/api', createSettingsRoutes(store as any))

        const createResponse = await app.request('/api/settings/projects?orgId=org-a', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
            }),
        })
        expect(createResponse.status).toBe(400)

        const updateResponse = await app.request('/api/settings/projects/project-1?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                description: 'rename without scope change'
            }),
        })
        expect(updateResponse.status).toBe(400)
        expect(addCalled).toBe(false)
        expect(updateCalled).toBe(false)
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
                workspaceGroupId: null,
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
                workspaceGroupId: null,
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
                workspaceGroupId: null,
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 2,
            }),
            removeProject: async () => true,
        }

        const app = new Hono()
        app.route('/api', createSettingsRoutes(store as any))

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
})
