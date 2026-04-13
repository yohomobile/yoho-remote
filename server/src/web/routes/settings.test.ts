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
})
