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

function createPersonRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'person-1',
        namespace: 'default',
        org_id: 'org-1',
        person_type: 'human',
        status: 'active',
        canonical_name: 'Dev User',
        primary_email: 'dev@example.com',
        employee_code: null,
        avatar_url: null,
        attributes: {},
        created_at: '1700000000000',
        updated_at: '1700000000100',
        created_by: 'admin@example.com',
        merged_into_person_id: null,
        ...overrides,
    }
}

function createPersonIdentityLinkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'link-1',
        person_id: 'person-1',
        identity_id: 'ident-1',
        relation_type: 'primary',
        state: 'admin_verified',
        confidence: 0.95,
        source: 'admin',
        evidence: ['email_exact'],
        decision_reason: 'confirmed',
        valid_from: '1700000000000',
        valid_to: null,
        decided_by: 'admin@example.com',
        created_at: '1700000000000',
        updated_at: '1700000000100',
        ...overrides,
    }
}

function createPersonIdentityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'ident-1',
        namespace: 'org-1',
        org_id: 'org-1',
        channel: 'feishu',
        provider_tenant_id: '',
        external_id: 'ou_user_1',
        secondary_id: null,
        account_type: 'human',
        assurance: 'medium',
        canonical_email: 'dev@example.com',
        display_name: 'Dev User',
        login_name: null,
        employee_code: null,
        status: 'active',
        attributes: {},
        first_seen_at: '1700000000000',
        last_seen_at: '1700000000100',
        created_at: '1700000000000',
        updated_at: '1700000000100',
        ...overrides,
    }
}

function createPersonIdentityAuditRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'audit-1',
        namespace: 'default',
        org_id: 'org-1',
        action: 'merge_persons',
        actor_email: 'admin@example.com',
        person_id: 'person-source',
        target_person_id: 'person-target',
        identity_id: null,
        link_id: null,
        reason: 'duplicate person',
        payload: {},
        created_at: '1700000000200',
        ...overrides,
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

    it('declares identity graph tables and review indexes in schema bootstrap', () => {
        expect(source).toContain('CREATE TABLE IF NOT EXISTS persons')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS person_identities')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS person_identity_links')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS person_identity_candidates')
        expect(source).toContain('CREATE TABLE IF NOT EXISTS person_identity_audits')
        expect(source).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_person_identity_link')
        expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_person_identity_candidates_open')
        expect(source).toContain('CREATE INDEX IF NOT EXISTS idx_person_identity_audits_scope')
        expect(source).toContain('decision_reason TEXT')
    })
})

