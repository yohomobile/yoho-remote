export type MockSyncEvent =
    | { type: 'session-added'; sessionId: string; data?: unknown; namespace?: string }
    | { type: 'session-updated'; sessionId: string; data?: unknown; namespace?: string }
    | { type: 'session-removed'; sessionId: string; namespace?: string }
    | { type: 'message-received'; sessionId: string; message: MockMessage; namespace?: string }
    | { type: 'messages-cleared'; sessionId: string; namespace?: string }
    | { type: 'connection-changed'; data?: { status: string }; namespace?: string }
    | { type: 'online-users-changed'; users: Array<{ email: string; clientId: string; deviceType?: string; sessionId: string | null }>; namespace?: string }
    | { type: 'typing-changed'; sessionId: string; typing: { email: string; clientId: string; text: string; updatedAt: number }; namespace?: string }
    | { type: 'file-ready'; sessionId: string; fileInfo: { id: string; filename: string; size: number; mimeType: string }; namespace?: string }

export type MockSession = {
    id: string
    createdAt: number
    active: boolean
    reconnecting?: boolean
    activeAt: number
    updatedAt: number
    lastMessageAt: number | null
    createdBy?: string
    ownerEmail?: string
    metadata: {
        path: string
        host: string
        name?: string
        summary?: { text: string; updatedAt?: number }
        machineId?: string
        flavor?: string | null
        runtimeAgent?: string
        runtimeModel?: string
    }
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    thinking: boolean
    modelMode?: string
    fastMode?: boolean
    activeMonitorCount?: number
    terminationReason?: string
}

export type MockMessage = {
    id: string
    seq: number | null
    localId: string | null
    content: unknown
    createdAt: number
    status?: 'sending' | 'sent' | 'failed'
    originalText?: string
}

export type MockDownload = {
    id: string
    sessionId: string
    orgId: string | null
    filename: string
    mimeType: string
    size: number
    createdAt: number
    content: string
}

export type MockState = {
    namespace: string
    org: {
        id: string
        name: string
        slug: string
        createdBy: string
        createdAt: number
        updatedAt: number
        settings: Record<string, unknown>
        myRole: 'owner' | 'admin' | 'member'
    }
    user: {
        sub: string
        email: string
        name: string
        roles: string[]
    }
    sessions: MockSession[]
    messages: Map<string, MockMessage[]>
    downloads: Map<string, MockDownload[]>
    sseClients: Set<{
        id: string
        namespace: string
        controller: ReadableStreamDefaultController<Uint8Array>
    }>
}

function now(): number {
    return Date.now()
}

function textEncoder(): TextEncoder {
    return new TextEncoder()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

export function assertRenderableMockMessage(message: MockMessage): void {
    if (!isRecord(message.content)) {
        throw new Error(`Mock message ${message.id} content must be an object`)
    }

    const role = message.content.role
    const content = message.content.content
    if (role === 'user') {
        if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
            throw new Error(`Mock user message ${message.id} is not renderable by web normalize`)
        }
        return
    }

    if (role === 'assistant') {
        if (!isRecord(content) || content.type !== 'output') {
            throw new Error(`Mock assistant message ${message.id} must use agent output content`)
        }
        const data = content.data
        if (!isRecord(data) || data.type !== 'assistant') {
            throw new Error(`Mock assistant message ${message.id} output data must be assistant`)
        }
        const assistantMessage = data.message
        if (!isRecord(assistantMessage) || !Array.isArray(assistantMessage.content)) {
            throw new Error(`Mock assistant message ${message.id} must include message.content[]`)
        }
        const hasText = assistantMessage.content.some(part =>
            isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        )
        if (!hasText) {
            throw new Error(`Mock assistant message ${message.id} must include a text part`)
        }
        return
    }

    throw new Error(`Mock message ${message.id} has unsupported role: ${String(role)}`)
}

