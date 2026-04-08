export type PermissionMode = 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
export type SpawnAgentType = 'claude' | 'codex' | 'droid'
export type CodexModelMode = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.2' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini'
export type GrokModelMode = 'grok-4-1-fast-reasoning' | 'grok-4-1-fast-non-reasoning' | 'grok-code-fast-1' | 'grok-4-fast-reasoning' | 'grok-4-fast-non-reasoning' | 'grok-4-0709' | 'grok-3-mini' | 'grok-3'
export type ModelMode = 'sonnet' | 'opus' | 'glm-5.1' | CodexModelMode | GrokModelMode
export type ModelReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type WorktreeMetadata = {
    basePath: string
    branch: string
    name: string
    worktreePath?: string
    createdAt?: number
}

export type SessionMetadataSummary = {
    path: string
    host: string
    version?: string
    name?: string
    os?: string
    summary?: { text: string; updatedAt: number }
    machineId?: string
    mainSessionId?: string
    tools?: string[]
    flavor?: string | null
    runtimeModel?: string
    runtimeModelReasoningEffort?: ModelReasoningEffort
    worktree?: WorktreeMetadata
    source?: string
}

export type AgentStateRequest = {
    tool: string
    arguments: unknown
    createdAt?: number | null
}

export type AgentStateCompletedRequest = {
    tool: string
    arguments: unknown
    createdAt?: number | null
    completedAt?: number | null
    status: 'canceled' | 'denied' | 'approved'
    reason?: string
    mode?: string
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    allowTools?: string[]
    answers?: Record<string, string[]>
}

export type AgentState = {
    controlledByUser?: boolean | null
    requests?: Record<string, AgentStateRequest> | null
    completedRequests?: Record<string, AgentStateCompletedRequest> | null
}

export type TodoItem = {
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    priority: 'high' | 'medium' | 'low'
    id: string
}

export type Session = {
    id: string
    createdAt: number
    updatedAt: number
    active: boolean
    thinking: boolean
    createdBy?: string
    metadata: SessionMetadataSummary | null
    agentState: AgentState | null
    todos?: TodoItem[]
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
    fastMode?: boolean
}

export type ResumeSessionResponse = {
    type: 'already-active' | 'resumed' | 'created'
    sessionId: string
    resumedFrom?: string
    usedResume?: boolean
}

export type SessionSummaryMetadata = {
    name?: string
    path: string
    machineId?: string
    mainSessionId?: string
    summary?: { text: string }
    flavor?: string | null
    runtimeAgent?: string
    runtimeModel?: string
    runtimeModelReasoningEffort?: ModelReasoningEffort
    worktree?: WorktreeMetadata
    source?: string
    privacyMode?: boolean  // true = 私密模式，不分享给其他人
}

export type SessionViewer = {
    email: string
    clientId: string
    deviceType?: string
}

export type OnlineUser = {
    email: string
    clientId: string
    deviceType?: string
    sessionId: string | null
}

export type UserRole = 'developer' | 'operator'

export type Project = {
    id: string
    name: string
    path: string
    description: string | null
    machineId: string | null  // 兼容旧数据，组织共享项目固定为 null
    createdAt: number
    updatedAt: number
}

export type ProjectsResponse = { projects: Project[] }
export type AddProjectResponse = { ok: true; project: Project; projects: Project[] }
export type UpdateProjectResponse = { ok: true; project: Project; projects: Project[] }
export type RemoveProjectResponse = { ok: true; projects: Project[] }

export type RolePrompt = {
    role: UserRole
    prompt: string
    updatedAt: number
}

export type RolePromptsResponse = { prompts: RolePrompt[] }
export type SetRolePromptResponse = { ok: true; prompts: RolePrompt[] }

export type SessionSummary = {
    id: string
    active: boolean
    activeAt: number
    updatedAt: number
    createdBy?: string
    ownerEmail?: string  // 当 session 来自其他用户（开启了 shareAllSessions）时显示
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    thinking: boolean
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
    fastMode?: boolean
    viewers?: SessionViewer[]
}

