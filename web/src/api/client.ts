import type {
    AddProjectResponse,
    AllowedUsersResponse,
    AIProfilesResponse,
    AuthResponse,
    CreateAIProfileInput,
    CreateAIProfileResponse,
    DeleteSessionResponse,
    DeleteAIProfileResponse,
    FileReadResponse,
    FileUploadResponse,
    GitCommandResponse,
    ImageUploadResponse,
    MachinePathsExistsResponse,
    MachinesResponse,
    MessageCountResponse,
    MessagesResponse,
    OnlineUsersResponse,
    ProjectsResponse,
    RefreshAccountResponse,
    RemoveProjectResponse,
    ResumeSessionResponse,
    RolePromptsResponse,
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
    UpdateMachineResponse,
    UpdateAIProfileInput,
    UpdateAIProfileResponse,
    UpdateProjectResponse,
    UpdateUserPreferencesResponse,
    UserPreferencesResponse,
    IdentityCandidateDecision,
    IdentityCandidateDecisionResponse,
    IdentityCandidateStatus,
    IdentityCandidatesResponse,
    IdentityPersonsResponse,
    IdentityPersonDetailResponse,
    IdentityAuditsResponse,
    IdentityMergeResponse,
    IdentityUnmergeResponse,
    IdentityDetachResponse,
    CommunicationPlanPreferences,
    CommunicationPlanResponse,
    CommunicationPlanUpdateResponse,
    CommunicationPlanAuditsResponse,
    TeamMemoryCandidatesResponse,
    TeamMemoryCandidateResponse,
    TeamMemoryCandidateDecision,
    TeamMemoryCandidateStatus,
    TeamMemoryDecisionResponse,
    TeamMemoryAuditsResponse,
    ObservationCandidatesResponse,
    ObservationCandidateResponse,
    ObservationCandidateStatus,
    ObservationDecision,
    ObservationDecisionResponse,
    ObservationAuditsResponse,
    ApprovalsResponse,
    ApprovalDetailResponse,
    ApprovalAuditsResponse,
    ApprovalDecisionResponse,
    ApprovalMasterStatus,
    OrgsResponse,
    OrgDetailResponse,
    CreateOrgResponse,
    UpdateOrgResponse,
    OrgMembersResponse,
    OrgInvitationsResponse,
    PendingInvitationsResponse,
    OrgActionResponse,
    CreateInvitationResponse,
    AcceptInvitationResponse,
    BrainConfigResponse,
    UpdateBrainConfigResponse,
    UserSelfSystemConfigResponse,
    UpdateUserSelfSystemConfigInput,
    UpdateUserSelfSystemConfigResponse,
    BrainAgent,
    CreateTokenSourceInput,
    CreateTokenSourceResponse,
    DeleteTokenSourceResponse,
    MeResponse,
    SetLocalTokenSourceEnabledResponse,
    TokenSourcesResponse,
    UpdateTokenSourceInput,
    UpdateTokenSourceResponse,
    AdminLicensesResponse,
    LicenseOrganizationsResponse,
    UpsertLicenseResponse,
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

    async getSessions(orgId?: string | null): Promise<SessionsResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<SessionsResponse>(`/api/sessions${qs}`)
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

    async getMe(): Promise<MeResponse> {
        return await this.request<MeResponse>('/api/settings/me')
    }

    async getUserPreferences(): Promise<UserPreferencesResponse> {
        return await this.request<UserPreferencesResponse>('/api/settings/user-preferences')
    }

    async updateUserPreferences(preferences: { shareAllSessions?: boolean; viewOthersSessions?: boolean }): Promise<UpdateUserPreferencesResponse> {
        return await this.request<UpdateUserPreferencesResponse>('/api/settings/user-preferences', {
            method: 'PUT',
            body: JSON.stringify(preferences)
        })
    }

    // ========== Identity Graph ==========

    // Candidate endpoints are gone — use unified Approvals Engine
    // (getApprovals / decideApproval) instead.

    async searchIdentityPersons(orgId?: string | null, q?: string | null, limit = 20): Promise<IdentityPersonsResponse> {
        const params = new URLSearchParams()
        if (orgId) params.set('orgId', orgId)
        if (q?.trim()) params.set('q', q.trim())
        params.set('limit', String(limit))
        return await this.request<IdentityPersonsResponse>(`/api/identity/persons?${params.toString()}`)
    }

    async getIdentityPersonDetail(personId: string, orgId?: string | null): Promise<IdentityPersonDetailResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<IdentityPersonDetailResponse>(`/api/identity/persons/${encodeURIComponent(personId)}${qs}`)
    }

    async getIdentityAuditLog(options: {
        orgId?: string | null
        personId?: string | null
        identityId?: string | null
        limit?: number
    } = {}): Promise<IdentityAuditsResponse> {
        const params = new URLSearchParams()
        if (options.orgId) params.set('orgId', options.orgId)
        if (options.personId) params.set('personId', options.personId)
        if (options.identityId) params.set('identityId', options.identityId)
        if (options.limit) params.set('limit', String(options.limit))
        const qs = params.toString()
        return await this.request<IdentityAuditsResponse>(`/api/identity/audits${qs ? `?${qs}` : ''}`)
    }

    async mergeIdentityPersons(sourcePersonId: string, targetPersonId: string, reason?: string | null, orgId?: string | null): Promise<IdentityMergeResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<IdentityMergeResponse>(`/api/identity/persons/${encodeURIComponent(sourcePersonId)}/merge${qs}`, {
            method: 'POST',
            body: JSON.stringify({ targetPersonId, reason: reason ?? undefined })
        })
    }

    async unmergeIdentityPerson(personId: string, reason?: string | null, orgId?: string | null): Promise<IdentityUnmergeResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<IdentityUnmergeResponse>(`/api/identity/persons/${encodeURIComponent(personId)}/unmerge${qs}`, {
            method: 'POST',
            body: JSON.stringify({ reason: reason ?? undefined })
        })
    }

    async detachIdentityLink(linkId: string, reason?: string | null, orgId?: string | null): Promise<IdentityDetachResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<IdentityDetachResponse>(`/api/identity/links/${encodeURIComponent(linkId)}/detach${qs}`, {
            method: 'POST',
            body: JSON.stringify({ reason: reason ?? undefined })
        })
    }

    // ========== Communication Plan (Phase 3A) ==========

    async getMyCommunicationPlan(orgId?: string | null): Promise<CommunicationPlanResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<CommunicationPlanResponse>(`/api/communication-plans/me${qs}`)
    }

    async updateMyCommunicationPlan(input: {
        preferences: CommunicationPlanPreferences
        enabled?: boolean
        reason?: string | null
    }, orgId?: string | null): Promise<CommunicationPlanUpdateResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<CommunicationPlanUpdateResponse>(`/api/communication-plans/me${qs}`, {
            method: 'PUT',
            body: JSON.stringify(input)
        })
    }

    async setMyCommunicationPlanEnabled(enabled: boolean, reason?: string | null, orgId?: string | null): Promise<CommunicationPlanUpdateResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<CommunicationPlanUpdateResponse>(`/api/communication-plans/me/enabled${qs}`, {
            method: 'POST',
            body: JSON.stringify({ enabled, reason: reason ?? undefined })
        })
    }

    async getMyCommunicationPlanAudits(options: { orgId?: string | null; limit?: number } = {}): Promise<CommunicationPlanAuditsResponse> {
        const params = new URLSearchParams()
        if (options.orgId) params.set('orgId', options.orgId)
        if (options.limit) params.set('limit', String(options.limit))
        const qs = params.toString()
        return await this.request<CommunicationPlanAuditsResponse>(`/api/communication-plans/me/audits${qs ? `?${qs}` : ''}`)
    }

    // ========== Team Memory (Phase 3B) ==========

    async getTeamMemoryCandidates(options: {
        orgId: string
        status?: TeamMemoryCandidateStatus
        limit?: number
    }): Promise<TeamMemoryCandidatesResponse> {
        const params = new URLSearchParams()
        params.set('orgId', options.orgId)
        if (options.status) params.set('status', options.status)
        if (options.limit) params.set('limit', String(options.limit))
        return await this.request<TeamMemoryCandidatesResponse>(`/api/team-memory/candidates?${params.toString()}`)
    }

    async getTeamMemoryCandidate(id: string, orgId: string): Promise<TeamMemoryCandidateResponse> {
        const qs = `?orgId=${encodeURIComponent(orgId)}`
        return await this.request<TeamMemoryCandidateResponse>(`/api/team-memory/candidates/${encodeURIComponent(id)}${qs}`)
    }

    async proposeTeamMemoryCandidate(input: {
        orgId: string
        content: string
        source?: string | null
        sessionId?: string | null
    }): Promise<TeamMemoryCandidateResponse> {
        const qs = `?orgId=${encodeURIComponent(input.orgId)}`
        return await this.request<TeamMemoryCandidateResponse>(`/api/team-memory/candidates${qs}`, {
            method: 'POST',
            body: JSON.stringify({
                content: input.content,
                source: input.source ?? undefined,
                sessionId: input.sessionId ?? undefined,
            }),
        })
    }

    async decideTeamMemoryCandidate(id: string, decision: TeamMemoryCandidateDecision, orgId: string): Promise<TeamMemoryDecisionResponse> {
        const qs = `?orgId=${encodeURIComponent(orgId)}`
        return await this.request<TeamMemoryDecisionResponse>(`/api/team-memory/candidates/${encodeURIComponent(id)}/decide${qs}`, {
            method: 'POST',
            body: JSON.stringify(decision),
        })
    }

    async getTeamMemoryCandidateAudits(id: string, orgId: string, limit = 50): Promise<TeamMemoryAuditsResponse> {
        const params = new URLSearchParams()
        params.set('orgId', orgId)
        params.set('limit', String(limit))
        return await this.request<TeamMemoryAuditsResponse>(`/api/team-memory/candidates/${encodeURIComponent(id)}/audits?${params.toString()}`)
    }

    // ========== Observation Hypothesis (Phase 3F) ==========

    async getObservationCandidates(options: {
        orgId: string
        status?: ObservationCandidateStatus
        subjectEmail?: string | null
        subjectPersonId?: string | null
        limit?: number
    }): Promise<ObservationCandidatesResponse> {
        const params = new URLSearchParams()
        params.set('orgId', options.orgId)
        if (options.status) params.set('status', options.status)
        if (options.subjectEmail) params.set('subjectEmail', options.subjectEmail)
        if (options.subjectPersonId) params.set('subjectPersonId', options.subjectPersonId)
        if (options.limit) params.set('limit', String(options.limit))
        return await this.request<ObservationCandidatesResponse>(`/api/observations?${params.toString()}`)
    }

    async getObservationCandidate(id: string, orgId: string): Promise<ObservationCandidateResponse> {
        const qs = `?orgId=${encodeURIComponent(orgId)}`
        return await this.request<ObservationCandidateResponse>(`/api/observations/${encodeURIComponent(id)}${qs}`)
    }

    async decideObservationCandidate(id: string, decision: ObservationDecision, orgId: string): Promise<ObservationDecisionResponse> {
        const qs = `?orgId=${encodeURIComponent(orgId)}`
        return await this.request<ObservationDecisionResponse>(`/api/observations/${encodeURIComponent(id)}/decide${qs}`, {
            method: 'POST',
            body: JSON.stringify(decision),
        })
    }

    async getObservationCandidateAudits(id: string, orgId: string, limit = 50): Promise<ObservationAuditsResponse> {
        const params = new URLSearchParams()
        params.set('orgId', orgId)
        params.set('limit', String(limit))
        return await this.request<ObservationAuditsResponse>(`/api/observations/${encodeURIComponent(id)}/audits?${params.toString()}`)
    }

    // ========== Approvals Engine (unified) ==========

    async getApprovals(options: {
        orgId: string
        domain?: string | null
        status?: ApprovalMasterStatus | null
        subjectKey?: string | null
        limit?: number
    }): Promise<ApprovalsResponse> {
        const params = new URLSearchParams()
        params.set('orgId', options.orgId)
        if (options.domain) params.set('domain', options.domain)
        if (options.status) params.set('status', options.status)
        if (options.subjectKey) params.set('subjectKey', options.subjectKey)
        if (options.limit) params.set('limit', String(options.limit))
        return await this.request<ApprovalsResponse>(`/api/approvals?${params.toString()}`)
    }

    async getApproval(id: string, orgId: string): Promise<ApprovalDetailResponse> {
        const qs = `?orgId=${encodeURIComponent(orgId)}`
        return await this.request<ApprovalDetailResponse>(`/api/approvals/${encodeURIComponent(id)}${qs}`)
    }

    async decideApproval(
        id: string,
        action: { action: string; [key: string]: unknown },
        orgId: string,
    ): Promise<ApprovalDecisionResponse> {
        const qs = `?orgId=${encodeURIComponent(orgId)}`
        return await this.request<ApprovalDecisionResponse>(`/api/approvals/${encodeURIComponent(id)}/decide${qs}`, {
            method: 'POST',
            body: JSON.stringify(action),
        })
    }

    async getApprovalAudits(id: string, orgId: string, limit = 50): Promise<ApprovalAuditsResponse> {
        const params = new URLSearchParams()
        params.set('orgId', orgId)
        params.set('limit', String(limit))
        return await this.request<ApprovalAuditsResponse>(`/api/approvals/${encodeURIComponent(id)}/audits?${params.toString()}`)
    }

    // ========== Brain Config ==========

    async getBrainConfig(orgId?: string | null): Promise<BrainConfigResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<BrainConfigResponse>(`/api/settings/brain-config${qs}`)
    }

    async updateBrainConfig(config: {
        agent: BrainAgent
        claudeModelMode?: string
        codexModel?: string
        extra?: Record<string, unknown>
    }, orgId?: string | null): Promise<UpdateBrainConfigResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<UpdateBrainConfigResponse>(`/api/settings/brain-config${qs}`, {
            method: 'PUT',
            body: JSON.stringify(config)
        })
    }

    async getSelfSystemConfig(orgId?: string | null): Promise<UserSelfSystemConfigResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<UserSelfSystemConfigResponse>(`/api/settings/self-system${qs}`)
    }

    async updateSelfSystemConfig(
        config: UpdateUserSelfSystemConfigInput,
        orgId?: string | null,
    ): Promise<UpdateUserSelfSystemConfigResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<UpdateUserSelfSystemConfigResponse>(`/api/settings/self-system${qs}`, {
            method: 'PUT',
            body: JSON.stringify(config)
        })
    }

    async getAIProfiles(orgId?: string | null): Promise<AIProfilesResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<AIProfilesResponse>(`/api/settings/ai-profiles${qs}`)
    }

    async createAIProfile(data: CreateAIProfileInput, orgId?: string | null): Promise<CreateAIProfileResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<CreateAIProfileResponse>(`/api/settings/ai-profiles${qs}`, {
            method: 'POST',
            body: JSON.stringify(data)
        })
    }

    async updateAIProfile(id: string, data: UpdateAIProfileInput, orgId?: string | null): Promise<UpdateAIProfileResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<UpdateAIProfileResponse>(`/api/settings/ai-profiles/${encodeURIComponent(id)}${qs}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        })
    }

    async deleteAIProfile(id: string, orgId?: string | null): Promise<DeleteAIProfileResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<DeleteAIProfileResponse>(`/api/settings/ai-profiles/${encodeURIComponent(id)}${qs}`, {
            method: 'DELETE'
        })
    }

    async getTokenSources(orgId?: string | null, includeSecrets = false): Promise<TokenSourcesResponse> {
        const params = new URLSearchParams()
        if (orgId) params.set('orgId', orgId)
        if (includeSecrets) params.set('includeSecrets', '1')
        const qs = params.toString()
        return await this.request<TokenSourcesResponse>(`/api/settings/token-sources${qs ? `?${qs}` : ''}`)
    }

    async createTokenSource(data: CreateTokenSourceInput, orgId?: string | null): Promise<CreateTokenSourceResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<CreateTokenSourceResponse>(`/api/settings/token-sources${qs}`, {
            method: 'POST',
            body: JSON.stringify(data)
        })
    }

    async updateTokenSource(id: string, data: UpdateTokenSourceInput, orgId?: string | null): Promise<UpdateTokenSourceResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<UpdateTokenSourceResponse>(`/api/settings/token-sources/${encodeURIComponent(id)}${qs}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        })
    }

    async deleteTokenSource(id: string, orgId?: string | null): Promise<DeleteTokenSourceResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<DeleteTokenSourceResponse>(`/api/settings/token-sources/${encodeURIComponent(id)}${qs}`, {
            method: 'DELETE'
        })
    }

    async setLocalTokenSourceEnabled(enabled: boolean, orgId?: string | null): Promise<SetLocalTokenSourceEnabledResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<SetLocalTokenSourceEnabledResponse>(`/api/settings/token-sources/local${qs}`, {
            method: 'PUT',
            body: JSON.stringify({ enabled })
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

    async sendMessage(sessionId: string, text: string, localId?: string | null): Promise<import('@/types/api').SendMessageResponse> {
        return await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
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

    async refreshAccount(sessionId: string): Promise<RefreshAccountResponse> {
        return await this.request<RefreshAccountResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/refresh-account`, {
            method: 'POST',
            body: JSON.stringify({})
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

    async getMachines(orgId?: string | null): Promise<MachinesResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<MachinesResponse>(`/api/machines${qs}`)
    }

    async setMachineSupportedAgents(machineId: string, supportedAgents: ('claude' | 'codex')[] | null): Promise<UpdateMachineResponse> {
        return await this.request<UpdateMachineResponse>(
            `/api/machines/${encodeURIComponent(machineId)}/supported-agents`,
            {
                method: 'PUT',
                body: JSON.stringify({ supportedAgents })
            }
        )
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
        agent?: 'claude' | 'codex',
        yolo?: boolean,
        sessionType?: 'simple' | 'worktree',
        worktreeName?: string,
        tokenSourceId?: string,
        claudeSettingsType?: 'litellm' | 'claude',
        claudeAgent?: string,
        claudeModel?: 'sonnet' | 'opus' | 'opus-4-7',
        codexModel?: string,
        modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh',
        source?: string,
        orgId?: string | null
    ): Promise<SpawnResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<SpawnResponse>(`/api/machines/${encodeURIComponent(machineId)}/spawn${qs}`, {
            method: 'POST',
            body: JSON.stringify({
                directory,
                agent,
                yolo,
                sessionType,
                worktreeName,
                tokenSourceId,
                claudeSettingsType,
                claudeAgent,
                claudeModel,
                codexModel,
                modelReasoningEffort,
                source: source ?? 'webapp'
            })
        })
    }

    async createBrainSession(input?: {
        machineId?: string
        agent?: 'claude' | 'codex'
        tokenSourceId?: string
        claudeTokenSourceId?: string
        codexTokenSourceId?: string
        claudeSettingsType?: 'litellm' | 'claude'
        claudeAgent?: string
        claudeModel?: 'sonnet' | 'opus' | 'opus-4-7'
        codexModel?: string
        modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
        childClaudeModels?: ('sonnet' | 'opus' | 'opus-4-7')[]
        childCodexModels?: string[]
        orgId?: string | null
    }): Promise<SpawnResponse> {
        const qs = input?.orgId ? `?orgId=${encodeURIComponent(input.orgId)}` : ''
        return await this.request<SpawnResponse>(`/api/brain/sessions${qs}`, {
            method: 'POST',
            body: JSON.stringify({
                machineId: input?.machineId,
                agent: input?.agent,
                tokenSourceId: input?.tokenSourceId,
                claudeTokenSourceId: input?.claudeTokenSourceId,
                codexTokenSourceId: input?.codexTokenSourceId,
                claudeSettingsType: input?.claudeSettingsType,
                claudeAgent: input?.claudeAgent,
                claudeModel: input?.claudeModel,
                codexModel: input?.codexModel,
                modelReasoningEffort: input?.modelReasoningEffort,
                childClaudeModels: input?.childClaudeModels,
                childCodexModels: input?.childCodexModels,
            })
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

    async getOnlineUsers(orgId: string): Promise<OnlineUsersResponse> {
        return await this.request<OnlineUsersResponse>(`/api/online-users?orgId=${encodeURIComponent(orgId)}`)
    }

    async sendTyping(sessionId: string, text: string): Promise<void> {
        await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/typing`, {
            method: 'POST',
            body: JSON.stringify({ text })
        })
    }

    // 项目管理
    async getProjects(orgId?: string | null, machineId?: string | null): Promise<ProjectsResponse> {
        const params = new URLSearchParams()
        if (orgId) params.set('orgId', orgId)
        if (machineId) params.set('machineId', machineId)
        const qs = params.toString()
        return await this.request<ProjectsResponse>(`/api/settings/projects${qs ? `?${qs}` : ''}`)
    }

    async addProject(name: string, path: string, description?: string, orgId?: string | null, machineId?: string | null): Promise<AddProjectResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<AddProjectResponse>(`/api/settings/projects${qs}`, {
            method: 'POST',
            body: JSON.stringify({ name, path, description, machineId })
        })
    }

    async updateProject(id: string, name: string, path: string, description?: string, orgId?: string | null, machineId?: string | null): Promise<UpdateProjectResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<UpdateProjectResponse>(`/api/settings/projects/${encodeURIComponent(id)}${qs}`, {
            method: 'PUT',
            body: JSON.stringify({ name, path, description, machineId })
        })
    }

    async removeProject(id: string, orgId?: string | null): Promise<RemoveProjectResponse> {
        const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''
        return await this.request<RemoveProjectResponse>(`/api/settings/projects/${encodeURIComponent(id)}${qs}`, {
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

    // Push 通知
    async getPushVapidPublicKey(): Promise<{ publicKey: string | null }> {
        return await this.request<{ publicKey: string | null }>('/api/push/vapid-public-key')
    }

    async subscribePush(orgId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string }; clientId?: string; chatId?: string }): Promise<{ ok: boolean; subscriptionId?: number }> {
        return await this.request<{ ok: boolean; subscriptionId?: number }>(`/api/push/subscribe?orgId=${encodeURIComponent(orgId)}`, {
            method: 'POST',
            body: JSON.stringify(subscription)
        })
    }

    async unsubscribePush(orgId: string, endpoint: string): Promise<{ ok: boolean; removed: boolean }> {
        return await this.request<{ ok: boolean; removed: boolean }>(`/api/push/unsubscribe?orgId=${encodeURIComponent(orgId)}`, {
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

    // ========== Organizations ==========

    async getMyOrgs(): Promise<OrgsResponse> {
        return await this.request<OrgsResponse>('/api/orgs')
    }

    async createOrg(name: string, slug: string): Promise<CreateOrgResponse> {
        return await this.request<CreateOrgResponse>('/api/orgs', {
            method: 'POST',
            body: JSON.stringify({ name, slug })
        })
    }

    async getOrg(orgId: string): Promise<OrgDetailResponse> {
        return await this.request<OrgDetailResponse>(`/api/orgs/${encodeURIComponent(orgId)}`)
    }

    async updateOrg(orgId: string, data: { name?: string; settings?: Record<string, unknown> }): Promise<UpdateOrgResponse> {
        return await this.request<UpdateOrgResponse>(`/api/orgs/${encodeURIComponent(orgId)}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        })
    }

    async deleteOrg(orgId: string): Promise<OrgActionResponse> {
        return await this.request<OrgActionResponse>(`/api/orgs/${encodeURIComponent(orgId)}`, {
            method: 'DELETE'
        })
    }

    async getOrgMembers(orgId: string): Promise<OrgMembersResponse> {
        return await this.request<OrgMembersResponse>(`/api/orgs/${encodeURIComponent(orgId)}/members`)
    }

    async inviteOrgMember(orgId: string, email: string, role: string = 'member'): Promise<CreateInvitationResponse> {
        return await this.request<CreateInvitationResponse>(`/api/orgs/${encodeURIComponent(orgId)}/members`, {
            method: 'POST',
            body: JSON.stringify({ email, role })
        })
    }

    async updateOrgMemberRole(orgId: string, email: string, role: string): Promise<OrgActionResponse> {
        return await this.request<OrgActionResponse>(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(email)}`, {
            method: 'PATCH',
            body: JSON.stringify({ role })
        })
    }

    async removeOrgMember(orgId: string, email: string): Promise<OrgActionResponse> {
        return await this.request<OrgActionResponse>(`/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(email)}`, {
            method: 'DELETE'
        })
    }

    async getOrgInvitations(orgId: string): Promise<OrgInvitationsResponse> {
        return await this.request<OrgInvitationsResponse>(`/api/orgs/${encodeURIComponent(orgId)}/invitations`)
    }

    async deleteOrgInvitation(orgId: string, invitationId: string): Promise<OrgActionResponse> {
        return await this.request<OrgActionResponse>(`/api/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`, {
            method: 'DELETE'
        })
    }

    async getPendingInvitations(): Promise<PendingInvitationsResponse> {
        return await this.request<PendingInvitationsResponse>('/api/invitations/pending')
    }

    async acceptInvitation(invitationId: string): Promise<AcceptInvitationResponse> {
        return await this.request<AcceptInvitationResponse>(`/api/invitations/${encodeURIComponent(invitationId)}/accept`, {
            method: 'POST'
        })
    }

    async getAdminLicenses(): Promise<AdminLicensesResponse> {
        return await this.request<AdminLicensesResponse>('/api/licenses')
    }

    async getLicenseOrganizations(): Promise<LicenseOrganizationsResponse> {
        return await this.request<LicenseOrganizationsResponse>('/api/licenses/orgs')
    }

    async upsertLicense(input: {
        orgId: string
        startsAt: number
        expiresAt: number
        maxMembers: number
        maxConcurrentSessions?: number | null
        status?: 'active' | 'expired' | 'suspended'
        note?: string | null
    }): Promise<UpsertLicenseResponse> {
        return await this.request<UpsertLicenseResponse>('/api/licenses', {
            method: 'POST',
            body: JSON.stringify(input)
        })
    }

    async updateLicenseStatus(orgId: string, status: 'active' | 'expired' | 'suspended'): Promise<OrgActionResponse> {
        return await this.request<OrgActionResponse>(`/api/licenses/${encodeURIComponent(orgId)}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ status })
        })
    }

    async deleteLicense(orgId: string): Promise<OrgActionResponse> {
        return await this.request<OrgActionResponse>(`/api/licenses/${encodeURIComponent(orgId)}`, {
            method: 'DELETE'
        })
    }


    // ========== Downloads ==========

    async getSessionDownloads(sessionId: string): Promise<{ files: import('@/types/api').SessionDownloadFile[] }> {
        return await this.request<{ files: import('@/types/api').SessionDownloadFile[] }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/downloads`
        )
    }

    async clearSessionDownloads(sessionId: string): Promise<{ cleared: number }> {
        return await this.request<{ cleared: number }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/downloads`,
            { method: 'DELETE' }
        )
    }

    async downloadFile(id: string, filename: string): Promise<void> {
        const liveToken = this.getToken ? this.getToken() : null
        const authToken = liveToken ?? this.token
        const headers = new Headers()
        if (authToken) headers.set('authorization', `Bearer ${authToken}`)

        const res = await fetch(this.buildUrl(`/api/downloads/${encodeURIComponent(id)}`), { headers })
        if (!res.ok) throw new Error(`Download failed: ${res.status}`)

        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
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

    // ========== AI Task Schedules ==========

    async listAiTaskSchedules(opts?: {
        machineId?: string
        includeDisabled?: boolean
        mine?: boolean
        tag?: string
    }): Promise<import('@/types/api').AiTaskSchedulesResponse> {
        const params = new URLSearchParams()
        if (opts?.machineId) params.set('machineId', opts.machineId)
        if (opts?.includeDisabled) params.set('includeDisabled', 'true')
        if (opts?.mine) params.set('mine', 'true')
        if (opts?.tag) params.set('tag', opts.tag)
        const qs = params.toString() ? `?${params.toString()}` : ''
        return await this.request<import('@/types/api').AiTaskSchedulesResponse>(
            `/api/ai-task-schedules${qs}`
        )
    }

    async getAiTaskSchedule(id: string): Promise<import('@/types/api').AiTaskScheduleResponse> {
        return await this.request<import('@/types/api').AiTaskScheduleResponse>(
            `/api/ai-task-schedules/${encodeURIComponent(id)}`
        )
    }

    async createAiTaskSchedule(
        input: import('@/types/api').CreateAiTaskScheduleInput
    ): Promise<import('@/types/api').AiTaskScheduleMutationResponse> {
        return await this.request<import('@/types/api').AiTaskScheduleMutationResponse>(
            `/api/ai-task-schedules`,
            { method: 'POST', body: JSON.stringify(input) }
        )
    }

    async updateAiTaskSchedule(
        id: string,
        patch: import('@/types/api').UpdateAiTaskScheduleInput
    ): Promise<import('@/types/api').AiTaskScheduleMutationResponse> {
        return await this.request<import('@/types/api').AiTaskScheduleMutationResponse>(
            `/api/ai-task-schedules/${encodeURIComponent(id)}`,
            { method: 'PATCH', body: JSON.stringify(patch) }
        )
    }

    async deleteAiTaskSchedule(
        id: string
    ): Promise<import('@/types/api').AiTaskScheduleDeleteResponse> {
        return await this.request<import('@/types/api').AiTaskScheduleDeleteResponse>(
            `/api/ai-task-schedules/${encodeURIComponent(id)}`,
            { method: 'DELETE' }
        )
    }

    async takeoverSession(
        sessionId: string,
        opts?: { end?: boolean }
    ): Promise<{ ok: boolean; takeoverBy: string | null }> {
        return await this.request<{ ok: boolean; takeoverBy: string | null }>(
            `/api/sessions/${encodeURIComponent(sessionId)}/takeover`,
            {
                method: 'POST',
                body: JSON.stringify(opts?.end ? { end: true } : {}),
            }
        )
    }

}