describe('PostgresStore identity graph governance', () => {
    it('mergePersons marks the source person merged and writes identity audit in one transaction', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('SELECT * FROM persons') && params?.[0] === 'person-source') {
                return { rows: [createPersonRow({ id: 'person-source', canonical_name: 'Dev User A' })] }
            }
            if (sql.includes('SELECT * FROM persons') && params?.[0] === 'person-target') {
                return { rows: [createPersonRow({ id: 'person-target', canonical_name: 'Dev User' })] }
            }
            if (sql.includes("SET status = 'merged'")) {
                return {
                    rows: [createPersonRow({
                        id: 'person-source',
                        status: 'merged',
                        merged_into_person_id: 'person-target',
                        updated_at: '1700000000200',
                    })],
                }
            }
            if (sql.includes('INSERT INTO person_identity_audits')) {
                return { rows: [createPersonIdentityAuditRow()] }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const originalNow = Date.now
        Date.now = () => 1_700_000_000_200
        try {
            await expect(store.mergePersons({
                namespace: 'default',
                orgId: 'org-1',
                sourcePersonId: 'person-source',
                targetPersonId: 'person-target',
                reason: 'duplicate person',
                decidedBy: 'admin@example.com',
            })).resolves.toMatchObject({
                id: 'person-source',
                status: 'merged',
                mergedIntoPersonId: 'person-target',
            })
        } finally {
            Date.now = originalNow
        }

        expect(calls.map((call) => call.sql)).toContain('BEGIN')
        expect(calls.map((call) => call.sql)).toContain('COMMIT')
        const updateCall = calls.find((call) => call.sql.includes("SET status = 'merged'"))
        expect(updateCall?.params).toEqual(['person-source', 'person-target', 1_700_000_000_200])
        const auditCall = calls.find((call) => call.sql.includes('INSERT INTO person_identity_audits'))
        expect(auditCall?.params?.slice(1, 12)).toEqual([
            'default',
            'org-1',
            'merge_persons',
            'admin@example.com',
            'person-source',
            'person-target',
            null,
            null,
            'duplicate person',
            {
                sourcePerson: expect.objectContaining({ id: 'person-source' }),
                targetPerson: expect.objectContaining({ id: 'person-target' }),
            },
            1_700_000_000_200,
        ])
    })

    it('detachPersonIdentityLink closes the active link and writes identity audit', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('FROM person_identity_links l')) {
                return { rows: [createPersonIdentityLinkRow()] }
            }
            if (sql.includes("SET state = 'detached'")) {
                return {
                    rows: [createPersonIdentityLinkRow({
                        state: 'detached',
                        valid_to: '1700000000300',
                        decision_reason: 'wrong account',
                    })],
                }
            }
            if (sql.includes('INSERT INTO person_identity_audits')) {
                return {
                    rows: [createPersonIdentityAuditRow({
                        action: 'detach_identity_link',
                        person_id: 'person-1',
                        target_person_id: null,
                        identity_id: 'ident-1',
                        link_id: 'link-1',
                        reason: 'wrong account',
                        created_at: '1700000000300',
                    })],
                }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const originalNow = Date.now
        Date.now = () => 1_700_000_000_300
        try {
            await expect(store.detachPersonIdentityLink({
                namespace: 'default',
                orgId: 'org-1',
                linkId: 'link-1',
                reason: 'wrong account',
                decidedBy: 'admin@example.com',
            })).resolves.toMatchObject({
                id: 'link-1',
                state: 'detached',
                validTo: 1_700_000_000_300,
            })
        } finally {
            Date.now = originalNow
        }

        const updateCall = calls.find((call) => call.sql.includes("SET state = 'detached'"))
        expect(updateCall?.params).toEqual(['link-1', 1_700_000_000_300, 'wrong account', 'admin@example.com'])
        const auditCall = calls.find((call) => call.sql.includes('INSERT INTO person_identity_audits'))
        expect(auditCall?.params?.slice(1, 12)).toEqual([
            'default',
            'org-1',
            'detach_identity_link',
            'admin@example.com',
            'person-1',
            null,
            'ident-1',
            'link-1',
            'wrong account',
            {
                linkBefore: expect.objectContaining({ id: 'link-1' }),
            },
            1_700_000_000_300,
        ])
    })

    it('findResolvedActorByChannelExternalId reads a unique identity without mutating namespace scope', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            if (sql.includes('SELECT * FROM person_identities') && sql.includes('external_id = $2')) {
                return { rows: [createPersonIdentityRow()] }
            }
            if (sql.includes('SELECT * FROM person_identity_links')) {
                return { rows: [createPersonIdentityLinkRow()] }
            }
            if (sql.includes('SELECT * FROM persons') && params?.[0] === 'person-1') {
                return { rows: [createPersonRow()] }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        await expect(store.findResolvedActorByChannelExternalId('feishu', 'ou_user_1')).resolves.toEqual({
            identityId: 'ident-1',
            personId: 'person-1',
            channel: 'feishu',
            resolution: 'admin_verified',
            displayName: 'Dev User',
            email: 'dev@example.com',
            externalId: 'ou_user_1',
            accountType: 'human',
        })

        expect(calls[0]?.params).toEqual(['feishu', 'ou_user_1'])
    })

    it('getPersonWithIdentities returns person + active verified identity/link pairs', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            if (sql.includes('SELECT * FROM persons') && sql.includes('namespace = $2')) {
                return { rows: [createPersonRow({ id: 'person-1' })] }
            }
            if (sql.includes('FROM person_identity_links') && sql.includes('person_id = $1')) {
                return {
                    rows: [
                        createPersonIdentityLinkRow({ id: 'link-1', identity_id: 'ident-1' }),
                        createPersonIdentityLinkRow({ id: 'link-2', identity_id: 'ident-2', confidence: 0.8 }),
                    ],
                }
            }
            if (sql.includes('FROM person_identities WHERE id = ANY')) {
                return {
                    rows: [
                        createPersonIdentityRow({ id: 'ident-1', external_id: 'ou_user_1' }),
                        createPersonIdentityRow({ id: 'ident-2', external_id: 'keycloak-xyz', channel: 'keycloak' }),
                    ],
                }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const result = await store.getPersonWithIdentities({
            namespace: 'default',
            orgId: 'org-1',
            personId: 'person-1',
        })

        expect(result).not.toBeNull()
        expect(result!.person.id).toBe('person-1')
        expect(result!.identities).toHaveLength(2)
        expect(result!.identities[0]).toEqual({
            link: expect.objectContaining({ id: 'link-1', identityId: 'ident-1' }),
            identity: expect.objectContaining({ id: 'ident-1', externalId: 'ou_user_1' }),
        })
        expect(result!.identities[1]).toEqual({
            link: expect.objectContaining({ id: 'link-2', identityId: 'ident-2' }),
            identity: expect.objectContaining({ id: 'ident-2', channel: 'keycloak' }),
        })

        const linksCall = calls.find((call) => call.sql.includes('FROM person_identity_links') && call.sql.includes('person_id = $1'))
        expect(linksCall?.sql).toContain("state IN ('auto_verified', 'admin_verified')")
        expect(linksCall?.sql).toContain('valid_to IS NULL')
    })

    it('getPersonWithIdentities returns null when person does not belong to the org namespace', async () => {
        const store = createStore(async (sql) => {
            if (sql.includes('SELECT * FROM persons') && sql.includes('namespace = $2')) {
                return { rows: [] }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const result = await store.getPersonWithIdentities({
            namespace: 'default',
            orgId: 'org-1',
            personId: 'person-missing',
        })

        expect(result).toBeNull()
    })

    it('getPersonWithIdentities skips the identity lookup when there are no active links', async () => {
        const queries: string[] = []
        const store = createStore(async (sql) => {
            queries.push(sql)
            if (sql.includes('SELECT * FROM persons') && sql.includes('namespace = $2')) {
                return { rows: [createPersonRow()] }
            }
            if (sql.includes('FROM person_identity_links')) {
                return { rows: [] }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const result = await store.getPersonWithIdentities({
            namespace: 'default',
            orgId: 'org-1',
            personId: 'person-1',
        })

        expect(result).not.toBeNull()
        expect(result!.identities).toEqual([])
        expect(queries.some((q) => q.includes('FROM person_identities WHERE id = ANY'))).toBe(false)
    })
})

describe('PostgresStore AI profile cleanup transaction', () => {
    it('clears org and user self-system references before deleting an AI profile', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('SELECT * FROM brain_config WHERE namespace = $1 FOR UPDATE')) {
                return {
                    rows: [{
                        namespace: 'org:org-1',
                        extra: {
                            childClaudeModels: ['sonnet'],
                            selfSystem: {
                                enabled: true,
                                defaultProfileId: 'profile-1',
                                memoryProvider: 'yoho-memory',
                            },
                        },
                    }],
                }
            }
            if (sql.includes('UPDATE brain_config')) {
                return { rows: [], rowCount: 1 }
            }
            if (sql.includes('UPDATE user_self_system_settings')) {
                return { rows: [], rowCount: 2 }
            }
            if (sql.includes('DELETE FROM ai_profiles')) {
                return { rows: [], rowCount: 1 }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const originalNow = Date.now
        Date.now = () => 1_700_000_000_200
        try {
            await expect(store.deleteAIProfileWithSelfSystemCleanup('org-1', 'profile-1', 'owner@example.com')).resolves.toBe(true)
        } finally {
            Date.now = originalNow
        }

        const brainConfigUpdate = calls.find((call) => call.sql.includes('UPDATE brain_config'))
        expect(brainConfigUpdate).toBeDefined()
        expect(JSON.parse(brainConfigUpdate?.params?.[0] as string)).toEqual({
            childClaudeModels: ['sonnet'],
            selfSystem: {
                enabled: false,
                defaultProfileId: null,
                memoryProvider: 'yoho-memory',
            },
        })
        expect(brainConfigUpdate?.params?.slice(1)).toEqual([
            1_700_000_000_200,
            'owner@example.com',
            'org:org-1',
        ])

        const userCleanup = calls.find((call) => call.sql.includes('UPDATE user_self_system_settings'))
        expect(userCleanup?.params).toEqual([
            'org-1',
            'profile-1',
            1_700_000_000_200,
            'owner@example.com',
        ])
        expect(calls.at(-1)?.sql).toBe('COMMIT')
    })

    it('rolls back when the AI profile deletion does not remove any row', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
                return { rows: [] }
            }
            if (sql.includes('SELECT * FROM brain_config WHERE namespace = $1 FOR UPDATE')) {
                return { rows: [] }
            }
            if (sql.includes('UPDATE user_self_system_settings')) {
                return { rows: [], rowCount: 0 }
            }
            if (sql.includes('DELETE FROM ai_profiles')) {
                return { rows: [], rowCount: 0 }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        await expect(store.deleteAIProfileWithSelfSystemCleanup('org-1', 'profile-missing', 'owner@example.com')).resolves.toBe(false)
        expect(calls.at(-1)?.sql).toBe('ROLLBACK')
        expect(calls.some((call) => call.sql === 'COMMIT')).toBe(false)
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

describe('PostgresStore session history search', () => {
    it('scopes mainSessionId searches to orchestration child sessions only', async () => {
        const calls: MockQueryCall[] = []
        const sessionRow = createSessionRow({
            metadata: {
                source: 'brain-child',
                mainSessionId: 'brain-main-1',
                path: '/tmp/brain-child',
                summary: { text: 'publisher worker' },
            },
            active: false,
        })
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            return {
                rows: [{
                    ...sessionRow,
                    matched_summary: null,
                    matched_summary_created_at: null,
                    matched_summary_seq_start: null,
                    matched_summary_seq_end: null,
                }],
            }
        })

        await store.searchSessionHistory({
            namespace: 'ns-a',
            query: 'publisher worker',
            limit: 5,
            includeOffline: true,
            mainSessionId: 'brain-main-1',
        })

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toContain(`LOWER(COALESCE(s.metadata->>'source', '')) IN ('brain-child', 'orchestrator-child')`)
        expect(calls[0]?.sql).toContain(`s.metadata->>'mainSessionId' = $2`)
        expect(calls[0]?.params?.[1]).toBe('brain-main-1')
    })

    it('normalizes source filters so mixed-case brain queries still match exact-match SQL paths', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({
                sql,
                params: Array.isArray(params) ? params : undefined,
            })
            return { rows: [] }
        })

        await store.searchSessionHistory({
            namespace: 'ns-a',
            query: 'publisher worker',
            limit: 5,
            includeOffline: true,
            source: 'BRAIN-CHILD',
        })

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toContain(`LOWER(COALESCE(s.metadata->>'source', '')) = $2`)
        expect(calls[0]?.params?.[1]).toBe('brain-child')
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
        expect(calls[0]?.sql).toContain('ON CONFLICT (id) DO UPDATE SET updated_at = $7')
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

describe('PostgresStore brain_config upsert by org', () => {
    it('uses ON CONFLICT (namespace) namespaced as org:<id> and persists org_id column', async () => {
        const calls: MockQueryCall[] = []
        const store = createStore(async (sql, params) => {
            calls.push({ sql, params: Array.isArray(params) ? params : undefined })
            if (sql.includes('INSERT INTO brain_config')) {
                return {
                    rows: [{
                        namespace: 'org:org-1',
                        org_id: 'org-1',
                        agent: 'claude',
                        claude_model_mode: 'opus',
                        codex_model: 'gpt-5.4',
                        extra: { feature: 'x' },
                        updated_at: 1_700_000_000_000,
                        updated_by: 'owner@example.com',
                    }],
                }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const originalNow = Date.now
        Date.now = () => 1_700_000_000_000
        try {
            const result = await store.setBrainConfigByOrg('org-1', {
                agent: 'claude',
                extra: { feature: 'x' },
                updatedBy: 'owner@example.com',
            })
            expect(result.namespace).toBe('org:org-1')
            expect(result.orgId).toBe('org-1')
            expect(result.agent).toBe('claude')
        } finally {
            Date.now = originalNow
        }

        const upsert = calls.find(call => call.sql.includes('INSERT INTO brain_config'))
        expect(upsert).toBeDefined()
        expect(upsert?.sql).toContain('ON CONFLICT (namespace)')
        expect(upsert?.sql).toContain('org_id = EXCLUDED.org_id')
        // params: [namespace, org_id, agent, claude_model_mode, codex_model, extra, updated_at, updated_by]
        expect(upsert?.params?.[0]).toBe('org:org-1')
        expect(upsert?.params?.[1]).toBe('org-1')
        expect(upsert?.params?.[2]).toBe('claude')
        expect(upsert?.params?.[3]).toBe('opus')
        expect(upsert?.params?.[4]).toBe('gpt-5.4')
        expect(JSON.parse(upsert?.params?.[5] as string)).toEqual({ feature: 'x' })
        expect(upsert?.params?.[6]).toBe(1_700_000_000_000)
        expect(upsert?.params?.[7]).toBe('owner@example.com')
    })

    it('getBrainConfigByOrg returns org-scoped row and exposes orgId on the DTO', async () => {
        const store = createStore(async (sql, params) => {
            if (sql === 'SELECT * FROM brain_config WHERE org_id = $1') {
                expect(params).toEqual(['org-42'])
                return {
                    rows: [{
                        namespace: 'org:org-42',
                        org_id: 'org-42',
                        agent: 'codex',
                        claude_model_mode: null,
                        codex_model: 'gpt-5.4',
                        extra: {},
                        updated_at: 1_700_000_000_500,
                        updated_by: null,
                    }],
                }
            }
            throw new Error(`unexpected query: ${sql}`)
        })

        const result = await store.getBrainConfigByOrg('org-42')
        expect(result).toEqual({
            namespace: 'org:org-42',
            orgId: 'org-42',
            agent: 'codex',
            claudeModelMode: null,
            codexModel: 'gpt-5.4',
            extra: {},
            updatedAt: 1_700_000_000_500,
            updatedBy: null,
        })
    })

    it('getBrainConfigByOrg returns null when no row exists for that org', async () => {
        const store = createStore(async () => ({ rows: [] }))
        await expect(store.getBrainConfigByOrg('org-missing')).resolves.toBeNull()
    })
})
