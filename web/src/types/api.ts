export type PermissionMode = 'default' | 'bypassPermissions' | 'read-only' | 'safe-yolo' | 'yolo'
export type SpawnAgentType = 'claude' | 'codex'
export type ClaudeModelMode = 'default' | 'sonnet' | 'opus' | 'opus-4-7'
export type CodexModelMode = 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.2' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini'
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
    selfSystemEnabled?: boolean
    selfProfileId?: string
    selfProfileName?: string
    selfProfileResolved?: boolean
    selfMemoryProvider?: 'yoho-memory' | 'none'
    selfMemoryAttached?: boolean
    selfMemoryStatus?: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error'
    lifecycleState?: string
    lifecycleStateSince?: number
    archivedBy?: string
    archiveReason?: string
    scheduleId?: string
    label?: string
    automationSystemPrompt?: string
    tags?: string[]
    ownerEmail?: string
    takeoverBy?: string | null
    takeoverAt?: number | null
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

export type SessionActiveMonitor = {
    id: string
    description: string
    command: string
    persistent: boolean
    timeoutMs: number | null
    startedAt: number
    taskId: string | null
    state: 'running' | 'unknown'
}

export type Session = {
    id: string
    createdAt: number
    updatedAt: number
    lastMessageAt?: number | null
    active: boolean
    reconnecting?: boolean
    thinking: boolean
    createdBy?: string
    metadata: SessionMetadataSummary | null
    agentState: AgentState | null
    todos?: TodoItem[]
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
    fastMode?: boolean
    activeMonitors?: SessionActiveMonitor[]
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
    selfSystemEnabled?: boolean
    selfProfileId?: string
    selfProfileName?: string
    selfProfileResolved?: boolean
    selfMemoryProvider?: 'yoho-memory' | 'none'
    selfMemoryAttached?: boolean
    selfMemoryStatus?: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error'
    lifecycleState?: string
    lifecycleStateSince?: number
    archivedBy?: string
    archiveReason?: string
    scheduleId?: string
    label?: string
    automationSystemPrompt?: string
    tags?: string[]
    ownerEmail?: string
    takeoverBy?: string | null
    takeoverAt?: number | null
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

export type AIProfileRoleLegacy = 'developer' | 'architect' | 'reviewer' | 'pm' | 'tester' | 'devops'
export type AIProfileRoleMbti = 'INTP' | 'INTJ' | 'ENTP' | 'ISTJ' | 'ISTP' | 'ENFP' | 'INFJ'
export type AIProfileRole = AIProfileRoleLegacy | AIProfileRoleMbti
export type AIProfileStatus = 'idle' | 'working' | 'resting'

export type AIProfile = {
    id: string
    namespace: string
    orgId: string | null
    name: string
    role: AIProfileRole
    specialties: string[]
    behaviorAnchors: string[]
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
    behaviorAnchors?: string[]
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
    localEnabled?: boolean
}

export type SetLocalTokenSourceEnabledResponse = { ok: true; localEnabled: boolean }

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
    orgId: string | null
    agent: BrainAgent
    claudeModelMode: string
    codexModel: string
    extra: Record<string, unknown>
    updatedAt: number
    updatedBy: string | null
}

export type BrainConfigResponse = BrainConfig
export type UpdateBrainConfigResponse = { ok: true; config: BrainConfig }

export type UserSelfSystemConfig = {
    orgId: string
    userEmail: string
    enabled: boolean
    defaultProfileId: string | null
    memoryProvider: 'yoho-memory' | 'none'
    updatedAt: number
    updatedBy: string | null
}

export type UserSelfSystemConfigResponse = UserSelfSystemConfig
export type UpdateUserSelfSystemConfigInput = {
    enabled: boolean
    defaultProfileId?: string | null
    memoryProvider: 'yoho-memory' | 'none'
}
export type UpdateUserSelfSystemConfigResponse = { ok: true; config: UserSelfSystemConfig }

export type RolePrompt = {
    role: UserRole
    prompt: string
    updatedAt: number
}

export type RolePromptsResponse = { prompts: RolePrompt[] }
export type SetRolePromptResponse = { ok: true; prompts: RolePrompt[] }

export type SessionSummary = {
    id: string
    createdAt: number
    active: boolean
    reconnecting?: boolean
    activeAt: number
    updatedAt: number
    lastMessageAt: number | null
    createdBy?: string
    ownerEmail?: string  // 当 session 来自其他用户（开启了 shareAllSessions）时显示
    metadata: SessionSummaryMetadata | null
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    thinking: boolean
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
    fastMode?: boolean
    activeMonitorCount?: number
    viewers?: SessionViewer[]
    terminationReason?: string  // e.g. 'LICENSE_EXPIRED', 'LICENSE_SUSPENDED'
    participants?: IdentityActorMeta[]
}

