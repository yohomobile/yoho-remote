import { describe, expect, test } from 'bun:test'
import { matchSessionToProject } from './projectMatching'
import type { Project, SessionSummary } from '@/types/api'

describe('matchSessionToProject', () => {
    const projects: Project[] = [
        {
            id: 'project-a',
            name: 'YohoRemoteA',
            path: '/home/workspaces/repos/yoho-remote',
            description: null,
            machineId: 'machine-a',
            createdAt: 1,
            updatedAt: 1,
        },
        {
            id: 'project-b',
            name: 'YohoRemoteB',
            path: '/home/workspaces/repos/yoho-remote',
            description: null,
            machineId: 'machine-b',
            createdAt: 1,
            updatedAt: 1,
        },
        {
            id: 'worktree-a',
            name: 'YohoRemoteWorktree',
            path: '/home/workspaces/repos/yoho-remote',
            description: null,
            machineId: 'machine-a',
            createdAt: 1,
            updatedAt: 1,
        },
    ]

    function createSession(path: string, machineId?: string, basePath?: string): SessionSummary {
        return {
            id: 'session-1',
            createdAt: 1,
            active: true,
            activeAt: 1,
            updatedAt: 1,
            lastMessageAt: null,
            metadata: {
                path,
                machineId,
                worktree: basePath ? { basePath, branch: 'feat/test', name: 'wt' } : undefined,
            },
            todoProgress: null,
            pendingRequestsCount: 0,
            thinking: false,
        }
    }

    test('prefers projects on the same machine when paths overlap', () => {
        const session = createSession('/home/workspaces/repos/yoho-remote', 'machine-b')
        expect(matchSessionToProject(session, projects)?.id).toBe('project-b')
    })

    test('matches worktree sessions against the same machine base path', () => {
        const session = createSession(
            '/home/workspaces/repos/yoho-remote-feature',
            'machine-a',
            '/home/workspaces/repos/yoho-remote-feature'
        )
        expect(matchSessionToProject(session, projects)?.machineId).toBe('machine-a')
    })

    test('returns null when the session has no machineId', () => {
        const session = createSession('/home/workspaces/repos/yoho-remote')
        expect(matchSessionToProject(session, projects)).toBeNull()
    })
})
