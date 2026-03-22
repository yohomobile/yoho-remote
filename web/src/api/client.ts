import type {
    AddInputPresetResponse,
    AddMemberResponse,
    AddProjectResponse,
    AgentGroupType,
    AllowedUsersResponse,
    AuthResponse,
    BroadcastResponse,
    CreateGroupResponse,
    DeleteGroupResponse,
    DeleteSessionResponse,
    FileReadResponse,
    FileUploadResponse,
    GitCommandResponse,
    GroupMessagesResponse,
    GroupMemberRole,
    GroupMessageType,
    GroupResponse,
    GroupSenderType,
    GroupsResponse,
    ImageUploadResponse,
    InputPresetsResponse,
    MachinePathsExistsResponse,
    MachinesResponse,
    MessageCountResponse,
    MessagesResponse,
    OnlineUsersResponse,
    ProjectsResponse,
    RemoveInputPresetResponse,
    RemoveMemberResponse,
    RemoveProjectResponse,
    ResumeSessionResponse,
    RolePromptsResponse,
    SendGroupMessageResponse,
    SessionShare,
    SessionSharesResponse,
    SessionPrivacyModeResponse,
    UpdateSessionPrivacyModeResponse,
    SetRolePromptResponse,
    SlashCommandsResponse,
    SpeechToTextStreamRequest,
    SpeechToTextStreamResponse,
    SpawnResponse,
    AddSessionShareResponse,
    RemoveSessionShareResponse,
    SessionResponse,
    SessionsResponse,
    UpdateGroupResponse,
    UpdateInputPresetResponse,
    UpdateProjectResponse,
    UpdateUserPreferencesResponse,
    UserPreferencesResponse
} from '@/types/api'

type ApiClientOptions = {
    baseUrl?: string
    getToken?: () => string | null
    onUnauthorized?: () => Promise<string | null>
    getClientId?: () => string | null
}

type ErrorPayload = {
    error?: unknown
}

function parseErrorCode(bodyText: string): string | undefined {
    try {
        const parsed = JSON.parse(bodyText) as ErrorPayload
        return typeof parsed.error === 'string' ? parsed.error : undefined
    } catch {
        return undefined
    }
}

export class ApiError extends Error {
    status: number
    code?: string
    body?: string

    constructor(message: string, status: number, code?: string, body?: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.code = code
        this.body = body
    }
}

export class ApiClient {
    private token: string
    private readonly baseUrl: string | null
    private readonly getToken: (() => string | null) | null
    private readonly onUnauthorized: (() => Promise<string | null>) | null
    private readonly getClientId: (() => string | null) | null

    constructor(token: string, options?: ApiClientOptions) {
        this.token = token
        this.baseUrl = options?.baseUrl ?? null
        this.getToken = options?.getToken ?? null
        this.onUnauthorized = options?.onUnauthorized ?? null
        this.getClientId = options?.getClientId ?? null
    }

    /** 获取当前有效的认证 token */
    public getCurrentToken(): string | null {
        return this.getToken ? this.getToken() : this.token
    }

    /** 确保 token 是新鲜的（如果过期则刷新），返回可用的 token */
    public async ensureFreshToken(): Promise<string | null> {
        const token = this.getCurrentToken()
        if (!token) return null

        // 解析 token 过期时间
        try {
            const parts = token.split('.')
            if (parts.length < 2) return token

            const payloadBase64Url = parts[1] ?? ''
            const payloadBase64 = payloadBase64Url
                .replace(/-/g, '+')
                .replace(/_/g, '/')
                .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

            const decoded = globalThis.atob(payloadBase64)
            const payload = JSON.parse(decoded) as { exp?: unknown }
            if (typeof payload.exp !== 'number') return token

            const expMs = payload.exp * 1000
            const now = Date.now()

            // 如果 token 将在 60 秒内过期，刷新它
            if (expMs - now < 60_000 && this.onUnauthorized) {
                const refreshed = await this.onUnauthorized()
                if (refreshed) {
                    this.token = refreshed
                    return refreshed
                }
            }
        } catch {
            // 解析失败，返回当前 token
        }

        return this.getCurrentToken()
    }

    private buildUrl(path: string): string {
        if (!this.baseUrl) {
            return path
        }
        try {
            return new URL(path, this.baseUrl).toString()
        } catch {
            return path
        }
    }

