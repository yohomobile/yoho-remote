import { describe, expect, it, vi } from 'vitest'

import { startYohoRemoteServer } from './startYohoRemoteServer'

function createFakeClient(sessionSource: string | null) {
    return {
        sessionId: 'session-1',
        getMetadata: () => ({
            source: sessionSource ?? undefined,
            machineId: 'machine-1',
        }),
        sendClaudeSessionMessage: vi.fn(),
    } as any
}

describe('startYohoRemoteServer tool registration', () => {
    it('does not register raw brain session tools for brain-child sessions', async () => {
        const server = await startYohoRemoteServer(createFakeClient('brain-child'), {
            sessionSource: 'brain-child',
            apiClient: {} as any,
            machineId: 'machine-1',
            yohoRemoteSessionId: 'session-1',
            workingDirectory: '/tmp',
        })

        try {
            expect(server.toolNames).toContain('chat_messages')
            expect(server.toolNames).toContain('ask_user_question')
            expect(server.toolNames).not.toContain('session_status')
            expect(server.toolNames).not.toContain('session_tail')
            expect(server.toolNames).not.toContain('session_send')
            expect(server.toolNames).not.toContain('session_set_config')
            expect(server.toolNames).not.toContain('session_status_self')
            expect(server.toolNames).not.toContain('session_tail_self')
        } finally {
            server.stop()
        }
    })

    it('keeps raw brain tools for top-level brain sessions', async () => {
        const server = await startYohoRemoteServer(createFakeClient('brain'), {
            sessionSource: 'brain',
            apiClient: {} as any,
            machineId: 'machine-1',
            yohoRemoteSessionId: 'session-1',
            workingDirectory: '/tmp',
        })

        try {
            expect(server.toolNames).toContain('chat_messages')
            expect(server.toolNames).toContain('session_status')
            expect(server.toolNames).toContain('session_tail')
            expect(server.toolNames).toContain('session_send')
            expect(server.toolNames).toContain('session_set_config')
            expect(server.toolNames).not.toContain('ask_user_question')
            expect(server.toolNames).not.toContain('session_status_self')
            expect(server.toolNames).not.toContain('session_tail_self')
        } finally {
            server.stop()
        }
    })

    it('does not register brain wrappers for ordinary sessions', async () => {
        const server = await startYohoRemoteServer(createFakeClient('webapp'), {
            sessionSource: 'webapp',
            apiClient: {} as any,
            machineId: 'machine-1',
            yohoRemoteSessionId: 'session-1',
            workingDirectory: '/tmp',
        })

        try {
            expect(server.toolNames).not.toContain('chat_messages')
            expect(server.toolNames).not.toContain('ask_user_question')
            expect(server.toolNames).not.toContain('session_status_self')
            expect(server.toolNames).not.toContain('session_tail_self')
            expect(server.toolNames).not.toContain('session_status')
            expect(server.toolNames).not.toContain('session_tail')
            expect(server.toolNames).not.toContain('session_send')
            expect(server.toolNames).not.toContain('session_set_config')
        } finally {
            server.stop()
        }
    })
})
