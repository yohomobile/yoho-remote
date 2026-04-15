import { beforeAll, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { configuration, createConfiguration } from '../../configuration'
import { createCliRoutes } from './cli'

function authHeaders() {
    return {
        authorization: `Bearer ${configuration.cliApiToken}`,
        'content-type': 'application/json',
    }
}

describe('createCliRoutes projects', () => {
    beforeAll(async () => {
        await createConfiguration()
    })

    it('rejects project listing and creation for sessions without machineId', async () => {
        let getProjectsCalled = false
        let addProjectCalled = false
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: null,
                orgId: 'org-a',
            }),
            getProjects: async () => {
                getProjectsCalled = true
                return []
            },
            addProject: async () => {
                addProjectCalled = true
                return null
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const listResponse = await app.request('/cli/projects?sessionId=session-1', {
            method: 'GET',
            headers: authHeaders(),
        })
        expect(listResponse.status).toBe(400)
        expect(await listResponse.json()).toEqual({
            error: 'Project operations require a machine-bound session',
        })

        const createResponse = await app.request('/cli/projects?sessionId=session-1', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
            }),
        })
        expect(createResponse.status).toBe(400)
        expect(await createResponse.json()).toEqual({
            error: 'Project operations require a machine-bound session',
        })

        expect(getProjectsCalled).toBe(false)
        expect(addProjectCalled).toBe(false)
    })

    it('rejects updates and deletes for projects on another machine', async () => {
        let updateProjectCalled = false
        let removeProjectCalled = false
        const store = {
            getSessionByNamespace: async () => ({
                id: 'session-1',
                machineId: 'machine-a',
                orgId: 'org-a',
            }),
            getProject: async () => ({
                id: 'project-1',
                name: 'YohoRemote',
                path: '/home/workspaces/repos/yoho-remote',
                description: null,
                machineId: 'machine-b',
                orgId: 'org-a',
                createdAt: 1,
                updatedAt: 1,
            }),
            updateProject: async () => {
                updateProjectCalled = true
                return null
            },
            removeProject: async () => {
                removeProjectCalled = true
                return true
            },
        }

        const app = new Hono()
        app.route('/cli', createCliRoutes(() => null, undefined, store as any))

        const updateResponse = await app.request('/cli/projects/project-1?sessionId=session-1', {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({
                name: 'YohoRemote',
            }),
        })
        expect(updateResponse.status).toBe(404)

        const deleteResponse = await app.request('/cli/projects/project-1?sessionId=session-1', {
            method: 'DELETE',
            headers: authHeaders(),
        })
        expect(deleteResponse.status).toBe(404)

        expect(updateProjectCalled).toBe(false)
        expect(removeProjectCalled).toBe(false)
    })
})
