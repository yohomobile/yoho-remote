import { describe, expect, it, vi } from 'vitest'

import { buildReservedSessionLoadScope, loadOrCreateRuntimeSession } from './runtimeSessionBootstrap'

describe('buildReservedSessionLoadScope', () => {
    it('returns mainSessionId when provided', () => {
        expect(buildReservedSessionLoadScope('brain-main')).toEqual({ mainSessionId: 'brain-main' })
    })

    it('omits scope when mainSessionId is empty', () => {
        expect(buildReservedSessionLoadScope('')).toBeUndefined()
        expect(buildReservedSessionLoadScope('   ')).toBeUndefined()
        expect(buildReservedSessionLoadScope(undefined)).toBeUndefined()
    })
})

describe('loadOrCreateRuntimeSession', () => {
    it('loads the reserved session with brain-child scope when mainSessionId exists', async () => {
        const getSession = vi.fn(async () => ({
            id: 'reserved-child',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
        }))
        const getOrCreateSession = vi.fn()

        const session = await loadOrCreateRuntimeSession({
            api: { getSession, getOrCreateSession } as any,
            tag: 'tag-1',
            metadata: { path: '/tmp/project' } as any,
            state: null,
            yohoRemoteSessionId: 'reserved-child',
            mainSessionId: 'brain-main',
            logPrefix: '[test]',
        })

        expect(session.id).toBe('reserved-child')
        expect(getSession).toHaveBeenCalledWith('reserved-child', { mainSessionId: 'brain-main' })
        expect(getOrCreateSession).not.toHaveBeenCalled()
    })

    it('falls back to creating a new session when reserved-session load fails', async () => {
        const getSession = vi.fn(async () => {
            throw new Error('400')
        })
        const getOrCreateSession = vi.fn(async () => ({
            id: 'new-child',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
        }))

        const session = await loadOrCreateRuntimeSession({
            api: { getSession, getOrCreateSession } as any,
            tag: 'tag-2',
            metadata: { path: '/tmp/project' } as any,
            state: null,
            yohoRemoteSessionId: 'reserved-child',
            mainSessionId: 'brain-main',
            logPrefix: '[test]',
        })

        expect(session.id).toBe('new-child')
        expect(getSession).toHaveBeenCalledWith('reserved-child', { mainSessionId: 'brain-main' })
        expect(getOrCreateSession).toHaveBeenCalledWith({
            tag: 'tag-2',
            metadata: { path: '/tmp/project' },
            state: null,
        })
    })
})
