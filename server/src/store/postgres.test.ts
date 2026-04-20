import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PostgresStore } from './postgres'

const source = readFileSync(new URL('./postgres.ts', import.meta.url), 'utf8')

type MockQueryResult = {
    rows: Array<Record<string, unknown>>
    rowCount?: number
}

type MockQueryCall = {
    sql: string
    params: unknown[] | undefined
}

function createStore(queryImpl: (sql: string, params?: unknown[]) => Promise<MockQueryResult>): PostgresStore {
    const store = Object.create(PostgresStore.prototype) as PostgresStore
    ;(store as any).pool = {
        query: queryImpl,
        connect: async () => ({
            query: queryImpl,
            release() {}
        })
    }
    return store
}

function createUserTextMessage(text: string): Record<string, unknown> {
    return {
        role: 'user',
        content: {
            type: 'text',
            text
        }
    }
}

function createAssistantTextMessage(text: string): Record<string, unknown> {
    return {
        role: 'assistant',
        content: {
            type: 'text',
            text
        }
    }
}

function createAgentEventMessage(): Record<string, unknown> {
    return {
        role: 'agent',
        content: {
            type: 'event',
            event: 'noop'
        }
    }
}

function createUserToolResultMessage(): Record<string, unknown> {
    return {
        role: 'user',
        content: [
            {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: 'command completed'
            }
        ]
    }
}

function createSessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'session-1',
        tag: 'tag-1',
        namespace: 'ns-a',
        machine_id: 'machine-1',
        created_at: '1700000000000',
        updated_at: '1700000000100',
        created_by: 'dev@example.com',
        org_id: 'org-1',
        metadata: { flavor: 'codex' },
        metadata_version: 2,
        agent_state: { mode: 'auto' },
        agent_state_version: 3,
        todos: [{ content: 'todo' }],
        todos_updated_at: '1700000000200',
        active: true,
        active_at: '1700000000300',
        thinking: false,
        thinking_at: null,
        seq: 9,
        advisor_task_id: 'task-1',
        creator_chat_id: 'chat-1',
        advisor_mode: true,
        advisor_prompt_injected: true,
        role_prompt_sent: false,
        permission_mode: 'default',
        model_mode: 'gpt-5.4',
        model_reasoning_effort: 'medium',
        fast_mode: false,
        termination_reason: null,
        last_message_at: '1700000000400',
        active_monitors: [{ id: 'monitor-1' }],
        ...overrides
    }
}

describe('PostgresStore schema migrations', () => {
    it('adds project scope columns before creating dependent indexes', () => {
        const addMachineId = source.indexOf('ALTER TABLE projects ADD COLUMN IF NOT EXISTS machine_id TEXT;')
        const addWorkspaceGroupId = source.indexOf('ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_group_id TEXT;')
        const createMachineIdIndex = source.indexOf('CREATE INDEX IF NOT EXISTS idx_projects_machine_id ON projects(machine_id);')
        const createWorkspaceGroupIdIndex = source.indexOf('CREATE INDEX IF NOT EXISTS idx_projects_workspace_group_id ON projects(workspace_group_id);')

        expect(addMachineId).toBeGreaterThan(-1)
        expect(addWorkspaceGroupId).toBeGreaterThan(-1)
        expect(createMachineIdIndex).toBeGreaterThan(-1)
        expect(createWorkspaceGroupIdIndex).toBeGreaterThan(-1)

        expect(addMachineId).toBeLessThan(createMachineIdIndex)
        expect(addWorkspaceGroupId).toBeLessThan(createWorkspaceGroupIdIndex)
    })

    it('declares thinking columns in sessions schema and migration statements', () => {
        expect(source).toContain('thinking BOOLEAN DEFAULT FALSE')
        expect(source).toContain('thinking_at BIGINT')
        expect(source).toContain('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thinking BOOLEAN DEFAULT FALSE;')
        expect(source).toContain('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thinking_at BIGINT;')
    })

    it('declares minimal control plane tables in schema bootstrap', () => {
        const dedupeApprovalDecisions = source.indexOf('DELETE FROM approval_decisions d')
        const resyncApprovalRequestStatus = source.indexOf('UPDATE approval_requests r')
        const createDecisionUniqueIndex = source.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_decisions_request_unique ON approval_decisions(approval_request_id)')

        expect(source).toContain('CREATE TABLE IF NOT EXISTS approval_requests')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS approval_decisions')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS capability_grants')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS audit_events')
        expect(source).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_decisions_request_unique ON approval_decisions(approval_request_id)')
        expect(source).toContain("ROW_NUMBER() OVER (\n                            PARTITION BY approval_request_id")
        expect(source).toContain("WHEN 'provider_failed' THEN 'rejected'")
        expect(dedupeApprovalDecisions).toBeGreaterThan(-1)
        expect(resyncApprovalRequestStatus).toBeGreaterThan(-1)
        expect(createDecisionUniqueIndex).toBeGreaterThan(-1)
        expect(dedupeApprovalDecisions).toBeLessThan(createDecisionUniqueIndex)
        expect(resyncApprovalRequestStatus).toBeLessThan(createDecisionUniqueIndex)
    })
})