export type MessageStatus = 'sending' | 'sent' | 'failed'

export type DecryptedMessage = {
    id: string
    seq: number | null
    localId: string | null
    content: unknown
    createdAt: number
    status?: MessageStatus
    originalText?: string
}

export type Machine = {
    id: string
    active: boolean
    activeAt: number
    createdAt: number
    updatedAt: number
    metadata: {
        host: string
        platform: string
        yohoRemoteCliVersion: string
        displayName?: string
        arch?: string | null
        ip?: string | null
        publicIp?: string | null
        user?: string | null
        shell?: string | null
        homeDir?: string
        yohoRemoteHomeDir?: string
        yohoRemoteLibDir?: string
        serverUrl?: string
        cwd?: string
    } | null
    daemonState: {
        status?: string
        pid?: number
        httpPort?: number
        startedAt?: number
        shutdownRequestedAt?: number
        shutdownSource?: string
    } | null
}

export type AuthResponse = {
    token: string
    user: {
        id: number
        username?: string
        firstName?: string
        lastName?: string
    }
}

export type SessionsResponse = { sessions: SessionSummary[] }
export type SessionResponse = { session: Session }
export type DeleteSessionResponse = { ok: true }

// 用户设置类型
export type UserPreferences = {
    shareAllSessions: boolean
    viewOthersSessions: boolean
}
export type UserPreferencesResponse = UserPreferences
export type UpdateUserPreferencesResponse = { ok: true; shareAllSessions: boolean; viewOthersSessions: boolean }

// Session Shares 类型
export type SessionShare = {
    sessionId: string
    sharedWithEmail: string
    sharedByEmail: string
    createdAt: number
}

export type SessionSharesResponse = { shares: SessionShare[] }
export type AddSessionShareResponse = { ok: true }
export type RemoveSessionShareResponse = { ok: true }
export type AllowedUsersResponse = { users: { email: string; role: string }[] }

// Session Privacy Mode 类型
export type SessionPrivacyModeResponse = { privacyMode: boolean }
export type UpdateSessionPrivacyModeResponse = { ok: true; privacyMode: boolean }
export type MessageCountResponse = { count: number }
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        beforeSeq: number | null
        nextBeforeSeq: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }
export type MachinePathsExistsResponse = { exists: Record<string, boolean> }

export type SpawnLogEntry = {
    timestamp: number
    step: string
    message: string
    status: 'pending' | 'running' | 'success' | 'error'
}

export type SpawnResponse =
    | { type: 'success'; sessionId: string; logs?: SpawnLogEntry[] }
    | { type: 'error'; message: string; logs?: SpawnLogEntry[] }

export type GitCommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type ImageUploadResponse = {
    success: boolean
    path?: string
    error?: string
}

export type FileUploadResponse = {
    success: boolean
    path?: string
    error?: string
}

export type GitFileStatus = {
    fileName: string
    filePath: string
    fullPath: string
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
    isStaged: boolean
    linesAdded: number
    linesRemoved: number
    oldPath?: string
}

export type GitStatusFiles = {
    stagedFiles: GitFileStatus[]
    unstagedFiles: GitFileStatus[]
    branch: string | null
    totalStaged: number
    totalUnstaged: number
}

export type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user'
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}

export type SpeechToTextStreamRequest = {
    streamId: string
    sequenceId: number
    action: 'start' | 'continue' | 'stop' | 'cancel'
    speech: string
    format?: string
    engineType?: string
}

export type SpeechToTextStreamResponse = {
    code?: number
    msg?: string
    data?: {
        recognition_text?: string
    }
    error?: string
    retryAfter?: number | null
}

export type TypingUser = {
    email: string
    clientId: string
    text: string
    updatedAt: number
}

export type DownloadFileInfo = {
    id: string
    filename: string
    size: number
    mimeType: string
}

export type SessionDownloadFile = {
    id: string
    sessionId: string
    orgId: string | null
    filename: string
    mimeType: string
    size: number
    createdAt: number
}

