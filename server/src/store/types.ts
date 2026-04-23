// Store 类型定义 - 从 index.ts 提取

export type StoredSession = {
    id: string
    tag: string | null
    namespace: string
    machineId: string | null
    createdAt: number
    updatedAt: number
    createdBy: string | null  // 创建者 email
    orgId: string | null
    metadata: unknown | null
    metadataVersion: number
    agentState: unknown | null
    agentStateVersion: number
    todos: unknown | null
    todosUpdatedAt: number | null
    active: boolean
    activeAt: number | null
    thinking: boolean
    thinkingAt: number | null
    seq: number
    advisorTaskId: string | null
    creatorChatId: string | null
    advisorMode: boolean
    advisorPromptInjected: boolean
    rolePromptSent: boolean
    permissionMode: string | null
    modelMode: string | null
    modelReasoningEffort: string | null
    fastMode: boolean | null
    terminationReason: string | null
    lastMessageAt: number | null
    activeMonitors: unknown | null
}

export type StoredSessionSearchMatchSource = 'turn-summary' | 'brain-summary' | 'title' | 'path'

export type StoredSessionSearchMatch = {
    source: StoredSessionSearchMatchSource
    text: string
    createdAt: number | null
    seqStart: number | null
    seqEnd: number | null
}

export type StoredSessionSearchResult = {
    session: StoredSession
    score: number
    match: StoredSessionSearchMatch
}

export type SpawnAgentType = 'claude' | 'codex'

export type StoredMachine = {
    id: string
    namespace: string
    createdAt: number
    updatedAt: number
    metadata: unknown | null
    metadataVersion: number
    daemonState: unknown | null
    daemonStateVersion: number
    active: boolean
    activeAt: number | null
    seq: number
    orgId: string | null
    supportedAgents: SpawnAgentType[] | null  // null = 不限制（所有 agent 都允许）
}

export type StoredMessage = {
    id: string
    sessionId: string
    content: unknown
    createdAt: number
    seq: number
    localId: string | null
}

export type StoredDownloadFile = {
    id: string
    sessionId: string
    orgId: string | null
    filename: string
    mimeType: string
    size: number
    createdAt: number
}

export type UserRole = 'developer' | 'operator'

// Organization 相关类型
export type OrgRole = 'owner' | 'admin' | 'member'

export type StoredOrganization = {
    id: string
    name: string
    slug: string
    createdBy: string
    createdAt: number
    updatedAt: number
    settings: Record<string, unknown>
}

export type StoredOrgMember = {
    orgId: string
    userEmail: string
    userId: string
    role: OrgRole
    joinedAt: number
    invitedBy: string | null
}

export type StoredOrgInvitation = {
    id: string
    orgId: string
    email: string
    role: OrgRole
    invitedBy: string
    createdAt: number
    expiresAt: number
    acceptedAt: number | null
}

// Org License 类型
export type LicenseStatus = 'active' | 'expired' | 'suspended'