describe('PostgresStore session thinking persistence', () => {
    it('writes thinking and thinking_at for true/false transitions', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })
            return { rows: [], rowCount: 1 }
        })

        const originalNow = Date.now
        let nowCallCount = 0
        Date.now = () => {
            nowCallCount += 1
            return nowCallCount === 1 ? 1_700_000_000_001 : 1_700_000_000_999
        }

        try {
            await store.setSessionThinking('session-1', true, 'ns-a')
            await store.setSessionThinking('session-1', false, 'ns-a')
        } finally {
            Date.now = originalNow
        }

        expect(calls).toHaveLength(2)
        expect(calls[0]?.sql).toContain('SET thinking = $1, thinking_at = $2')
        expect(calls[0]?.params).toEqual([true, 1_700_000_000_001, 'session-1', 'ns-a'])
        expect(calls[1]?.params).toEqual([false, 1_700_000_000_999, 'session-1', 'ns-a'])
    })
})

describe('PostgresStore control plane persistence', () => {
    it('createApprovalRequestAtomically rolls back when audit persistence fails', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })

            if (sql === 'BEGIN' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('INSERT INTO approval_requests')) {
                return {
                    rows: [{
                        id: 'approval-1',
                        namespace: 'default',
                        org_id: 'org-1',
                        session_id: 'session-1',
                        parent_session_id: null,
                        request_kind: 'tool_permission',
                        tool_name: 'yoho_memory_remember',
                        resource_type: 'memory',
                        resource_selector: null,
                        requested_mode: 'safe-yolo',
                        requested_tools: ['remember'],
                        request_payload: null,
                        risk_level: 'medium',
                        provider_hint: null,
                        requested_by_type: 'user',
                        requested_by_id: 'user-1',
                        status: 'pending',
                        requested_at: '1700000000000',
                        expires_at: null,
                    }],
                    rowCount: 1,
                }
            }
            if (sql.includes('INSERT INTO audit_events')) {
                throw new Error('audit insert failed')
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(store.createApprovalRequestAtomically({
            request: {
                namespace: 'default',
                orgId: 'org-1',
                sessionId: 'session-1',
                requestKind: 'tool_permission',
                toolName: 'yoho_memory_remember',
                resourceType: 'memory',
                requestedMode: 'safe-yolo',
                requestedTools: ['remember'],
                riskLevel: 'medium',
                requestedByType: 'user',
                requestedById: 'user-1',
                status: 'pending',
            },
            auditEvent: {
                namespace: 'default',
                orgId: 'org-1',
                eventType: 'approval_request.created',
                subjectType: 'user',
                subjectId: 'user-1',
                sessionId: 'session-1',
                resourceType: 'memory',
                action: 'tool_permission',
                result: 'pending',
                sourceSystem: 'control-plane',
            },
        })).rejects.toThrow('audit insert failed')

        expect(calls.map((call) => call.sql)).toContain('BEGIN')
        expect(calls.map((call) => call.sql)).toContain('ROLLBACK')
        expect(calls.map((call) => call.sql)).not.toContain('COMMIT')
    })

    it('recordApprovalDecisionAtomically rolls back when audit persistence fails', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })

            if (sql === 'BEGIN' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('SELECT status FROM approval_requests')) {
                return {
                    rows: [{ status: 'pending' }],
                    rowCount: 1,
                }
            }
            if (sql.includes('SELECT id FROM approval_decisions')) {
                return {
                    rows: [],
                    rowCount: 0,
                }
            }
            if (sql.includes('INSERT INTO approval_decisions')) {
                return {
                    rows: [{
                        id: 'decision-1',
                        approval_request_id: 'approval-1',
                        namespace: 'default',
                        org_id: 'org-1',
                        provider: 'manual',
                        result: 'approved',
                        decided_by_type: 'user',
                        decided_by_id: 'user-1',
                        decision_payload: null,
                        decided_at: '1700000000000',
                        expires_at: null,
                    }],
                    rowCount: 1,
                }
            }
            if (sql.includes('UPDATE approval_requests SET status = $2 WHERE id = $1')) {
                return { rows: [], rowCount: 1 }
            }
            if (sql.includes('INSERT INTO audit_events')) {
                throw new Error('audit insert failed')
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(store.recordApprovalDecisionAtomically({
            decision: {
                approvalRequestId: 'approval-1',
                namespace: 'default',
                orgId: 'org-1',
                provider: 'manual',
                result: 'approved',
                decidedByType: 'user',
                decidedById: 'user-1',
            },
            requestStatus: 'approved',
            auditEvent: {
                namespace: 'default',
                orgId: 'org-1',
                eventType: 'approval_decision.recorded',
                subjectType: 'user',
                subjectId: 'user-1',
                action: 'tool_permission',
                result: 'approved',
                sourceSystem: 'control-plane',
            },
        })).rejects.toThrow('audit insert failed')

        expect(calls.map((call) => call.sql)).toContain('BEGIN')
        expect(calls.map((call) => call.sql)).toContain('ROLLBACK')
        expect(calls.map((call) => call.sql)).not.toContain('COMMIT')
    })

    it('issueCapabilityGrantAtomically rolls back when audit persistence fails', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })

            if (sql === 'BEGIN' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('INSERT INTO capability_grants')) {
                return {
                    rows: [{
                        id: 'grant-1',
                        approval_request_id: 'approval-1',
                        approval_decision_id: 'decision-1',
                        namespace: 'default',
                        org_id: 'org-1',
                        subject_type: 'session',
                        subject_id: 'session-1',
                        source_session_id: 'session-1',
                        bound_session_id: 'session-1',
                        bound_machine_id: null,
                        bound_project_ids: ['project-1'],
                        tool_allowlist: ['remember'],
                        resource_scopes: { memory: ['remember'] },
                        mode_cap: 'safe-yolo',
                        max_uses: null,
                        used_count: 0,
                        status: 'active',
                        issued_at: '1700000000000',
                        expires_at: null,
                        revoked_at: null,
                        revoke_reason: null,
                    }],
                    rowCount: 1,
                }
            }
            if (sql.includes('INSERT INTO audit_events')) {
                throw new Error('audit insert failed')
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(store.issueCapabilityGrantAtomically({
            grant: {
                namespace: 'default',
                orgId: 'org-1',
                approvalRequestId: 'approval-1',
                approvalDecisionId: 'decision-1',
                subjectType: 'session',
                subjectId: 'session-1',
                sourceSessionId: 'session-1',
                boundSessionId: 'session-1',
                toolAllowlist: ['remember'],
                modeCap: 'safe-yolo',
                status: 'active',
            },
            auditEvent: {
                namespace: 'default',
                orgId: 'org-1',
                eventType: 'capability_grant.issued',
                subjectType: 'session',
                subjectId: 'session-1',
                resourceType: 'capability_grant',
                action: 'issue',
                result: 'active',
                sourceSystem: 'control-plane',
            },
        })).rejects.toThrow('audit insert failed')

        expect(calls.map((call) => call.sql)).toContain('BEGIN')
        expect(calls.map((call) => call.sql)).toContain('ROLLBACK')
        expect(calls.map((call) => call.sql)).not.toContain('COMMIT')
    })

    it('revokeCapabilityGrant stamps revoked status and reason', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })
            return {
                rows: [{
                    id: 'grant-1',
                    approval_request_id: null,
                    approval_decision_id: null,
                    namespace: 'default',
                    org_id: 'org-1',
                    subject_type: 'session',
                    subject_id: 'session-1',
                    source_session_id: 'session-1',
                    bound_session_id: 'session-1',
                    bound_machine_id: null,
                    bound_project_ids: ['project-1'],
                    tool_allowlist: ['remember'],
                    resource_scopes: { memory: ['remember'] },
                    mode_cap: 'safe-yolo',
                    max_uses: null,
                    used_count: 0,
                    status: 'revoked',
                    issued_at: '1700000000000',
                    expires_at: null,
                    revoked_at: '1700000000999',
                    revoke_reason: 'manual revoke',
                }],
            }
        })

        const originalNow = Date.now
        Date.now = () => 1_700_000_000_999
        try {
            await expect(store.revokeCapabilityGrant('grant-1', 'manual revoke')).resolves.toMatchObject({
                id: 'grant-1',
                status: 'revoked',
                revokeReason: 'manual revoke',
                revokedAt: 1_700_000_000_999,
            })
        } finally {
            Date.now = originalNow
        }

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toContain("SET status = 'revoked', revoked_at = $2, revoke_reason = $3")
        expect(calls[0]?.params).toEqual(['grant-1', 1_700_000_000_999, 'manual revoke'])
    })
})