export type MessageStatus = 'sending' | 'sent' | 'failed'

export type BrainMessageDeliveryPhase = 'queued' | 'pending_consume' | 'consuming' | 'merged'

export type BrainMessageDelivery = {
    phase: BrainMessageDeliveryPhase
    acceptedAt: number
}

export type SendMessageResponse = {
    ok: true
    sessionId: string
    status: 'delivered' | 'queued'
    queue?: 'brain-child-init' | 'brain-session-inbox'
    queueDepth?: number
    brainDelivery?: BrainMessageDelivery
}

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

// AI Task Schedule types
export type AiTaskSchedule = {
    scheduleId: string
    machineId: string | null
    label: string | null
    cron: string
    prompt: string | null
    recurring: boolean
    directory: string
    agent: string
    mode: string | null
    enabled: boolean
    createdAt: string | null
    nextFireAt: string | null
    lastRunAt: string | null
    lastRunStatus: string | null
    systemPrompt: string | null
    tags: string[] | null
    ownerEmail: string | null
    permissionMode: string | null
    createdBySessionId: string | null
}

export type AiTaskRun = {
    runId: string
    scheduleId: string | null
    sessionId: string | null
    subsessionId: string | null
    machineId: string
    status: string
    startedAt: string | null
    finishedAt: string | null
    error: string | null
}

export type AiTaskSchedulesResponse = { schedules: AiTaskSchedule[] }
export type AiTaskScheduleResponse = { schedule: AiTaskSchedule; runs?: AiTaskRun[] }
export type AiTaskScheduleMutationResponse = { schedule: AiTaskSchedule }
export type AiTaskScheduleDeleteResponse = { ok: true }

export type CreateAiTaskScheduleInput = {
    cronOrDelay: string
    prompt: string
    directory: string
    recurring: boolean
    machineId: string
    label?: string
    agent: 'claude' | 'codex'
    mode?: string
    systemPrompt?: string
    tags?: string[]
    permissionMode?: string
    createdBySessionId?: string
}

export type UpdateAiTaskScheduleInput = {
    label?: string | null
    prompt?: string
    systemPrompt?: string | null
    tags?: string[] | null
    permissionMode?: string | null
    enabled?: boolean
}

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
    | { type: 'session-added'; sessionId: string; data?: unknown; orgId?: string | null; namespace?: string }
    | { type: 'session-updated'; sessionId: string; data?: unknown; orgId?: string | null; namespace?: string }
    | { type: 'session-removed'; sessionId: string; orgId?: string | null; namespace?: string }
    | { type: 'message-received'; sessionId: string; message: DecryptedMessage; orgId?: string | null; namespace?: string }
    | { type: 'messages-cleared'; sessionId: string; orgId?: string | null; namespace?: string }
    | { type: 'machine-updated'; machineId: string; data?: unknown; orgId?: string | null; namespace?: string }
    | { type: 'connection-changed'; data?: { status: string }; orgId?: string | null; namespace?: string }
    | { type: 'online-users-changed'; users: OnlineUser[]; orgId?: string | null; namespace?: string }
    | { type: 'typing-changed'; sessionId: string; typing: TypingUser; orgId?: string | null; namespace?: string }
    | { type: 'file-ready'; sessionId: string; fileInfo: DownloadFileInfo; orgId?: string | null; namespace?: string }
    | {
        type: 'identity-candidate-updated'
        orgId?: string | null
        namespace?: string
        data: {
            orgId: string | null
            candidateId: string
            identityId: string
            status: IdentityCandidateStatus
            score: number
        }
    }

export type OnlineUsersResponse = { users: OnlineUser[] }

export type IdentityChannel = 'keycloak' | 'feishu' | 'wecom' | 'custom-im' | 'cli'
export type IdentityAccountType = 'human' | 'shared' | 'service' | 'bot' | 'unknown'
export type IdentityAssurance = 'high' | 'medium' | 'low'
export type IdentityStatus = 'active' | 'disabled' | 'departed' | 'conflict'
export type IdentityActorResolution = 'auto_verified' | 'admin_verified' | 'pending' | 'rejected' | 'detached' | 'unresolved' | 'shared'
export type PersonType = 'human' | 'shared' | 'service' | 'bot'
export type PersonStatus = 'active' | 'suspended' | 'departed' | 'merged'
export type IdentityCandidateStatus = 'open' | 'confirmed' | 'rejected' | 'superseded' | 'expired'

export type StoredPerson = {
    id: string
    namespace: string
    orgId: string | null
    personType: PersonType
    status: PersonStatus
    canonicalName: string | null
    primaryEmail: string | null
    employeeCode: string | null
    avatarUrl: string | null
    attributes: Record<string, unknown>
    createdAt: number
    updatedAt: number
    createdBy: string | null
    mergedIntoPersonId: string | null
}