export type StoredOrgLicense = {
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

// Identity Graph 相关类型
export type IdentityChannel = 'keycloak' | 'feishu' | 'wecom' | 'custom-im' | 'telegram' | 'cli'
export type PersonType = 'human' | 'shared' | 'service' | 'bot'
export type PersonStatus = 'active' | 'suspended' | 'departed' | 'merged'
export type IdentityAccountType = 'human' | 'shared' | 'service' | 'bot' | 'unknown'
export type IdentityAssurance = 'high' | 'medium' | 'low'
export type IdentityStatus = 'active' | 'disabled' | 'departed' | 'conflict'
export type PersonIdentityRelationType = 'primary' | 'alias' | 'shared-access' | 'historical'
export type PersonIdentityLinkState = 'auto_verified' | 'admin_verified' | 'pending' | 'rejected' | 'detached'
export type PersonIdentityLinkSource = 'auto' | 'admin' | 'migration' | 'import'
export type PersonIdentityCandidateAutoAction = 'auto_bind' | 'review' | 'ignore'
export type PersonIdentityCandidateStatus = 'open' | 'confirmed' | 'rejected' | 'superseded' | 'expired'
export type PersonIdentityAuditAction = 'merge_persons' | 'unmerge_person' | 'detach_identity_link'

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

export type StoredPersonIdentityLink = {
    id: string
    personId: string
    identityId: string
    relationType: PersonIdentityRelationType
    state: PersonIdentityLinkState
    confidence: number
    source: PersonIdentityLinkSource
    evidence: unknown[]
    decisionReason: string | null
    validFrom: number
    validTo: number | null
    decidedBy: string | null
    createdAt: number
    updatedAt: number
}

export type StoredPersonIdentityCandidate = {
    id: string
    namespace: string
    orgId: string | null
    identityId: string
    candidatePersonId: string | null
    score: number
    autoAction: PersonIdentityCandidateAutoAction
    status: PersonIdentityCandidateStatus
    riskFlags: unknown[]
    evidence: unknown[]
    matcherVersion: string
    suppressUntil: number | null
    decidedBy: string | null
    decidedAt: number | null
    decisionReason: string | null
    createdAt: number
    updatedAt: number
}

export type IdentityObservation = {
    namespace: string
    orgId?: string | null
    channel: IdentityChannel
    providerTenantId?: string | null
    externalId: string
    secondaryId?: string | null
    canonicalEmail?: string | null
    displayName?: string | null
    loginName?: string | null
    employeeCode?: string | null
    accountType?: IdentityAccountType
    assurance: IdentityAssurance
    attributes?: Record<string, unknown>
}

export type ResolvedActorContext = {
    identityId: string
    personId: string | null
    channel: IdentityChannel
    resolution: PersonIdentityLinkState | 'unresolved' | 'shared'
    displayName: string | null
    email: string | null
    externalId: string
    accountType: IdentityAccountType
}

export type IdentityCandidateSummary = StoredPersonIdentityCandidate & {
    identity: StoredPersonIdentity
    candidatePerson: StoredPerson | null
}

export type StoredPersonIdentityAudit = {
    id: string
    namespace: string
    orgId: string | null
    action: PersonIdentityAuditAction
    actorEmail: string | null
    personId: string | null
    targetPersonId: string | null
    identityId: string | null
    linkId: string | null
    reason: string | null
    payload: unknown
    createdAt: number
}

export type StoredAdminOrgLicense = StoredOrgLicense & {
    orgName: string
    orgSlug: string
    memberCount: number
}

export type StoredPushSubscription = {
    id: number
    namespace: string
    endpoint: string
    keys: {
        p256dh: string
        auth: string
    }
    userAgent: string | null
    clientId: string | null
    chatId: string | null
    createdAt: number
    updatedAt: number
}

// Advisor Agent 相关类型
export type AdvisorStatus = 'idle' | 'running' | 'error'
export type SuggestionCategory = 'product' | 'architecture' | 'operation' | 'strategy' | 'collaboration'
export type SuggestionSeverity = 'low' | 'medium' | 'high' | 'critical'
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'stale' | 'superseded'
export type SuggestionScope = 'session' | 'project' | 'team' | 'global'
export type MemoryType = 'insight' | 'pattern' | 'decision' | 'lesson'
export type FeedbackSource = 'user' | 'auto' | 'advisor'
export type FeedbackAction = 'accept' | 'reject' | 'defer' | 'supersede'

// Auto-Iteration 相关类型
export type AutoIterActionType =
    | 'format_code' | 'fix_lint' | 'add_comments' | 'run_tests'
    | 'fix_type_errors' | 'update_deps' | 'refactor' | 'optimize'
    | 'edit_config' | 'create_file' | 'delete_file'
    | 'git_commit' | 'git_push' | 'deploy' | 'custom'

export type AutoIterExecutionPolicy =
    | 'auto_execute' | 'notify_then_execute' | 'require_confirm' | 'always_manual' | 'disabled'

export type AutoIterExecutionStatus =
    | 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'timeout'

export type AutoIterApprovalMethod = 'auto' | 'manual' | 'timeout'
export type AutoIterNotificationLevel = 'all' | 'errors_only' | 'none'

export type StoredAutoIterationConfig = {
    namespace: string
    enabled: boolean
    policyJson: Partial<Record<AutoIterActionType, AutoIterExecutionPolicy>> | null
    allowedProjects: string[]
    notificationLevel: AutoIterNotificationLevel
    keepLogsDays: number
    createdAt: number
    updatedAt: number
    updatedBy: string | null
}

export type StoredAutoIterationLog = {
    id: string
    namespace: string
    sourceSuggestionId: string | null
    sourceSessionId: string | null
    projectPath: string | null
    actionType: AutoIterActionType
    actionDetail: unknown | null
    reason: string | null
    executionStatus: AutoIterExecutionStatus
    approvalMethod: AutoIterApprovalMethod | null
    approvedBy: string | null
    approvedAt: number | null
    resultJson: unknown | null
    errorMessage: string | null
    rollbackAvailable: boolean
    rollbackData: unknown | null
    rolledBack: boolean
    rolledBackAt: number | null
    createdAt: number
    executedAt: number | null
}

export type StoredSessionAutoIterConfig = {
    sessionId: string
    autoIterEnabled: boolean
    updatedAt: number
}

// AI Profile 相关类型
export type AIProfileRole = 'developer' | 'architect' | 'reviewer' | 'pm' | 'tester' | 'devops'
export type AIProfileStatus = 'idle' | 'working' | 'resting'
export type AIProfileMemoryType = 'context' | 'preference' | 'knowledge' | 'experience'

export type StoredAIProfile = {
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

export type StoredAIProfileMemory = {
    id: string
    namespace: string
    profileId: string
    memoryType: AIProfileMemoryType
    content: string
    importance: number
    accessCount: number
    lastAccessedAt: number | null
    expiresAt: number | null
    createdAt: number
    updatedAt: number
    metadata: unknown | null
}

// AI Team 相关类型
export type AITeamStatus = 'active' | 'paused' | 'archived'
export type AITeamMemberRole = 'lead' | 'member' | 'advisor'

export type StoredAITeam = {
    id: string
    namespace: string
    name: string
    description: string | null
    focus: string | null
    status: AITeamStatus
    config: {
        maxMembers: number
        autoAssign: boolean
        sharedKnowledge: boolean
    }
    stats: {
        tasksCompleted: number
        activeHours: number
        collaborationScore: number
    }
    createdAt: number
    updatedAt: number
}

export type StoredAITeamMember = {
    teamId: string
    profileId: string
    role: AITeamMemberRole
    joinedAt: number
    contribution: number
    specialization: string | null
}

export type StoredAITeamKnowledge = {
    id: string
    teamId: string
    namespace: string
    title: string
    content: string
    category: 'best-practice' | 'lesson-learned' | 'decision' | 'convention'
    contributorProfileId: string
    importance: number
    accessCount: number
    createdAt: number
    updatedAt: number
}

export type StoredSessionNotificationSubscription = {
    id: number
    sessionId: string
    chatId: string | null
    clientId: string | null
    namespace: string
    subscribedAt: number
}

export type StoredAdvisorState = {
    namespace: string
    advisorSessionId: string | null
    machineId: string | null
    status: AdvisorStatus
    lastSeen: number | null
    configJson: unknown | null
    updatedAt: number
}

export type StoredAgentSessionState = {
    sessionId: string
    namespace: string
    lastSeq: number
    summary: string | null
    contextJson: unknown | null
    updatedAt: number
}

export type StoredAgentMemory = {
    id: number
    namespace: string
    type: MemoryType
    contentJson: unknown
    sourceRef: string | null
    confidence: number
    expiresAt: number | null
    updatedAt: number
}

export type StoredAgentSuggestion = {
    id: string
    namespace: string
    sessionId: string | null
    sourceSessionId: string | null
    title: string
    detail: string | null
    category: SuggestionCategory | null
    severity: SuggestionSeverity
    confidence: number
    status: SuggestionStatus
    targets: string | null
    scope: SuggestionScope
    createdAt: number
    updatedAt: number
}

export type StoredAgentFeedback = {
    id: number
    suggestionId: string
    source: FeedbackSource
    userId: string | null
    action: FeedbackAction
    evidenceJson: unknown | null
    comment: string | null
    createdAt: number
}

export type StoredUser = {
    id: number
    platform: string
    platformUserId: string
    namespace: string
    role: UserRole
    createdAt: number
}

export type VersionedUpdateResult<T> =
    | { result: 'success'; version: number; value: T }
    | { result: 'version-mismatch'; version: number; value: T }
    | { result: 'error' }

// 项目类型
export type StoredProject = {
    id: string
    name: string
    path: string
    description: string | null
    machineId: string | null
    orgId: string | null
    createdAt: number
    updatedAt: number
}

// 角色 Prompt 类型
export type StoredRolePrompt = {
    role: UserRole
    prompt: string
    updatedAt: number
}

// 输入预设类型
export type StoredInputPreset = {
    id: string
    trigger: string
    title: string
    prompt: string
    orgId: string | null      // 所属组织 ID，null 表示全局预设
    createdAt: number
    updatedAt: number
}

// 允许的邮箱类型
export type StoredAllowedEmail = {
    email: string
    role: UserRole
    shareAllSessions: boolean
    viewOthersSessions: boolean
    createdAt: number
}

// Session 共享类型
export type StoredSessionShare = {
    sessionId: string
    sharedWithEmail: string
    sharedByEmail: string
    createdAt: number
}

export type ControlPlaneActorType = 'user' | 'session' | 'service'
export type ApprovalRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
export type ApprovalDecisionResult = 'approved' | 'rejected' | 'expired' | 'cancelled' | 'provider_failed'
export type CapabilityGrantStatus = 'active' | 'revoked' | 'expired' | 'exhausted'

export type StoredApprovalRequest = {
    id: string
    namespace: string
    orgId: string | null
    sessionId: string | null
    parentSessionId: string | null
    requestKind: string
    toolName: string | null
    resourceType: string | null
    resourceSelector: unknown | null
    requestedMode: string | null
    requestedTools: string[] | null
    requestPayload: unknown | null
    riskLevel: string | null
    providerHint: string | null
    requestedByType: ControlPlaneActorType
    requestedById: string
    status: ApprovalRequestStatus
    requestedAt: number
    expiresAt: number | null
}

export type StoredApprovalDecision = {
    id: string
    approvalRequestId: string
    namespace: string
    orgId: string | null
    provider: string | null
    result: ApprovalDecisionResult
    decidedByType: ControlPlaneActorType
    decidedById: string
    decisionPayload: unknown | null
    decidedAt: number
    expiresAt: number | null
}

export type StoredCapabilityGrant = {
    id: string
    approvalRequestId: string | null
    approvalDecisionId: string | null
    namespace: string
    orgId: string | null
    subjectType: ControlPlaneActorType
    subjectId: string
    sourceSessionId: string | null
    boundSessionId: string | null
    boundMachineId: string | null
    boundProjectIds: string[] | null
    toolAllowlist: string[] | null
    resourceScopes: unknown | null
    modeCap: string | null
    maxUses: number | null
    usedCount: number
    status: CapabilityGrantStatus
    issuedAt: number
    expiresAt: number | null
    revokedAt: number | null
    revokeReason: string | null
}

export type StoredAuditEvent = {
    id: string
    namespace: string
    orgId: string | null
    eventType: string
    subjectType: ControlPlaneActorType | null
    subjectId: string | null
    sessionId: string | null
    parentSessionId: string | null
    resourceType: string | null
    resourceId: string | null
    action: string
    result: string
    sourceSystem: string
    correlationId: string | null
    payload: unknown | null
    createdAt: number
}

// Brain (K1) 配置类型 — 独立于 IM 平台（飞书/钉钉/企微等）
export type BrainAgent = 'claude' | 'codex'

export type StoredBrainConfig = {
    namespace: string
    /** Agent 类型：claude (Claude Code) 或 codex (OpenAI Codex) */
    agent: BrainAgent
    /** Claude 模型模式 (agent=claude 时生效) */
    claudeModelMode: string
    /** Codex 模型 (agent=codex 时生效) */
    codexModel: string
    /** 额外 JSON 配置（预留扩展） */
    extra: Record<string, unknown>
    updatedAt: number
    updatedBy: string | null
}

// PostgreSQL 配置类型
export type PostgresConfig = {
    host: string
    port: number
    user: string
    password: string
    database: string
    ssl?: boolean | { rejectUnauthorized?: boolean }
}

// Store 配置类型
export type StoreConfig = {
    type: 'postgres'
    postgres?: PostgresConfig
}
