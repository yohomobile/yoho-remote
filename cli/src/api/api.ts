import axios from 'axios'
import { randomBytes } from 'node:crypto'
import type {
    AgentState,
    CliMessagesResponse,
    CreateMachineResponse,
    CreateSessionResponse,
    DaemonState,
    Machine,
    MachineMetadata,
    Metadata,
    Project,
    Session,
    SessionModelReasoningEffort,
} from '@/api/types'
import { AgentStateSchema, CliMessagesResponseSchema, CreateMachineResponseSchema, CreateSessionResponseSchema, DaemonStateSchema, MachineMetadataSchema, MetadataSchema } from '@/api/types'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { ApiMachineClient } from './apiMachine'
import { ApiSessionClient } from './apiSession'

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export type StoredMessage = {
    id: string
    seq: number
    createdAt: number
    localId?: string | null
    content: unknown
}

export class ApiClient {
    static async create(): Promise<ApiClient> {
        return new ApiClient(getAuthToken())
    }

    private constructor(private readonly token: string) { }

    async getSession(sessionId: string): Promise<Session> {
        const response = await axios.get<CreateSessionResponse>(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const parsed = CreateSessionResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw new Error('Invalid /cli/sessions/:id response')
        }

        const raw = parsed.data.session

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const agentState = (() => {
            if (raw.agentState == null) return null
            const parsedAgentState = AgentStateSchema.safeParse(raw.agentState)
            return parsedAgentState.success ? parsedAgentState.data : null
        })()

        return {
            id: raw.id,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            orgId: raw.orgId ?? null,
            metadata,
            metadataVersion: raw.metadataVersion,
            agentState,
            agentStateVersion: raw.agentStateVersion,
            thinking: (raw as any).thinking ?? undefined,
            thinkingAt: (raw as any).thinkingAt ?? undefined,
        }
    }

    async getOrCreateSession(opts: {
        tag: string
        metadata: Metadata
        state: AgentState | null
    }): Promise<Session> {
        const response = await axios.post<CreateSessionResponse>(
            `${configuration.serverUrl}/cli/sessions`,
            {
                tag: opts.tag,
                metadata: opts.metadata,
                agentState: opts.state
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const parsed = CreateSessionResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw new Error('Invalid /cli/sessions response')
        }

        const raw = parsed.data.session

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const agentState = (() => {
            if (raw.agentState == null) return null
            const parsedAgentState = AgentStateSchema.safeParse(raw.agentState)
            return parsedAgentState.success ? parsedAgentState.data : null
        })()

        return {
            id: raw.id,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            agentState,
            agentStateVersion: raw.agentStateVersion
        }
    }

    async getOrCreateMachine(opts: {
        machineId: string
        metadata: MachineMetadata
        daemonState?: DaemonState
    }): Promise<Machine> {
        const response = await axios.post<CreateMachineResponse>(
            `${configuration.serverUrl}/cli/machines`,
            {
                id: opts.machineId,
                metadata: opts.metadata,
                daemonState: opts.daemonState ?? null
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60_000
            }
        )

        const parsed = CreateMachineResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw new Error('Invalid /cli/machines response')
        }

        const raw = parsed.data.machine

        const metadata = (() => {
            if (raw.metadata == null) return null
            const parsedMetadata = MachineMetadataSchema.safeParse(raw.metadata)
            return parsedMetadata.success ? parsedMetadata.data : null
        })()

        const daemonState = (() => {
            if (raw.daemonState == null) return null
            const parsedDaemonState = DaemonStateSchema.safeParse(raw.daemonState)
            return parsedDaemonState.success ? parsedDaemonState.data : null
        })()

        return {
            id: raw.id,
            seq: raw.seq,
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt,
            active: raw.active,
            activeAt: raw.activeAt,
            metadata,
            metadataVersion: raw.metadataVersion,
            daemonState,
            daemonStateVersion: raw.daemonStateVersion
        }
    }

    sessionSyncClient(session: Session): ApiSessionClient {
        return new ApiSessionClient(this.token, session)
    }

    machineSyncClient(machine: Machine): ApiMachineClient {
        return new ApiMachineClient(this.token, machine)
    }