export type StoredPersonIdentity = {
    id: string
    namespace: string
    orgId: string | null
    channel: IdentityChannel
    providerTenantId: string | null
    externalId: string
    secondaryId: string | null
    accountType: IdentityAccountType
    assurance: IdentityAssurance
    canonicalEmail: string | null
    displayName: string | null
    loginName: string | null
    employeeCode: string | null
    status: IdentityStatus
    attributes: Record<string, unknown>
    firstSeenAt: number
    lastSeenAt: number
    createdAt: number
    updatedAt: number
}

export type IdentityActorMeta = {
    identityId: string
    personId: string | null
    channel: IdentityChannel
    resolution: IdentityActorResolution
    displayName: string | null
    email: string | null
    externalId: string
    accountType: IdentityAccountType
}

export type IdentityCandidate = {
    id: string
    namespace: string
    orgId: string | null
    identityId: string
    candidatePersonId: string | null
    score: number
    autoAction: 'auto_bind' | 'review' | 'ignore'
    status: IdentityCandidateStatus
    riskFlags: unknown[]
    evidence: unknown[]
    matcherVersion: string
    suppressUntil: number | null
    decidedBy: string | null
    decidedAt: number | null
    decisionReason: string | null
    createdAt: number
    updatedAt: number
    identity: StoredPersonIdentity
    candidatePerson: StoredPerson | null
}

export type IdentityCandidatesResponse = { candidates: IdentityCandidate[] }
export type IdentityPersonsResponse = { persons: StoredPerson[] }
export type IdentityCandidateDecision =
    | { action: 'confirm_existing_person'; personId: string; reason?: string }
    | {
        action: 'create_person_and_confirm'
        createPerson?: {
            canonicalName?: string | null
            primaryEmail?: string | null
            employeeCode?: string | null
        }
        reason?: string
    }
    | { action: 'mark_shared'; reason?: string }
    | { action: 'reject'; reason?: string }
export type IdentityCandidateDecisionResponse = { ok: true; candidate: IdentityCandidate }

export type IdentityLinkState =
    | 'pending'
    | 'auto_verified'
    | 'admin_verified'
    | 'rejected'
    | 'detached'
    | 'superseded'

export type StoredPersonIdentityLink = {
    id: string
    personId: string
    identityId: string
    relationType: 'primary' | 'alias' | 'shared'
    state: IdentityLinkState
    confidence: number
    source: 'auto' | 'admin' | 'import' | 'system'
    evidence: unknown[]
    decisionReason: string | null
    validFrom: number
    validTo: number | null
    decidedBy: string | null
    createdAt: number
    updatedAt: number
}

export type StoredPersonIdentityAudit = {
    id: string
    namespace: string
    orgId: string | null
    action:
        | 'merge_persons'
        | 'unmerge_persons'
        | 'confirm_existing_person'
        | 'create_person_and_confirm'
        | 'mark_shared'
        | 'reject_candidate'
        | 'detach_identity_link'
        | string
    actorEmail: string | null
    personId: string | null
    targetPersonId: string | null
    identityId: string | null
    linkId: string | null
    reason: string | null
    payload: Record<string, unknown>
    createdAt: number
}

export type IdentityPersonDetail = {
    person: StoredPerson
    identities: Array<{
        identity: StoredPersonIdentity
        link: StoredPersonIdentityLink
    }>
}

export type IdentityPersonDetailResponse = IdentityPersonDetail
export type IdentityAuditsResponse = { audits: StoredPersonIdentityAudit[] }
export type IdentityMergeResponse = { ok: true; person: StoredPerson }
export type IdentityUnmergeResponse = { ok: true; person: StoredPerson }
export type IdentityDetachResponse = { ok: true; link: StoredPersonIdentityLink }

// === Communication Plan (Phase 3A) ===
export type CommunicationPlanLength = 'concise' | 'detailed' | 'default'
export type CommunicationPlanExplanationDepth = 'minimal' | 'moderate' | 'thorough'
export type CommunicationPlanFormality = 'casual' | 'neutral' | 'formal'
export type CommunicationPlanAuditAction = 'created' | 'updated' | 'disabled' | 'enabled'

export type CommunicationPlanPreferences = {
    tone?: string | null
    length?: CommunicationPlanLength | null
    explanationDepth?: CommunicationPlanExplanationDepth | null
    formality?: CommunicationPlanFormality | null
    customInstructions?: string | null
}

export type StoredCommunicationPlan = {
    id: string
    namespace: string
    orgId: string | null
    personId: string
    preferences: CommunicationPlanPreferences
    enabled: boolean
    version: number
    createdAt: number
    updatedAt: number
    updatedBy: string | null
}