describe('PostgresStore session thinking read mapping', () => {
    it('maps thinking and thinkingAt in toStoredSession()', () => {
        const store = createStore(async () => ({ rows: [] }))

        const thinkingRow = createSessionRow({
            thinking: true,
            thinking_at: '1700000000555'
        })
        const idleRow = createSessionRow({
            id: 'session-2',
            thinking: false,
            thinking_at: null
        })

        const thinkingSession = (store as any).toStoredSession(thinkingRow) as {
            thinking: boolean
            thinkingAt: number | null
        }
        const idleSession = (store as any).toStoredSession(idleRow) as {
            thinking: boolean
            thinkingAt: number | null
        }

        expect(thinkingSession.thinking).toBe(true)
        expect(thinkingSession.thinkingAt).toBe(1_700_000_000_555)
        expect(idleSession.thinking).toBe(false)
        expect(idleSession.thinkingAt).toBeNull()
    })

    it('exposes mapped thinking fields through getSession()', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })
            return {
                rows: [
                    createSessionRow({
                        id: 'session-42',
                        thinking: true,
                        thinking_at: '1700000000666'
                    })
                ]
            }
        })

        await expect(store.getSession('session-42')).resolves.toMatchObject({
            id: 'session-42',
            thinking: true,
            thinkingAt: 1_700_000_000_666
        })
        expect(calls[0]?.sql).toContain('SELECT * FROM sessions WHERE id = $1')
        expect(calls[0]?.params).toEqual(['session-42'])
    })

    it('exposes mapped thinking fields through getSessionsByNamespace()', async () => {
        const store = createStore(async () => ({
            rows: [
                createSessionRow({
                    id: 'session-a',
                    thinking: true,
                    thinking_at: '1700000000777'
                }),
                createSessionRow({
                    id: 'session-b',
                    thinking: false,
                    thinking_at: null
                })
            ]
        }))

        await expect(store.getSessionsByNamespace('ns-a')).resolves.toEqual([
            expect.objectContaining({
                id: 'session-a',
                thinking: true,
                thinkingAt: 1_700_000_000_777
            }),
            expect.objectContaining({
                id: 'session-b',
                thinking: false,
                thinkingAt: null
            })
        ])
    })
})

