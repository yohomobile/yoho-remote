import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { createSettingsRoutes } from './settings'

describe('createSettingsRoutes projects', () => {
    it('ignores machineId when listing shared projects', async () => {
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
            { machineId: undefined, orgId: 'org-a' },
        ])
    })

    it('stores created and updated projects as org-shared items', async () => {
        const addCalls: Array<{ machineId: string | null | undefined; orgId: string | null | undefined }> = []
        const updateCalls: Array<{ machineId: string | null | undefined }> = []
        const store = {
            getProjects: async () => [],
            addProject: async (_name: string, _path: string, _description?: string, machineId?: string | null, orgId?: string | null) => {
                addCalls.push({ machineId, orgId })
                return {
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId: null,
                    orgId,
                    createdAt: 1,
                    updatedAt: 1,
                }
            },
            updateProject: async (_id: string, _name: string, _path: string, _description?: string, machineId?: string | null) => {
                updateCalls.push({ machineId })
                return {
                    id: 'project-1',
                    name: 'YohoRemote',
                    path: '/home/workspaces/repos/yoho-remote',
                    description: null,
                    machineId: null,
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
                machineId: 'machine-a',
            }),
        })
        expect(createResponse.status).toBe(200)

        const updateResponse = await app.request('/api/settings/projects/project-1?orgId=org-a', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                machineId: 'machine-b',
            }),
        })
        expect(updateResponse.status).toBe(200)

        expect(addCalls).toEqual([
            { machineId: null, orgId: 'org-a' },
        ])
        expect(updateCalls).toEqual([
            { machineId: null },
        ])
    })
})