export type SyncEvent =
    | { type: 'session-added'; sessionId: string; data?: unknown; namespace?: string }
    | { type: 'session-updated'; sessionId: string; data?: unknown; namespace?: string }
    | { type: 'session-removed'; sessionId: string; namespace?: string }
    | { type: 'message-received'; sessionId: string; message: DecryptedMessage; namespace?: string }
    | { type: 'messages-cleared'; sessionId: string; namespace?: string }
    | { type: 'machine-updated'; machineId: string; data?: unknown; namespace?: string }
    | { type: 'connection-changed'; data?: { status: string }; namespace?: string }
    | { type: 'online-users-changed'; users: OnlineUser[]; namespace?: string }
    | { type: 'typing-changed'; sessionId: string; typing: TypingUser; namespace?: string }
    | { type: 'file-ready'; sessionId: string; fileInfo: DownloadFileInfo; namespace?: string }

export type OnlineUsersResponse = { users: OnlineUser[] }

// Organization 类型
export type OrgRole = 'owner' | 'admin' | 'member'

export type Organization = {
    id: string
    name: string
    slug: string
    createdBy: string
    createdAt: number
    updatedAt: number
    settings: Record<string, unknown>
    myRole?: OrgRole
}

export type OrgMember = {
    orgId: string
    userEmail: string
    userId: string
    role: OrgRole
    joinedAt: number
    invitedBy: string | null
}

export type OrgInvitation = {
    id: string
    orgId: string
    email: string
    role: OrgRole
    invitedBy: string
    createdAt: number
    expiresAt: number
    acceptedAt: number | null
    orgName?: string
}

export type OrgsResponse = { orgs: Organization[] }
export type OrgDetailResponse = { org: Organization; members: OrgMember[]; myRole: OrgRole }
export type CreateOrgResponse = { ok: true; org: Organization }
export type UpdateOrgResponse = { ok: true; org: Organization }
export type OrgMembersResponse = { members: OrgMember[] }
export type OrgInvitationsResponse = { invitations: OrgInvitation[] }
export type PendingInvitationsResponse = { invitations: OrgInvitation[] }
export type OrgActionResponse = { ok: true }
export type CreateInvitationResponse = { ok: true; invitation: OrgInvitation }

// CRS API Key Types
export type CRSApiKey = {
    id: string
    apiKey?: string  // 只在创建时返回
    name: string
    description?: string
    tags: string[]
    isActive: boolean
    createdAt: string
    expiresAt: string | null
    lastUsedAt: string | null
    activatedAt?: string
    // Limits
    concurrencyLimit: number
    dailyCostLimit: number
    totalCostLimit: number
    weeklyOpusCostLimit: number
    rateLimitWindow: number
    rateLimitRequests: number
    rateLimitCost: number
    // Restrictions
    enableModelRestriction: boolean
    restrictedModels: string[]
    enableClientRestriction: boolean
    allowedClients: string[]
    // Expiration
    expirationMode: 'fixed' | 'activation'
    activationDays: number
    activationUnit: 'hours' | 'days'
    isActivated: boolean
    // Account bindings
    claudeAccountId?: string
    geminiAccountId?: string
    openaiAccountId?: string
    bedrockAccountId?: string
}

export type CRSKeyStats = {
    requests: number
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
    cost: number
    formattedCost: string
}

export type CRSUsageSummary = {
    totalKeys: number
    totalRequests: number
    totalTokens: number
    totalCost: number
    formattedCost: string
    timeRange: string
}

export type CRSApiKeysResponse = {
    success: boolean
    data: {
        items: CRSApiKey[]
        pagination: {
            page: number
            pageSize: number
            totalItems: number
            totalPages: number
        }
    }
}

export type CRSBatchStatsResponse = {
    success: boolean
    data: Record<string, CRSKeyStats>
}

export type CRSUsageSummaryResponse = {
    success: boolean
    data: CRSUsageSummary
}