describe('PostgresStore.getOrCreateSession', () => {
    it('uses a single insert-on-conflict statement and returns the stored row', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })

            return {
                rows: [
                    createSessionRow({
                        id: 'tag-1',
                        tag: 'tag-1',
                        namespace: 'ns-a',
                        updated_at: '1700000000999'
                    })
                ]
            }
        })

        await expect(store.getOrCreateSession('tag-1', { flavor: 'codex' }, { mode: 'auto' }, 'ns-a')).resolves.toMatchObject({
            id: 'tag-1',
            tag: 'tag-1',
            namespace: 'ns-a'
        })

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toContain('ON CONFLICT (id) DO UPDATE SET updated_at = $6')
        expect(calls[0]?.params?.[0]).toBe('tag-1')
        expect(calls[0]?.params?.[1]).toBe('tag-1')
        expect(calls[0]?.params?.[2]).toBe('ns-a')
    })
})

describe('PostgresStore.setSessionActive', () => {
    it('clears termination_reason when null is passed explicitly', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })
            return { rows: [], rowCount: 1 }
        })

        await expect(store.setSessionActive('session-1', false, 1_700_000_001_234, 'ns-a', null)).resolves.toBe(true)

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toContain('termination_reason = NULL')
        expect(calls[0]?.params).toEqual([false, 1_700_000_001_234, 'session-1', 'ns-a'])
    })
})