    async getSessionMessages(sessionId: string, opts?: { afterSeq?: number; limit?: number }): Promise<StoredMessage[]> {
        const params: Record<string, unknown> = {}
        if (opts?.afterSeq !== undefined) {
            params.afterSeq = opts.afterSeq
        }
        if (opts?.limit !== undefined) {
            params.limit = opts.limit
        }

        const response = await axios.get<CliMessagesResponse>(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/messages`,
            {
                params,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )

        const parsed = CliMessagesResponseSchema.safeParse(response.data)
        if (!parsed.success) {
            throw new Error('Invalid /cli/sessions/:id/messages response')
        }

        return parsed.data.messages.map(m => ({
            id: m.id,
            seq: m.seq,
            createdAt: m.createdAt,
            localId: m.localId,
            content: m.content
        }))
    }

    async sendMessageToSession(sessionId: string, text: string, sentFrom?: string): Promise<void> {
        const idempotencyKey = ulid()
        let lastError: unknown = null
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await axios.post(
                    `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/messages`,
                    { text, sentFrom },
                    {
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            'Content-Type': 'application/json',
                            'idempotency-key': idempotencyKey
                        },
                        timeout: 30_000
                    }
                )
                return
            } catch (error: unknown) {
                lastError = error
                if (!isRetryableSendMessageError(error)) {
                    throw error
                }
                if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * (2 ** attempt)))
                }
            }
        }
        throw lastError
    }

    // ===== Brain tools API methods =====

    async brainSpawnSession(opts: {
        machineId: string
        directory: string
        agent?: string
        modelMode?: string
        codexModel?: string
        source?: string
        mainSessionId?: string
        caller?: string
        brainPreferences?: Record<string, unknown>
    }): Promise<{ type: 'success'; sessionId: string; logs?: unknown[] } | { type: 'error'; message: string; logs?: unknown[] }> {
        const response = await axios.post(
            `${configuration.serverUrl}/cli/brain/spawn`,
            {
                machineId: opts.machineId,
                directory: opts.directory,
                agent: opts.agent ?? 'claude',
                modelMode: opts.modelMode,
                codexModel: opts.codexModel,
                source: opts.source ?? 'brain-child',
                mainSessionId: opts.mainSessionId,
                caller: opts.caller,
                brainPreferences: opts.brainPreferences,
            },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 120_000  // Spawn can take a while
            }
        )
        return response.data
    }

    async listSessions(opts?: { includeOffline?: boolean }): Promise<{
        sessions: Array<{
            id: string
            active: boolean
            activeAt: number
            thinking: boolean
            modelMode?: string
            pendingRequestsCount: number
            metadata: {
                path?: string
                source?: string
                machineId?: string
                flavor?: string
                summary?: { text: string }
                mainSessionId?: string
                brainSummary?: string
            } | null
        }>
    }> {
        const params = opts?.includeOffline ? '?includeOffline=true' : ''
        const response = await axios.get(
            `${configuration.serverUrl}/cli/sessions${params}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data
    }

    async deleteSession(sessionId: string): Promise<{ ok: boolean }> {
        const response = await axios.delete(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
        return response.data
    }

    async abortSession(sessionId: string): Promise<{ ok: boolean }> {
        const response = await axios.post(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/abort`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
        return response.data
    }

    async resumeSession(sessionId: string): Promise<{
        type: 'already-active' | 'resumed' | 'created'
        sessionId: string
        resumedFrom?: string
        usedResume?: boolean
    }> {
        const response = await axios.post(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/resume`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 120_000
            }
        )
        return response.data
    }

    async patchSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<void> {
        await axios.patch(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/metadata`,
            patch,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
    }

    async setSessionModelMode(sessionId: string, modelMode: 'default' | 'sonnet' | 'opus' | 'opus-4-7'): Promise<void> {
        await this.setSessionConfig(sessionId, {
            model: modelMode,
        })
    }

    async setSessionConfig(sessionId: string, config: {
        permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
        model?: string
        reasoningEffort?: SessionModelReasoningEffort
        fastMode?: boolean
    }): Promise<{
        ok: boolean
        applied?: {
            permissionMode?: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
            model?: string
            reasoningEffort?: SessionModelReasoningEffort
            fastMode?: boolean
        }
    }> {
        const response = await axios.post(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/config`,
            config,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
        return response.data
    }

    async getSessionStatus(sessionId: string): Promise<{
        active: boolean
        thinking: boolean
        initDone: boolean
        messageCount: number
        lastUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; contextSize: number } | null
        modelMode?: string
        metadata: { path?: string; summary?: { text: string }; brainSummary?: string } | null
    }> {
        const response = await axios.get(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/status`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data
    }

    async getSessionInspect(sessionId: string): Promise<{
        sessionId: string
        status: 'offline' | 'running' | 'idle'
        active: boolean
        thinking: boolean
        initDone: boolean
        activeAt: number
        updatedAt: number
        thinkingAt: number | null
        lastMessageAt: number | null
        messageCount: number
        pendingRequestsCount: number
        pendingRequests: Array<{
            id: string
            tool: string
            createdAt: number | null
        }>
        permissionMode?: string
        modelMode?: string
        modelReasoningEffort?: string
        runtimeAgent: string | null
        runtimeModel: string | null
        runtimeModelReasoningEffort: string | null
        fastMode: boolean | null
        todoProgress: { completed: number; total: number } | null
        todos: Array<{
            content: string
            status: 'pending' | 'in_progress' | 'completed'
            priority: 'high' | 'medium' | 'low'
            id: string
        }> | null
        activeMonitors: Array<{
            id: string
            description: string
            command: string
            persistent: boolean
            timeoutMs: number | null
            startedAt: number
            taskId: string | null
            state: 'running' | 'unknown'
        }>
        terminationReason: string | null
        lastUsage: {
            input_tokens: number
            output_tokens: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
            contextSize: number
        } | null
        contextWindow: {
            budgetTokens: number
            usedTokens: number
            remainingTokens: number
            remainingPercent: number
        } | null
        metadata: {
            path: string | null
            summary: { text: string; updatedAt: number } | null
            brainSummary: string | null
            source: string | null
            caller: string | null
            machineId: string | null
            flavor: string | null
            mainSessionId: string | null
        }
    }> {
        const response = await axios.get(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/inspect`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data
    }

    async getSessionTail(sessionId: string, opts?: { limit?: number }): Promise<{
        sessionId: string
        items: Array<{
            seq: number
            createdAt: number
            role: 'user' | 'assistant' | 'agent'
            kind: 'user' | 'assistant' | 'result' | 'tool-call' | 'tool-result' | 'tool-summary' | 'todo' | 'plan' | 'reasoning' | 'system' | 'message' | 'raw'
            subtype: string | null
            sentFrom: string | null
            snippet: string
        }>
        returned: number
        inspectedMessages: number
        newestSeq: number | null
        oldestSeq: number | null
        hasMoreHistory: boolean
    }> {
        const params = new URLSearchParams()
        if (opts?.limit !== undefined) {
            params.set('limit', String(opts.limit))
        }
        const query = params.toString()
        const response = await axios.get(
            `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/tail${query ? `?${query}` : ''}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data
    }

    // ===== Project API methods =====

    async getProjects(sessionId: string): Promise<Project[]> {
        const params = new URLSearchParams({ sessionId })
        const response = await axios.get(
            `${configuration.serverUrl}/cli/projects?${params}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data.projects
    }

    async addProject(sessionId: string, opts: {
        name?: string
        path: string
        description?: string
    }): Promise<Project> {
        const params = new URLSearchParams({ sessionId })
        const payload: Record<string, string | undefined> = {
            path: opts.path,
            description: opts.description,
        }
        if (opts.name) payload.name = opts.name
        const response = await axios.post(
            `${configuration.serverUrl}/cli/projects?${params}`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data.project
    }

    async updateProject(sessionId: string, id: string, opts: {
        name?: string
        path?: string
        description?: string
    }): Promise<Project> {
        const params = new URLSearchParams({ sessionId })
        const payload: Record<string, string | null | undefined> = {}
        if (opts.name !== undefined) payload.name = opts.name
        if (opts.path !== undefined) payload.path = opts.path
        if (opts.description !== undefined) payload.description = opts.description
        const response = await axios.put(
            `${configuration.serverUrl}/cli/projects/${encodeURIComponent(id)}?${params}`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data.project
    }

    async removeProject(sessionId: string, id: string): Promise<boolean> {
        const params = new URLSearchParams({ sessionId })
        const response = await axios.delete(
            `${configuration.serverUrl}/cli/projects/${encodeURIComponent(id)}?${params}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data.ok === true
    }

    async listMachines(): Promise<Array<{
        id: string
        active: boolean
        activeAt: number
        createdAt: number
        updatedAt: number
        metadata: MachineMetadata | null
        daemonState: DaemonState | null
        supportedAgents: string[] | null
    }>> {
        const response = await axios.get(
            `${configuration.serverUrl}/cli/machines`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data.machines
    }

    async pushDownloadFile(sessionId: string, opts: {
        filename: string
        content: string   // base64
        mimeType: string
    }): Promise<{ id: string; filename: string; size: number }> {
        const response = await axios.post(
            `${configuration.serverUrl}/cli/files`,
            { sessionId, filename: opts.filename, content: opts.content, mimeType: opts.mimeType },
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30_000
            }
        )
        return response.data
    }

    async getFeishuChatMessages(chatId: string, limit?: number, before?: number): Promise<Array<{
        messageId: string
        senderOpenId: string
        senderName: string
        messageType: string
        content: string
        createdAt: number
    }>> {
        const params = new URLSearchParams({ chatId })
        if (limit) params.set('limit', String(limit))
        if (before) params.set('before', String(before))

        const response = await axios.get(
            `${configuration.serverUrl}/cli/feishu/chat-messages?${params}`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15_000
            }
        )
        return response.data.messages
    }

}

function isRetryableSendMessageError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
        return true
    }

    if (!error.response) {
        return true
    }

    const status = error.response.status
    return status >= 500
}

function ulid(): string {
    const timePart = encodeUlidTime(Date.now())
    const randomPart = encodeUlidRandom(randomBytes(10))
    return `${timePart}${randomPart}`
}

function encodeUlidTime(timeMs: number): string {
    let value = BigInt(Math.max(0, Math.floor(timeMs)))
    const chars = new Array<string>(10)
    for (let index = 9; index >= 0; index -= 1) {
        chars[index] = ULID_ALPHABET[Number(value % 32n)]
        value /= 32n
    }
    return chars.join('')
}

function encodeUlidRandom(bytes: Uint8Array): string {
    let value = 0n
    for (const byte of bytes) {
        value = (value << 8n) | BigInt(byte)
    }

    const chars = new Array<string>(16)
    for (let index = 15; index >= 0; index -= 1) {
        chars[index] = ULID_ALPHABET[Number(value % 32n)]
        value /= 32n
    }
    return chars.join('')
}