export function createMockState(runId: string): MockState {
    const timestamp = now()
    const sessionId = `session-${runId}`
    const user = {
        sub: 'e2e-user-1',
        email: 'e2e.operator@example.com',
        name: 'E2E Operator',
        roles: ['operator'],
    }
    const session: MockSession = {
        id: sessionId,
        createdAt: timestamp - 60_000,
        updatedAt: timestamp - 30_000,
        activeAt: timestamp - 30_000,
        lastMessageAt: timestamp - 30_000,
        active: true,
        reconnecting: false,
        thinking: false,
        createdBy: user.email,
        metadata: {
            path: `/tmp/yoho-e2e/${runId}`,
            host: 'e2e-host',
            name: 'P0 Smoke Session',
            summary: { text: 'P0 smoke session ready', updatedAt: timestamp - 30_000 },
            machineId: `machine-${runId}`,
            flavor: 'codex',
            runtimeAgent: 'codex',
            runtimeModel: 'gpt-5.4-mini',
        },
        todoProgress: { completed: 1, total: 2 },
        pendingRequestsCount: 0,
        modelMode: 'gpt-5.4-mini',
        fastMode: true,
        activeMonitorCount: 0,
    }

    const messages = new Map<string, MockMessage[]>()
    const initialMessages: MockMessage[] = [
        {
            id: `${sessionId}-m1`,
            seq: 1,
            localId: null,
            createdAt: timestamp - 40_000,
            content: {
                role: 'user',
                content: { type: 'text', text: 'Initial P0 smoke prompt' },
            },
            status: 'sent',
        },
        {
            id: `${sessionId}-m2`,
            seq: 2,
            localId: null,
            createdAt: timestamp - 35_000,
            content: {
                role: 'assistant',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: 'Initial fake agent response' }],
                        },
                    },
                },
            },
        },
    ]
    initialMessages.forEach(assertRenderableMockMessage)
    messages.set(sessionId, initialMessages)

    const downloads = new Map<string, MockDownload[]>()
    downloads.set(sessionId, [
        {
            id: `download-${runId}`,
            sessionId,
            orgId: 'org-e2e',
            filename: 'smoke-report.txt',
            mimeType: 'text/plain',
            size: 42,
            createdAt: timestamp - 20_000,
            content: `P0 smoke artifact for ${runId}\n`,
        },
    ])

    return {
        namespace: 'default',
        org: {
            id: 'org-e2e',
            name: 'E2E Org',
            slug: 'e2e-org',
            createdBy: user.email,
            createdAt: timestamp - 120_000,
            updatedAt: timestamp - 120_000,
            settings: {},
            myRole: 'owner',
        },
        user,
        sessions: [session],
        messages,
        downloads,
        sseClients: new Set(),
    }
}

export function appendSseClient(
    state: MockState,
    client: { id: string; namespace: string; controller: ReadableStreamDefaultController<Uint8Array> }
): void {
    state.sseClients.add(client)
    sendSse(client.controller, {
        type: 'online-users-changed',
        namespace: state.namespace,
        users: [{ email: state.user.email, clientId: client.id, deviceType: 'desktop', sessionId: null }],
    })
}

export function removeSseClient(
    state: MockState,
    client: { id: string; namespace: string; controller: ReadableStreamDefaultController<Uint8Array> }
): void {
    state.sseClients.delete(client)
}

export function broadcastSse(state: MockState, event: MockSyncEvent): void {
    for (const client of state.sseClients) {
        if (event.namespace && event.namespace !== client.namespace) {
            continue
        }
        sendSse(client.controller, event)
    }
}

function sendSse(controller: ReadableStreamDefaultController<Uint8Array>, event: unknown): void {
    controller.enqueue(textEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
}

export function toFullSession(session: MockSession): Record<string, unknown> {
    return {
        id: session.id,
        createdAt: session.createdAt,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
        active: session.active,
        reconnecting: session.reconnecting,
        thinking: session.thinking,
        createdBy: session.createdBy,
        metadata: session.metadata,
        agentState: null,
        todos: [
            { id: 'todo-1', content: 'Create smoke skeleton', status: 'completed', priority: 'high' },
            { id: 'todo-2', content: 'Keep fake agent controllable', status: 'pending', priority: 'high' },
        ],
        permissionMode: 'default',
        modelMode: session.modelMode,
        fastMode: session.fastMode,
        activeMonitors: [],
        terminationReason: session.terminationReason,
    }
}
