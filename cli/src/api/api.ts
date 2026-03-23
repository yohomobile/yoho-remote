import axios from 'axios'
import type { AgentState, ClaudeAccount, CliMessagesResponse, CreateMachineResponse, CreateSessionResponse, DaemonState, Machine, MachineMetadata, Metadata, Session } from '@/api/types'
import { ActiveAccountResponseSchema, SelectBestAccountResponseSchema, AgentStateSchema, CliMessagesResponseSchema, CreateMachineResponseSchema, CreateSessionResponseSchema, DaemonStateSchema, MachineMetadataSchema, MetadataSchema } from '@/api/types'
import { configuration } from '@/configuration'
import { getAuthToken } from '@/api/auth'
import { ApiMachineClient } from './apiMachine'
import { ApiSessionClient } from './apiSession'

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
        // Retry up to 3 times with exponential backoff for transient failures
        let lastError: Error | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await axios.post(
                    `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(sessionId)}/messages`,
                    { text, sentFrom },
                    {
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 30_000
                    }
                )
                return
            } catch (e: any) {
                lastError = e
                // Don't retry on 4xx client errors (except 408/429)
                const status = e?.response?.status
                if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
                    throw e
                }
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, (attempt + 1) * 1000))
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
        source?: string
        mainSessionId?: string
    }): Promise<{ type: 'success'; sessionId: string; logs?: unknown[] } | { type: 'error'; message: string; logs?: unknown[] }> {
        const response = await axios.post(
            `${configuration.serverUrl}/cli/brain/spawn`,
            {
                machineId: opts.machineId,
                directory: opts.directory,
                agent: opts.agent ?? 'claude',
                source: opts.source ?? 'brain-child',
                mainSessionId: opts.mainSessionId,
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

    async getSessionStatus(sessionId: string): Promise<{
        active: boolean
        thinking: boolean
        messageCount: number
        lastUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null
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

    /**
     * 获取当前活跃的 Claude 账号
     * 如果没有配置多账号，返回 null
     */
    async getActiveClaudeAccount(): Promise<ClaudeAccount | null> {
        try {
            const response = await axios.get(
                `${configuration.serverUrl}/cli/claude-accounts/active`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 10_000
                }
            )

            const parsed = ActiveAccountResponseSchema.safeParse(response.data)
            if (!parsed.success) {
                return null
            }

            return parsed.data.account
        } catch (error) {
            // 如果 API 不存在或出错，返回 null（使用默认配置）
            return null
        }
    }

    /**
     * 智能选择最优 Claude 账号（负载平衡）
     * 基于所有账号的实时 usage 数据选择最空闲的账号
     * 如果 select-best 端点不存在（旧版 server），fallback 到 getActiveClaudeAccount
     */
    async selectBestClaudeAccount(): Promise<ClaudeAccount | null> {
        try {
            const response = await axios.get(
                `${configuration.serverUrl}/cli/claude-accounts/select-best`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 15_000
                }
            )

            const parsed = SelectBestAccountResponseSchema.safeParse(response.data)
            if (!parsed.success) {
                return this.getActiveClaudeAccount()
            }

            return parsed.data.account
        } catch (error) {
            // fallback: 如果 select-best 端点不存在，使用旧的 active 端点
            return this.getActiveClaudeAccount()
        }
    }
}