describe('PostgresStore.addMessage', () => {
    it('preserves source timestamps when they are present in the payload', async () => {
        const clientCalls: MockQueryCall[] = []
        const poolCalls: MockQueryCall[] = []
        const sourceTimestamp = Date.parse('2026-04-17T00:00:00.000Z')
        const insertedRow = {
            id: 'message-1',
            session_id: 'session-1',
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        timestamp: '2026-04-17T00:00:00.000Z',
                        type: 'message',
                        message: 'done'
                    }
                }
            },
            created_at: String(sourceTimestamp),
            seq: 7,
            local_id: null
        }

        const client = {
            query: async (sql: string, params?: unknown[]) => {
                clientCalls.push({
                    sql,
                    params: Array.isArray(params) ? params : undefined
                })

                if (sql === 'BEGIN' || sql === 'COMMIT') {
                    return { rows: [] }
                }
                if (sql.includes('SELECT id FROM sessions WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 'session-1' }] }
                }
                if (sql.includes('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE session_id = $1')) {
                    return { rows: [{ next_seq: 7 }] }
                }
                if (sql.includes('INSERT INTO messages (id, session_id, content, created_at, seq, local_id)')) {
                    return { rows: [], rowCount: 1 }
                }
                if (sql.includes('UPDATE sessions SET seq = seq + 1, updated_at = $1, last_message_at = $1 WHERE id = $2')) {
                    return { rows: [], rowCount: 1 }
                }
                if (sql.includes('UPDATE sessions SET seq = seq + 1, updated_at = $1 WHERE id = $2')) {
                    return { rows: [], rowCount: 1 }
                }
                if (sql.includes('SELECT * FROM messages WHERE session_id = $1 AND local_id = $2 LIMIT 1')) {
                    return { rows: [] }
                }
                throw new Error(`Unexpected client SQL: ${sql}`)
            },
            release() {}
        }

        const store = Object.create(PostgresStore.prototype) as any
        store.pool = {
            query: async (sql: string, params?: unknown[]) => {
                poolCalls.push({
                    sql,
                    params: Array.isArray(params) ? params : undefined
                })
                if (sql === 'SELECT * FROM messages WHERE id = $1') {
                    return { rows: [insertedRow] }
                }
                throw new Error(`Unexpected pool SQL: ${sql}`)
            },
            connect: async () => client
        }

        await expect(store.addMessage('session-1', {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    timestamp: '2026-04-17T00:00:00.000Z',
                    type: 'message',
                    message: 'done'
                }
            }
        })).resolves.toMatchObject({
            id: 'message-1',
            createdAt: sourceTimestamp
        })

        const insertCall = clientCalls.find((call) => call.sql.includes('INSERT INTO messages'))
        expect(insertCall?.params?.[3]).toBe(sourceTimestamp)
        expect(poolCalls).toHaveLength(1)
        expect(poolCalls[0]?.sql).toBe('SELECT * FROM messages WHERE id = $1')
    })

    it('returns the existing row when a localId conflict is detected', async () => {
        const clientCalls: MockQueryCall[] = []
        const existingRow = {
            id: 'existing-message',
            session_id: 'session-1',
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        id: 'codex-message-1',
                        message: 'already stored'
                    }
                }
            },
            created_at: '1700000000123',
            seq: 4,
            local_id: 'codex-message-1'
        }

        const client = {
            query: async (sql: string, params?: unknown[]) => {
                clientCalls.push({
                    sql,
                    params: Array.isArray(params) ? params : undefined
                })

                if (sql === 'BEGIN' || sql === 'COMMIT') {
                    return { rows: [] }
                }
                if (sql.includes('SELECT * FROM messages WHERE session_id = $1 AND local_id = $2')) {
                    return { rows: clientCalls.length === 2 ? [] : [existingRow] }
                }
                if (sql.includes('SELECT id FROM sessions WHERE id = $1 FOR UPDATE')) {
                    return { rows: [{ id: 'session-1' }] }
                }
                if (sql.includes('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE session_id = $1')) {
                    return { rows: [{ next_seq: 5 }] }
                }
                if (sql.includes('INSERT INTO messages (id, session_id, content, created_at, seq, local_id)')) {
                    return { rows: [], rowCount: 0 }
                }
                throw new Error(`Unexpected client SQL: ${sql}`)
            },
            release() {}
        }

        const store = Object.create(PostgresStore.prototype) as any
        store.pool = {
            query: async () => ({ rows: [] }),
            connect: async () => client
        }

        await expect(store.addMessage('session-1', {
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    id: 'codex-message-1',
                    message: 'already stored'
                }
            }
        }, 'codex-message-1')).resolves.toMatchObject({
            id: 'existing-message',
            localId: 'codex-message-1'
        })

        expect(clientCalls.some((call) => call.sql.includes('ON CONFLICT (session_id, local_id) DO NOTHING'))).toBe(true)
        expect(clientCalls.some((call) => call.sql.includes('UPDATE sessions SET seq = seq + 1'))).toBe(false)
    })
})

