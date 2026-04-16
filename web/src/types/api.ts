export type PermissionMode = 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
export type SpawnAgentType = 'claude' | 'codex'
export type ClaudeModelMode = 'default' | 'sonnet' | 'opus'
export type CodexModelMode = 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.2' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini'
export type GrokModelMode = 'grok-4-1-fast-reasoning' | 'grok-4-1-fast-non-reasoning' | 'grok-code-fast-1' | 'grok-4-fast-reasoning' | 'grok-4-fast-non-reasoning' | 'grok-4-0709' | 'grok-3-mini' | 'grok-3'
export type ModelMode = ClaudeModelMode | 'glm-5.1' | CodexModelMode | GrokModelMode
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
    runtimeAgent?: string
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
    terminationReason?: string
}

export type ResumeSessionResponse = {
    type: 'already-active' | 'resumed' | 'created'
    sessionId: string
    resumedFrom?: string
    usedResume?: boolean
}

export type RefreshAccountResponse = {
    type: 'success'
    sessionId: string
    usedResume?: boolean
    resumeVerified?: boolean
    resumeMismatchSessionId?: string | null
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

export type AIProfileRole = 'developer' | 'architect' | 'reviewer' | 'pm' | 'tester' | 'devops'
export type AIProfileStatus = 'idle' | 'working' | 'resting'

export type AIProfile = {
    id: string
    namespace: string
    name: string
    role: AIProfileRole
    specialties: string[]
    personality: string | null
    greetingTemplate: string | null
    preferredProjects: string[]
    workStyle: string | null
    avatarEmoji: string
    status: AIProfileStatus
    stats: {
        tasksCompleted: number
        activeMinutes: number
        lastActiveAt: number | null
    }
    createdAt: number
    updatedAt: number
}

export type AIProfilesResponse = { profiles: AIProfile[] }
export type CreateAIProfileInput = {
    name: string
    role: AIProfileRole
    specialties?: string[]
    personality?: string | null
    greetingTemplate?: string | null
    preferredProjects?: string[]
    workStyle?: string | null
    avatarEmoji?: string
}
export type UpdateAIProfileInput = Partial<CreateAIProfileInput>
export type CreateAIProfileResponse = { ok: true; profile: AIProfile }
export type UpdateAIProfileResponse = { ok: true; profile: AIProfile }
export type DeleteAIProfileResponse = { ok: true }

export type TokenSourceAgent = 'claude' | 'codex'

export type TokenSource = {
    id: string
    name: string
    baseUrl: string
    supportedAgents: TokenSourceAgent[]
    createdAt: number
    updatedAt: number
    apiKey?: string
    apiKeyMasked?: string | null
    hasApiKey: boolean
}

export type TokenSourcesResponse = {
    tokenSources: TokenSource[]
    canManage: boolean
    includeSecrets: boolean
}

export type CreateTokenSourceInput = {
    name: string
    baseUrl: string
    apiKey: string
    supportedAgents: TokenSourceAgent[]
}

export type UpdateTokenSourceInput = Partial<CreateTokenSourceInput>
export type CreateTokenSourceResponse = { ok: true; tokenSource: TokenSource }
export type UpdateTokenSourceResponse = { ok: true; tokenSource: TokenSource }
export type DeleteTokenSourceResponse = { ok: true }

export type Project = {
    id: string
    name: string
    path: string
    description: string | null
    machineId: string | null
    createdAt: number
    updatedAt: number
}

export type ProjectsResponse = { projects: Project[] }
export type AddProjectResponse = { ok: true; project: Project; projects: Project[] }
export type UpdateProjectResponse = { ok: true; project: Project; projects: Project[] }
export type RemoveProjectResponse = { ok: true; projects: Project[] }
export type UpdateMachineResponse = { ok: true; machine: Machine }

export type BrainAgent = 'claude' | 'codex'

export type BrainConfig = {
    namespace: string
    agent: BrainAgent
    claudeModelMode: string
    codexModel: string
    extra: Record<string, unknown>
    updatedAt: number
    updatedBy: string | null
}

export type BrainConfigResponse = BrainConfig
export type UpdateBrainConfigResponse = { ok: true; config: BrainConfig }

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
    terminationReason?: string  // e.g. 'LICENSE_EXPIRED', 'LICENSE_SUSPENDED'
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
    supportedAgents: ('claude' | 'codex')[] | null  // null = no restriction
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

// 当前用户信息
export type MeResponse = {
    email: string | null
    name: string | null
    role: 'developer' | 'operator'
    orgs: { id: string; name: string; role: string }[]
}

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
    | { type: 'error'; message: string; code?: string; logs?: SpawnLogEntry[] }

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
    acceptUrl?: string
}

export type LicenseStatus = 'active' | 'expired' | 'suspended'

export type OrgLicense = {
    id: string
    orgId: string
    startsAt: number
    expiresAt: number
    maxMembers: number
    maxConcurrentSessions: number | null
    status: LicenseStatus
    issuedBy: string
    note: string | null
    createdAt: number
    updatedAt: number
}

export type AdminLicense = OrgLicense & {
    orgName: string
    orgSlug: string
    memberCount: number
}

export type OrgsResponse = { orgs: Organization[] }
export type OrgDetailResponse = {
    org: Organization
    members: OrgMember[]
    myRole: OrgRole
    license?: OrgLicense | null
    licenseExempt?: boolean
}
export type CreateOrgResponse = { ok: true; org: Organization }
export type UpdateOrgResponse = { ok: true; org: Organization }
export type OrgMembersResponse = { members: OrgMember[] }
export type OrgInvitationsResponse = { invitations: OrgInvitation[] }
export type PendingInvitationsResponse = { invitations: OrgInvitation[] }
export type OrgActionResponse = { ok: true }
export type CreateInvitationResponse = {
    ok: true
    invitation: OrgInvitation
    acceptUrl: string
    emailSent: boolean
    emailError: string | null
}
export type AcceptInvitationResponse = { ok: true; orgId: string }
export type AdminLicensesResponse = { licenses: AdminLicense[] }
export type LicenseOrganizationsResponse = { orgs: Organization[] }
export type UpsertLicenseResponse = { ok: true; license: OrgLicense }