export type StoredCommunicationPlanAudit = {
    id: string
    namespace: string
    orgId: string | null
    planId: string
    personId: string
    action: CommunicationPlanAuditAction
    priorPreferences: CommunicationPlanPreferences | null
    newPreferences: CommunicationPlanPreferences | null
    priorEnabled: boolean | null
    newEnabled: boolean | null
    actorEmail: string | null
    reason: string | null
    createdAt: number
}

export type CommunicationPlanResponse = { plan: StoredCommunicationPlan | null }
export type CommunicationPlanUpdateResponse = { ok: true; plan: StoredCommunicationPlan }
export type CommunicationPlanAuditsResponse = { audits: StoredCommunicationPlanAudit[] }

// === Team Memory (Phase 3B) ===
export type TeamMemoryScope = 'team'
export type TeamMemoryCandidateStatus = 'pending' | 'approved' | 'rejected' | 'superseded' | 'expired'
export type TeamMemoryAuditAction =
    | 'proposed'
    | 'approved'
    | 'rejected'
    | 'superseded'
    | 'expired'

export type StoredTeamMemoryCandidate = {
    id: string
    namespace: string
    orgId: string
    proposedByPersonId: string | null
    proposedByEmail: string | null
    scope: TeamMemoryScope
    content: string
    source: string | null
    sessionId: string | null
    status: TeamMemoryCandidateStatus
    decidedBy: string | null
    decidedAt: number | null
    decisionReason: string | null
    memoryRef: string | null
    createdAt: number
    updatedAt: number
}

export type StoredTeamMemoryAudit = {
    id: string
    namespace: string
    orgId: string
    candidateId: string
    action: TeamMemoryAuditAction
    priorStatus: TeamMemoryCandidateStatus | null
    newStatus: TeamMemoryCandidateStatus
    actorEmail: string | null
    reason: string | null
    memoryRef: string | null
    createdAt: number
}

export type TeamMemoryCandidatesResponse = { candidates: StoredTeamMemoryCandidate[] }
export type TeamMemoryCandidateResponse = { candidate: StoredTeamMemoryCandidate }
export type TeamMemoryCandidateDecision =
    | { action: 'approve'; memoryRef?: string | null; reason?: string | null }
    | { action: 'reject'; reason?: string | null }
    | { action: 'supersede'; memoryRef?: string | null; reason?: string | null }
    | { action: 'expire'; reason?: string | null }
export type TeamMemoryDecisionResponse = { ok: true; candidate: StoredTeamMemoryCandidate }
export type TeamMemoryAuditsResponse = { audits: StoredTeamMemoryAudit[] }

// === Observation Hypothesis (Phase 3F) ===
export type ObservationCandidateStatus = 'pending' | 'confirmed' | 'rejected' | 'dismissed' | 'expired'
export type ObservationAuditAction =
    | 'generated'
    | 'confirmed'
    | 'rejected'
    | 'dismissed'
    | 'expired'

export type ObservationSignal = {
    kind: string
    summary?: string | null
    sampleSessionId?: string | null
    occurredAt?: number | null
    weight?: number | null
}

export type StoredObservationCandidate = {
    id: string
    namespace: string
    orgId: string
    subjectPersonId: string | null
    subjectEmail: string | null
    hypothesisKey: string
    summary: string
    detail: string | null
    detectorVersion: string
    confidence: number
    signals: ObservationSignal[]
    suggestedPatch: Record<string, unknown> | null
    status: ObservationCandidateStatus
    decidedBy: string | null
    decidedAt: number | null
    decisionReason: string | null
    promotedCommunicationPlanId: string | null
    expiresAt: number | null
    createdAt: number
    updatedAt: number
}

export type StoredObservationAudit = {
    id: string
    namespace: string
    orgId: string
    candidateId: string
    action: ObservationAuditAction
    priorStatus: ObservationCandidateStatus | null
    newStatus: ObservationCandidateStatus
    actorEmail: string | null
    reason: string | null
    payload: Record<string, unknown> | null
    createdAt: number
}

export type ObservationCandidatesResponse = { candidates: StoredObservationCandidate[] }
export type ObservationCandidateResponse = { candidate: StoredObservationCandidate }
export type ObservationDecision =
    | { action: 'confirm'; promotedCommunicationPlanId?: string | null; reason?: string | null }
    | { action: 'reject'; reason?: string | null }
    | { action: 'dismiss'; reason?: string | null }
    | { action: 'expire'; reason?: string | null }
export type ObservationDecisionResponse = { ok: true; candidate: StoredObservationCandidate }
export type ObservationAuditsResponse = { audits: StoredObservationAudit[] }

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