describe('PostgresStore.clearMessages', () => {
    it('keeps the most recent N messages using OFFSET keepCount', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })

            if (sql.includes('SELECT COUNT(*) FROM messages WHERE session_id = $1')) {
                return { rows: [{ count: '5' }] }
            }

            if (sql.includes('DELETE FROM messages WHERE session_id = $1 AND seq <= (')) {
                return { rows: [], rowCount: 2 }
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(store.clearMessages('session-1', 3)).resolves.toEqual({
            deleted: 2,
            remaining: 3
        })

        expect(calls).toHaveLength(2)
        expect(calls[0]?.sql).toContain('SELECT COUNT(*) FROM messages WHERE session_id = $1')
        expect(calls[0]?.params).toEqual(['session-1'])
        expect(calls[1]?.sql).toContain('OFFSET $2')
        expect(calls[1]?.params).toEqual(['session-1', 3])
    })

    it('deletes all messages when keepCount is zero', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined
            })

            if (sql === 'DELETE FROM messages WHERE session_id = $1') {
                return { rows: [], rowCount: 5 }
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        })

        await expect(store.clearMessages('session-1', 0)).resolves.toEqual({
            deleted: 5,
            remaining: 0
        })

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toBe('DELETE FROM messages WHERE session_id = $1')
        expect(calls[0]?.params).toEqual(['session-1'])
    })
})

describe('PostgresStore.getTurnBoundary', () => {
    it('returns null when there is no valid assistant or agent reply after the user turn start', async () => {
        let queryCount = 0
        const store = createStore(async () => {
            queryCount += 1
            if (queryCount === 1) {
                return {
                    rows: [
                        { seq: 10, content: createUserTextMessage('继续') }
                    ]
                }
            }
            return {
                rows: [
                    { seq: 10, content: createUserTextMessage('继续') },
                    { seq: 11, content: createAgentEventMessage() }
                ]
            }
        })

        await expect(store.getTurnBoundary('session-1')).resolves.toBeNull()
    })

    it('ignores tool_result pseudo-user rows as turn start and ignores trailing events for turn end', async () => {
        let queryCount = 0
        const store = createStore(async () => {
            queryCount += 1
            if (queryCount === 1) {
                return {
                    rows: [
                        { seq: 3, content: createUserToolResultMessage() },
                        { seq: 1, content: createUserTextMessage('帮我总结一下') }
                    ]
                }
            }
            return {
                rows: [
                    { seq: 1, content: createUserTextMessage('帮我总结一下') },
                    { seq: 2, content: createAssistantTextMessage('这是总结') },
                    { seq: 3, content: createUserToolResultMessage() },
                    { seq: 4, content: createAgentEventMessage() }
                ]
            }
        })

        await expect(store.getTurnBoundary('session-1')).resolves.toEqual({
            turnStartSeq: 1,
            turnEndSeq: 3
        })
    })
})