    private async request<T>(
        path: string,
        init?: RequestInit,
        attempt: number = 0,
        overrideToken?: string | null
    ): Promise<T> {
        const headers = new Headers(init?.headers)
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = overrideToken !== undefined
            ? (overrideToken ?? (liveToken ?? this.token))
            : (liveToken ?? this.token)
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        const clientId = this.getClientId ? this.getClientId() : null
        if (clientId && !headers.has('x-client-id')) {
            headers.set('x-client-id', clientId)
        }
        if (init?.body !== undefined && !headers.has('content-type')) {
            headers.set('content-type', 'application/json')
        }

        const res = await fetch(this.buildUrl(path), {
            ...init,
            headers
        })

        if (res.status === 401) {
            if (attempt === 0 && this.onUnauthorized) {
                const refreshed = await this.onUnauthorized()
                if (refreshed) {
                    this.token = refreshed
                    return await this.request<T>(path, init, attempt + 1, refreshed)
                }
            }
            throw new Error('Session expired. Please sign in again.')
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as T
    }

    async authenticate(auth: { initData: string } | { accessToken: string; email?: string; clientId?: string; deviceType?: string }): Promise<AuthResponse> {
        const res = await fetch(this.buildUrl('/api/auth'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Auth failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async bind(auth: { initData: string; accessToken: string }): Promise<AuthResponse> {
        const res = await fetch(this.buildUrl('/api/bind'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(auth)
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const code = parseErrorCode(body)
            const detail = body ? `: ${body}` : ''
            throw new ApiError(`Bind failed: HTTP ${res.status} ${res.statusText}${detail}`, res.status, code, body || undefined)
        }

        return await res.json() as AuthResponse
    }

    async getSessions(): Promise<SessionsResponse> {
        return await this.request<SessionsResponse>('/api/sessions')
    }

    async getSession(sessionId: string): Promise<SessionResponse> {
        return await this.request<SessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
    }

    async deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
        return await this.request<DeleteSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE'
        })
    }

    // ========== Session Shares ==========

    async getSessionShares(sessionId: string): Promise<SessionSharesResponse> {
        return await this.request<SessionSharesResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/shares`)
    }

    async addSessionShare(sessionId: string, email: string): Promise<AddSessionShareResponse> {
        return await this.request<AddSessionShareResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/shares`, {
            method: 'POST',
            body: JSON.stringify({ email })
        })
    }

    async removeSessionShare(sessionId: string, email: string): Promise<RemoveSessionShareResponse> {
        return await this.request<RemoveSessionShareResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/shares/${encodeURIComponent(email)}`, {
            method: 'DELETE'
        })
    }

    async getSessionPrivacyMode(sessionId: string): Promise<SessionPrivacyModeResponse> {
        return await this.request<SessionPrivacyModeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/privacy-mode`)
    }

    async setSessionPrivacyMode(sessionId: string, privacyMode: boolean): Promise<UpdateSessionPrivacyModeResponse> {
        return await this.request<UpdateSessionPrivacyModeResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/privacy-mode`, {
            method: 'PUT',
            body: JSON.stringify({ privacyMode })
        })
    }

    async getAllowedUsers(): Promise<AllowedUsersResponse> {
        return await this.request<AllowedUsersResponse>('/api/users/allowed')
    }

    // ========== User Preferences ==========

    async getUserPreferences(): Promise<UserPreferencesResponse> {
        return await this.request<UserPreferencesResponse>('/api/settings/user-preferences')
    }

    async updateUserPreferences(preferences: { shareAllSessions?: boolean; viewOthersSessions?: boolean }): Promise<UpdateUserPreferencesResponse> {
        return await this.request<UpdateUserPreferencesResponse>('/api/settings/user-preferences', {
            method: 'PUT',
            body: JSON.stringify(preferences)
        })
    }

    async getMessages(sessionId: string, options: { beforeSeq?: number | null; limit?: number }): Promise<MessagesResponse> {
        const params = new URLSearchParams()
        if (options.beforeSeq !== undefined && options.beforeSeq !== null) {
            params.set('beforeSeq', `${options.beforeSeq}`)
        }
        if (options.limit !== undefined && options.limit !== null) {
            params.set('limit', `${options.limit}`)
        }

        const qs = params.toString()
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`
        return await this.request<MessagesResponse>(url)
    }

    async getMessageCount(sessionId: string): Promise<MessageCountResponse> {
        return await this.request<MessageCountResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/messages/count`
        )
    }

    async streamSpeechToText(payload: SpeechToTextStreamRequest): Promise<SpeechToTextStreamResponse> {
        const headers = new Headers()
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = liveToken ?? this.token
        if (authToken) {
            headers.set('authorization', `Bearer ${authToken}`)
        }
        headers.set('content-type', 'application/json')

        const res = await fetch(this.buildUrl('/api/speech-to-text/stream'), {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
        })

        const text = await res.text().catch(() => '')
        let data: SpeechToTextStreamResponse = {}
        if (text) {
            try {
                data = JSON.parse(text) as SpeechToTextStreamResponse
            } catch {
                data = { error: text }
            }
        }

        if (!res.ok && !data.error) {
            data.error = `HTTP ${res.status} ${res.statusText}`
        }

        return data
    }

    async getGitStatus(sessionId: string): Promise<GitCommandResponse> {
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-status`)
    }

    async getGitDiffNumstat(sessionId: string, staged: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('staged', staged ? 'true' : 'false')
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-numstat?${params.toString()}`)
    }

    async getGitDiffFile(sessionId: string, path: string, staged?: boolean): Promise<GitCommandResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        if (staged !== undefined) {
            params.set('staged', staged ? 'true' : 'false')
        }
        return await this.request<GitCommandResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/git-diff-file?${params.toString()}`)
    }

    async readSessionFile(sessionId: string, path: string): Promise<FileReadResponse> {
        const params = new URLSearchParams()
        params.set('path', path)
        return await this.request<FileReadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/file?${params.toString()}`)
    }

    async searchSessionFiles(sessionId: string, query: string, limit?: number): Promise<{
        success: boolean
        files?: Array<{
            fileName: string
            filePath: string
            fullPath: string
            fileType: 'file' | 'folder'
        }>
        error?: string
    }> {
        const params = new URLSearchParams()
        if (query) {
            params.set('query', query)
        }
        if (limit !== undefined) {
            params.set('limit', String(limit))
        }
        const qs = params.toString()
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs ? `?${qs}` : ''}`)
    }

    async uploadImage(sessionId: string, filename: string, content: string, mimeType: string): Promise<ImageUploadResponse> {
        return await this.request<ImageUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload-image`, {
            method: 'POST',
            body: JSON.stringify({ filename, content, mimeType })
        })
    }

    async uploadFile(sessionId: string, filename: string, content: string, mimeType: string): Promise<FileUploadResponse> {
        return await this.request<FileUploadResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/upload-file`, {
            method: 'POST',
            body: JSON.stringify({ filename, content, mimeType })
        })
    }

    /** 复制绝对路径文件到服务器存储，返回下载路径 */
    async copyFile(sessionId: string, absolutePath: string): Promise<{ success: boolean; path?: string; filename?: string; error?: string }> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/copy-file`, {
            method: 'POST',
            body: JSON.stringify({ path: absolutePath })
        })
    }

    /** 检查文件是否存在（支持相对路径，会自动转换为绝对路径） */
    async checkFile(sessionId: string, path: string): Promise<{ exists: boolean; absolutePath?: string; error?: string }> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/check-file`, {
            method: 'POST',
            body: JSON.stringify({ path })
        })
    }

    /** 批量检查文件是否存在 */
    async checkFiles(sessionId: string, paths: string[]): Promise<Record<string, { exists: boolean; absolutePath?: string }>> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/check-files`, {
            method: 'POST',
            body: JSON.stringify({ paths })
        })
    }

    async sendMessage(sessionId: string, text: string, localId?: string | null): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
            method: 'POST',
            body: JSON.stringify({ text, localId: localId ?? undefined })
        })
    }

    async abortSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async switchSession(sessionId: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/switch`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async resumeSession(sessionId: string): Promise<ResumeSessionResponse> {
        return await this.request<ResumeSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async refreshAccount(sessionId: string): Promise<{ type: 'success'; sessionId: string; usedResume?: boolean; resumeVerified?: boolean; resumeMismatchSessionId?: string | null }> {
        return await this.request<{ type: 'success'; sessionId: string; usedResume?: boolean; resumeVerified?: boolean; resumeMismatchSessionId?: string | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/refresh-account`, {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async setPermissionMode(sessionId: string, mode: 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        })
    }

    async setModelMode(sessionId: string, payload: { model: string; reasoningEffort?: string | null }): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
            method: 'POST',
            body: JSON.stringify(payload)
        })
    }

    async setFastMode(sessionId: string, fastMode: boolean): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/fast-mode`, {
            method: 'POST',
            body: JSON.stringify({ fastMode })
        })
    }

    async approvePermission(
        sessionId: string,
        requestId: string,
        modeOrOptions?: 'bypassPermissions' | {
            mode?: 'bypassPermissions'
            allowTools?: string[]
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
            answers?: Record<string, string[]>
        }
    ): Promise<void> {
        const body = typeof modeOrOptions === 'string' || modeOrOptions === undefined
            ? { mode: modeOrOptions }
            : modeOrOptions
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/approve`, {
            method: 'POST',
            body: JSON.stringify(body)
        })
    }

    async denyPermission(
        sessionId: string,
        requestId: string,
        options?: {
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
        }
    ): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/deny`, {
            method: 'POST',
            body: JSON.stringify(options ?? {})
        })
    }

    async getMachines(): Promise<MachinesResponse> {
        return await this.request<MachinesResponse>('/api/machines')
    }

    async checkMachinePathsExists(
        machineId: string,
        paths: string[]
    ): Promise<MachinePathsExistsResponse> {
        return await this.request<MachinePathsExistsResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/paths/exists`,
            {
                method: 'POST',
                body: JSON.stringify({ paths })
            }
        )
    }

    async spawnSession(
        machineId: string,
        directory: string,
        agent?: 'claude' | 'codex' | 'opencode',
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        claudeSettingsType?: 'litellm' | 'claude',
        claudeAgent?: string,
        opencodeModel?: string,
        codexModel?: string,
        modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    ): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn`, {
            method: 'POST',
            body: JSON.stringify({ directory, agent, yolo, sessionType, worktreeName, claudeSettingsType, claudeAgent, opencodeModel, codexModel, modelReasoningEffort, source: 'webapp' })
        })
    }

    async createBrainSession(): Promise<SpawnResponse> {
        return await this.request<SpawnResponse>('/api/brain/sessions', {
            method: 'POST',
            body: JSON.stringify({})
        })
    }

    async getSlashCommands(sessionId: string): Promise<SlashCommandsResponse> {
        return await this.request<SlashCommandsResponse>(
            `/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`
        )
    }

    async optimizeText(text: string): Promise<{ optimized: string }> {
        return await this.request<{ optimized: string }>('/api/optimize', {
            method: 'POST',
            body: JSON.stringify({ text })
        })
    }

    async getOnlineUsers(): Promise<OnlineUsersResponse> {
        return await this.request<OnlineUsersResponse>('/api/online-users')
    }

    async sendTyping(sessionId: string, text: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/typing`, {
            method: 'POST',
            body: JSON.stringify({ text })
        })
    }

    // 项目管理
    async getProjects(machineId?: string | null): Promise<ProjectsResponse> {
        const url = machineId !== undefined
            ? `/api/settings/projects?machineId=${encodeURIComponent(machineId)}`
            : '/api/settings/projects'
        return await this.request<ProjectsResponse>(url)
    }

    async addProject(name: string, path: string, description?: string, machineId?: string | null): Promise<AddProjectResponse> {
        return await this.request<AddProjectResponse>('/api/settings/projects', {
            method: 'POST',
            body: JSON.stringify({ name, path, description, machineId })
        })
    }

    async updateProject(id: string, name: string, path: string, description?: string, machineId?: string | null): Promise<UpdateProjectResponse> {
        return await this.request<UpdateProjectResponse>(`/api/settings/projects/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ name, path, description, machineId })
        })
    }

    async removeProject(id: string): Promise<RemoveProjectResponse> {
        return await this.request<RemoveProjectResponse>(`/api/settings/projects/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
    }

    // 角色预设 Prompt 管理
    async getRolePrompts(): Promise<RolePromptsResponse> {
        return await this.request<RolePromptsResponse>('/api/settings/role-prompts')
    }

    async setRolePrompt(role: 'developer' | 'operator', prompt: string): Promise<SetRolePromptResponse> {
        return await this.request<SetRolePromptResponse>(
            `/api/settings/role-prompts/${encodeURIComponent(role)}`,
            {
                method: 'PUT',
                body: JSON.stringify({ prompt })
            }
        )
    }

    async deleteRolePrompt(role: 'developer' | 'operator'): Promise<SetRolePromptResponse> {
        return await this.request<SetRolePromptResponse>(
            `/api/settings/role-prompts/${encodeURIComponent(role)}`,
            {
                method: 'DELETE'
            }
        )
    }

    // 输入预设管理
    async getInputPresets(): Promise<InputPresetsResponse> {
        return await this.request<InputPresetsResponse>('/api/settings/input-presets')
    }

    async addInputPreset(trigger: string, title: string, prompt: string): Promise<AddInputPresetResponse> {
        return await this.request<AddInputPresetResponse>('/api/settings/input-presets', {
            method: 'POST',
            body: JSON.stringify({ trigger, title, prompt })
        })
    }

    async updateInputPreset(id: string, trigger: string, title: string, prompt: string): Promise<UpdateInputPresetResponse> {
        return await this.request<UpdateInputPresetResponse>(`/api/settings/input-presets/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ trigger, title, prompt })
        })
    }

    async removeInputPreset(id: string): Promise<RemoveInputPresetResponse> {
        return await this.request<RemoveInputPresetResponse>(`/api/settings/input-presets/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
    }

    // Push 通知
    async getPushVapidPublicKey(): Promise<{ publicKey: string | null }> {
        return await this.request<{ publicKey: string | null }>('/api/push/vapid-public-key')
    }

    async subscribePush(subscription: { endpoint: string; keys: { p256dh: string; auth: string }; clientId?: string; chatId?: string }): Promise<{ ok: boolean; subscriptionId?: number }> {
        return await this.request<{ ok: boolean; subscriptionId?: number }>('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(subscription)
        })
    }

    async unsubscribePush(endpoint: string): Promise<{ ok: boolean; removed: boolean }> {
        return await this.request<{ ok: boolean; removed: boolean }>('/api/push/unsubscribe', {
            method: 'POST',
            body: JSON.stringify({ endpoint })
        })
    }

    // Usage 数据
    async getUsage(): Promise<{
        claude: {
            fiveHour: { utilization: number; resetsAt: string } | null
            sevenDay: { utilization: number; resetsAt: string } | null
            error?: string
        } | null
        codex: {
            fiveHour: { utilization: number; resetsAt: string } | null
            sevenDay: { utilization: number; resetsAt: string } | null
            tokenUsage: {
                inputTokens: number
                outputTokens: number
                cachedInputTokens: number
                reasoningOutputTokens: number
                totalTokens: number
            } | null
            error?: string
        } | null
        local: {
            today: {
                inputTokens: number
                outputTokens: number
                cacheCreationTokens: number
                cacheReadTokens: number
                totalTokens: number
                sessions: number
            }
            total: {
                inputTokens: number
                outputTokens: number
                cacheCreationTokens: number
                cacheReadTokens: number
                totalTokens: number
                sessions: number
            }
            error?: string
        } | null
        timestamp: number
    }> {
        return await this.request('/api/usage')
    }

    // 24h hourly usage analysis
    async getHourlyUsage(): Promise<{
        hourly: Array<{
            hour: string
            cacheRead: number
            cacheCreate: number
            input: number
            output: number
            messages: number
        }>
        projects: Array<{
            project: string
            cacheRead: number
            cacheCreate: number
            input: number
            output: number
            messages: number
            sessions: number
        }>
        sessions: Array<{
            sessionId: string
            project: string
            model: string
            firstSeen: string
            lastSeen: string
            cacheRead: number
            cacheCreate: number
            messages: number
            toolCalls: number
        }>
        timestamp: number
        error?: string
    }> {
        return await this.request('/api/usage/hourly')
    }

    // ==================== Session Notification Subscriptions ====================

    async getSessionSubscribers(sessionId: string): Promise<{
        sessionId: string
        creatorChatId: string | null
        subscribers: string[]
        clientIdSubscribers: string[]
        totalRecipients: number
    }> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/subscribers`)
    }

    async subscribeToSession(sessionId: string, options: { chatId?: string; clientId?: string }): Promise<{
        ok: boolean
        subscription: {
            id: number
            sessionId: string
            chatId: string | null
            clientId: string | null
            namespace: string
            subscribedAt: number
        }
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/subscribe`,
            {
                method: 'POST',
                body: JSON.stringify(options)
            }
        )
    }

    async unsubscribeFromSession(sessionId: string, options: { chatId?: string; clientId?: string }): Promise<{
        ok: boolean
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/subscribe`,
            {
                method: 'DELETE',
                body: JSON.stringify(options)
            }
        )
    }

    async setSessionCreator(sessionId: string, chatId: string): Promise<{
        ok: boolean
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/creator`,
            {
                method: 'POST',
                body: JSON.stringify({ chatId })
            }
        )
    }

    /**
     * 移除指定订阅者
     * @param sessionId - session ID
     * @param subscriberId - 订阅者 ID（chatId 或 clientId）
     * @param type - 订阅者类型，默认为 'chatId'
     */
    async removeSessionSubscriber(sessionId: string, subscriberId: string, type: 'chatId' | 'clientId' = 'chatId'): Promise<{
        ok: boolean
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/subscribers/${encodeURIComponent(subscriberId)}?type=${type}`,
            {
                method: 'DELETE'
            }
        )
    }

    /**
     * 清除所有订阅者
     * @param sessionId - session ID
     */
    async clearSessionSubscribers(sessionId: string): Promise<{
        ok: boolean
        removed: { chatIds: number; clientIds: number; creator: boolean }
    }> {
        return await this.request(
            `/api/sessions/${encodeURIComponent(sessionId)}/subscribers`,
            {
                method: 'DELETE'
            }
        )
    }

    async get<T>(path: string): Promise<{ data: T }> {
        const data = await this.request<T>(`/api${path}`)
        return { data }
    }

    async put<T>(path: string, body: unknown): Promise<{ data: T }> {
        const data = await this.request<T>(`/api${path}`, {
            method: 'PUT',
            body: JSON.stringify(body)
        })
        return { data }
    }

    // ==================== Agent Groups ====================

    async getGroups(): Promise<GroupsResponse> {
        return await this.request<GroupsResponse>('/api/groups')
    }

    async getGroup(groupId: string): Promise<GroupResponse> {
        return await this.request<GroupResponse>(`/api/groups/${encodeURIComponent(groupId)}`)
    }

    async createGroup(
        name: string,
        type: AgentGroupType = 'collaboration',
        description?: string
    ): Promise<CreateGroupResponse> {
        return await this.request<CreateGroupResponse>('/api/groups', {
            method: 'POST',
            body: JSON.stringify({ name, type, description })
        })
    }

    async updateGroupStatus(
        groupId: string,
        status: 'active' | 'paused' | 'completed'
    ): Promise<UpdateGroupResponse> {
        return await this.request<UpdateGroupResponse>(
            `/api/groups/${encodeURIComponent(groupId)}`,
            {
                method: 'PUT',
                body: JSON.stringify({ status })
            }
        )
    }

    async deleteGroup(groupId: string): Promise<DeleteGroupResponse> {
        return await this.request<DeleteGroupResponse>(
            `/api/groups/${encodeURIComponent(groupId)}`,
            { method: 'DELETE' }
        )
    }

    async addGroupMember(
        groupId: string,
        sessionId: string,
        role: GroupMemberRole = 'member',
        agentType?: string
    ): Promise<AddMemberResponse> {
        return await this.request<AddMemberResponse>(
            `/api/groups/${encodeURIComponent(groupId)}/members`,
            {
                method: 'POST',
                body: JSON.stringify({ sessionId, role, agentType })
            }
        )
    }

    async removeGroupMember(groupId: string, sessionId: string): Promise<RemoveMemberResponse> {
        return await this.request<RemoveMemberResponse>(
            `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(sessionId)}`,
            { method: 'DELETE' }
        )
    }

    async getGroupMessages(groupId: string, limit?: number, beforeId?: string): Promise<GroupMessagesResponse> {
        const params = new URLSearchParams()
        if (limit !== undefined) {
            params.set('limit', `${limit}`)
        }
        if (beforeId) {
            params.set('beforeId', beforeId)
        }
        const qs = params.toString()
        return await this.request<GroupMessagesResponse>(
            `/api/groups/${encodeURIComponent(groupId)}/messages${qs ? `?${qs}` : ''}`
        )
    }

    async sendGroupMessage(
        groupId: string,
        content: string,
        sourceSessionId?: string,
        senderType: GroupSenderType = 'user',
        messageType: GroupMessageType = 'chat'
    ): Promise<SendGroupMessageResponse> {
        return await this.request<SendGroupMessageResponse>(
            `/api/groups/${encodeURIComponent(groupId)}/messages`,
            {
                method: 'POST',
                body: JSON.stringify({ content, sourceSessionId, senderType, messageType })
            }
        )
    }

    async broadcastToGroup(
        groupId: string,
        content: string,
        sourceSessionId?: string,
        senderType: GroupSenderType = 'user',
        messageType: GroupMessageType = 'chat',
        mentions?: string[]
    ): Promise<BroadcastResponse> {
        return await this.request<BroadcastResponse>(
            `/api/groups/${encodeURIComponent(groupId)}/broadcast`,
            {
                method: 'POST',
                body: JSON.stringify({ content, sourceSessionId, senderType, messageType, mentions })
            }
        )
    }

    // ==================== Claude Accounts ====================

    async getClaudeAccountsConfig(): Promise<ClaudeAccountsConfig> {
        return await this.request<ClaudeAccountsConfig>('/api/claude-accounts')
    }

    async getActiveClaudeAccount(): Promise<{ account: ClaudeAccount | null }> {
        return await this.request<{ account: ClaudeAccount | null }>('/api/claude-accounts/active')
    }

    async addClaudeAccount(data: {
        name: string
        configDir?: string
        autoRotate?: boolean
        usageThreshold?: number
        planType?: 'pro' | 'max'
    }): Promise<{ ok: boolean; account: ClaudeAccount; config: ClaudeAccountsConfig }> {
        return await this.request('/api/claude-accounts', {
            method: 'POST',
            body: JSON.stringify(data)
        })
    }

    async updateClaudeAccount(
        id: string,
        data: { name?: string; autoRotate?: boolean; usageThreshold?: number; planType?: 'pro' | 'max' }
    ): Promise<{ ok: boolean; account: ClaudeAccount; config: ClaudeAccountsConfig }> {
        return await this.request(`/api/claude-accounts/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        })
    }

    async removeClaudeAccount(id: string): Promise<{ ok: boolean; config: ClaudeAccountsConfig }> {
        return await this.request(`/api/claude-accounts/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        })
    }

    async activateClaudeAccount(id: string): Promise<{ ok: boolean; config: ClaudeAccountsConfig }> {
        return await this.request(`/api/claude-accounts/${encodeURIComponent(id)}/activate`, {
            method: 'POST'
        })
    }

    async updateClaudeAccountsGlobalConfig(data: {
        autoRotateEnabled?: boolean
        defaultThreshold?: number
    }): Promise<{ ok: boolean; config: ClaudeAccountsConfig }> {
        return await this.request('/api/claude-accounts/config', {
            method: 'PUT',
            body: JSON.stringify(data)
        })
    }

    async getClaudeAccountSetupGuide(id?: string): Promise<{
        steps: Array<{ step: number; title: string; command?: string; description: string }>
        configDir: string
        suggestedId: string
    }> {
        const params = id ? `?id=${encodeURIComponent(id)}` : ''
        return await this.request(`/api/claude-accounts/setup-guide${params}`)
    }

    async migrateDefaultClaudeAccount(): Promise<{
        ok: boolean
        account?: ClaudeAccount
        config?: ClaudeAccountsConfig
        message?: string
    }> {
        return await this.request('/api/claude-accounts/migrate', {
            method: 'POST'
        })
    }

    async getClaudeAccountsUsage(): Promise<{
        accounts: Array<{
            accountId: string
            accountName: string
            configDir: string
            isActive: boolean
            planType?: 'pro' | 'max'
            fiveHour: { utilization: number; resetsAt: string } | null
            sevenDay: { utilization: number; resetsAt: string } | null
            error?: string
        }>
        timestamp: number
    }> {
        return await this.request('/api/claude-accounts/usage')
    }

}

// Types for Claude Accounts
export interface ClaudeAccountUsage {
    usedTokens: number
    totalTokens: number
    percentage: number
    updatedAt: number
}

export interface ClaudeAccount {
    id: string
    name: string
    configDir: string
    isActive: boolean
    autoRotate: boolean
    usageThreshold: number
    planType?: 'pro' | 'max'
    lastUsage?: ClaudeAccountUsage
    createdAt: number
    lastActiveAt?: number
}

export interface ClaudeAccountsConfig {
    accounts: ClaudeAccount[]
    activeAccountId: string
    autoRotateEnabled: boolean
    defaultThreshold: number
}
