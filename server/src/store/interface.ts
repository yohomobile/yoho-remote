// IStore 接口定义 - 所有方法异步化
import type {
    StoredSession,
    StoredMachine,
    StoredMessage,
    StoredUser,
    StoredDownloadFile,
    StoredPushSubscription,
    StoredAdvisorState,
    StoredAgentSessionState,
    StoredAgentMemory,
    StoredAgentSuggestion,
    StoredAgentFeedback,
    StoredAutoIterationConfig,
    StoredAutoIterationLog,
    StoredSessionAutoIterConfig,
    StoredSessionNotificationSubscription,
    StoredAIProfile,
    StoredAIProfileMemory,
    StoredAITeam,
    StoredAITeamMember,
    StoredAITeamKnowledge,
    StoredProject,
    StoredRolePrompt,
    StoredInputPreset,
    StoredAllowedEmail,
    StoredSessionShare,
    StoredOrganization,
    StoredOrgMember,
    StoredOrgInvitation,
    StoredOrgLicense,
    StoredAdminOrgLicense,
    StoredBrainConfig,
    BrainAgent,
    LicenseStatus,
    OrgRole,
    UserRole,
    VersionedUpdateResult,
    SuggestionStatus,
    SuggestionCategory,
    SuggestionSeverity,
    SuggestionScope,
    MemoryType,
    FeedbackSource,
    FeedbackAction,
    AIProfileRole,
    AIProfileStatus,
    AIProfileMemoryType,
    AITeamStatus,
    AITeamMemberRole,
    AutoIterExecutionStatus,
    AutoIterActionType,
    AutoIterExecutionPolicy,
    AutoIterApprovalMethod,
    AutoIterNotificationLevel,
    SpawnAgentType,
} from './types'

export type { StoredSessionShare } from './types'

export interface IStore {
    // === Session 操作 ===
    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Promise<StoredSession>
    updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>>
    updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>>
    setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, namespace: string): Promise<boolean>
    setSessionAdvisorTaskId(id: string, advisorTaskId: string, namespace: string): Promise<boolean>
    setSessionAdvisorMode(id: string, advisorMode: boolean, namespace: string): Promise<boolean>
    setSessionAdvisorPromptInjected(id: string, namespace: string): Promise<boolean>
    shouldInjectAdvisorPrompt(id: string): Promise<boolean>
    isRolePromptSent(id: string): Promise<boolean>
    setSessionRolePromptSent(id: string, namespace: string): Promise<boolean>
    setSessionCreatedBy(id: string, email: string, namespace: string): Promise<boolean>
    setSessionOrgId(id: string, orgId: string, namespace: string): Promise<boolean>
    setSessionActive(id: string, active: boolean, activeAt: number, namespace: string, terminationReason?: string | null): Promise<boolean>
    setSessionModelConfig(id: string, config: {
        permissionMode?: string
        modelMode?: string
        modelReasoningEffort?: string
        fastMode?: boolean
    }, namespace: string): Promise<boolean>
    getSession(id: string): Promise<StoredSession | null>
    getSessionByNamespace(id: string, namespace: string): Promise<StoredSession | null>
    getSessions(orgId?: string | null): Promise<StoredSession[]>
    getSessionsByNamespace(namespace: string): Promise<StoredSession[]>
    getActiveSessionCount(orgId: string): Promise<number>
    deleteSession(id: string): Promise<boolean>
    patchSessionMetadata(id: string, patch: Record<string, unknown>, namespace: string): Promise<boolean>

    // === Machine 操作 ===
    getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown, namespace: string): Promise<StoredMachine>
    updateMachineMetadata(id: string, metadata: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>>
    updateMachineDaemonState(id: string, daemonState: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>>
    getMachine(id: string): Promise<StoredMachine | null>
    getMachineByNamespace(id: string, namespace: string): Promise<StoredMachine | null>
    getMachines(orgId?: string | null): Promise<StoredMachine[]>
    getMachinesByNamespace(namespace: string, orgId?: string | null): Promise<StoredMachine[]>
    setMachineOrgId(id: string, orgId: string, namespace: string): Promise<boolean>
    setMachineSupportedAgents(id: string, supportedAgents: SpawnAgentType[] | null, namespace: string): Promise<boolean>

    // === Message 操作 ===
    addMessage(sessionId: string, content: unknown, localId?: string): Promise<StoredMessage>
    getMessages(sessionId: string, limit?: number, beforeSeq?: number): Promise<StoredMessage[]>
    getMessagesAfter(sessionId: string, afterSeq: number, limit?: number): Promise<StoredMessage[]>
    getMessageCount(sessionId: string): Promise<number>
    clearMessages(sessionId: string, keepCount?: number): Promise<{ deleted: number; remaining: number }>

    // === User 操作 ===
    getUser(platform: string, platformUserId: string): Promise<StoredUser | null>
    getUsersByPlatform(platform: string): Promise<StoredUser[]>
    getUsersByPlatformAndNamespace(platform: string, namespace: string): Promise<StoredUser[]>
    addUser(platform: string, platformUserId: string, namespace: string, role?: UserRole): Promise<StoredUser>
    updateUserRole(platform: string, platformUserId: string, role: UserRole): Promise<boolean>
    removeUser(platform: string, platformUserId: string): Promise<boolean>

    // === Email 白名单 ===
    getAllowedEmails(): Promise<string[]>
    getAllowedUsers(): Promise<StoredAllowedEmail[]>
    addAllowedEmail(email: string, role?: UserRole): Promise<boolean>
    updateAllowedEmailRole(email: string, role: UserRole): Promise<boolean>
    removeAllowedEmail(email: string): Promise<boolean>
    isEmailAllowed(email: string): Promise<boolean>
    getEmailRole(email: string): Promise<UserRole | null>
    getShareAllSessions(email: string): Promise<boolean>
    setShareAllSessions(email: string, enabled: boolean): Promise<boolean>
    getUsersWithShareAllSessions(): Promise<string[]>
    getViewOthersSessions(email: string): Promise<boolean>
    setViewOthersSessions(email: string, enabled: boolean): Promise<boolean>

    // === Session Shares 操作 (Keycloak用户之间的session共享) ===
    getSessionShares(sessionId: string): Promise<StoredSessionShare[]>
    addSessionShare(sessionId: string, sharedWithEmail: string, sharedByEmail: string): Promise<boolean>
    removeSessionShare(sessionId: string, sharedWithEmail: string): Promise<boolean>
    getSessionsSharedWithUser(email: string): Promise<string[]>  // 返回session IDs
    isSessionSharedWith(sessionId: string, email: string): Promise<boolean>

    // === Session Privacy Mode 操作 ===
    getSessionPrivacyMode(sessionId: string): Promise<boolean>  // 返回 true 表示私密模式
    setSessionPrivacyMode(sessionId: string, privacyMode: boolean, namespace: string): Promise<boolean>

    // === Project 操作 ===
    getProjects(machineId?: string | null, orgId?: string | null): Promise<StoredProject[]>
    getProject(id: string): Promise<StoredProject | null>
    addProject(name: string, path: string, description?: string, machineId?: string | null, orgId?: string | null): Promise<StoredProject | null>
    updateProject(id: string, fields: {
        name?: string
        path?: string
        description?: string | null
        machineId?: string | null
        orgId?: string | null
    }): Promise<StoredProject | null>
    removeProject(id: string): Promise<boolean>

    // === Role Prompt 操作 ===
    getRolePrompt(role: UserRole): Promise<string | null>
    getAllRolePrompts(): Promise<StoredRolePrompt[]>
    setRolePrompt(role: UserRole, prompt: string): Promise<boolean>
    removeRolePrompt(role: UserRole): Promise<boolean>

    // === Push Subscription 操作 ===
    getPushSubscriptions(namespace: string): Promise<StoredPushSubscription[]>
    getPushSubscriptionsByClientId(namespace: string, clientId: string): Promise<StoredPushSubscription[]>
    getPushSubscriptionsByChatId(namespace: string, chatId: string): Promise<StoredPushSubscription[]>
    getPushSubscriptionByEndpoint(endpoint: string): Promise<StoredPushSubscription | null>
    addOrUpdatePushSubscription(data: {
        namespace: string
        endpoint: string
        keys: { p256dh: string; auth: string }
        userAgent?: string
        clientId?: string
        chatId?: string
    }): Promise<StoredPushSubscription | null>
    removePushSubscription(endpoint: string): Promise<boolean>
    removePushSubscriptionById(id: number): Promise<boolean>

    // === Input Preset 操作 ===
    getAllInputPresets(orgId?: string | null): Promise<StoredInputPreset[]>
    getInputPreset(id: string): Promise<StoredInputPreset | null>
    addInputPreset(trigger: string, title: string, prompt: string, orgId?: string | null): Promise<StoredInputPreset | null>
    updateInputPreset(id: string, trigger: string, title: string, prompt: string): Promise<StoredInputPreset | null>
    removeInputPreset(id: string): Promise<boolean>

    // === Advisor State 操作 ===
    getAdvisorState(namespace: string): Promise<StoredAdvisorState | null>
    upsertAdvisorState(namespace: string, data: Partial<Omit<StoredAdvisorState, 'namespace' | 'updatedAt'>>): Promise<StoredAdvisorState | null>

    // === Agent Session State 操作 ===
    getAgentSessionState(sessionId: string): Promise<StoredAgentSessionState | null>
    getAgentSessionStatesByNamespace(namespace: string): Promise<StoredAgentSessionState[]>
    upsertAgentSessionState(sessionId: string, namespace: string, data: Partial<Omit<StoredAgentSessionState, 'sessionId' | 'namespace' | 'updatedAt'>>): Promise<StoredAgentSessionState | null>
    deleteAgentSessionState(sessionId: string): Promise<boolean>

    // === Agent Memory 操作 ===
    createAgentMemory(data: {
        namespace: string
        type: MemoryType
        contentJson: unknown
        sourceRef?: string
        confidence?: number
        expiresAt?: number
    }): Promise<StoredAgentMemory | null>
    getAgentMemory(id: number): Promise<StoredAgentMemory | null>
    getAgentMemories(namespace: string, type?: MemoryType, limit?: number): Promise<StoredAgentMemory[]>
    deleteAgentMemory(id: number): Promise<boolean>
    deleteExpiredAgentMemories(namespace: string): Promise<number>

    // === Agent Suggestion 操作 ===
    createAgentSuggestion(data: {
        namespace: string
        sessionId?: string
        sourceSessionId?: string
        title: string
        detail?: string
        category?: SuggestionCategory
        severity?: SuggestionSeverity
        confidence?: number
        targets?: string
        scope?: SuggestionScope
    }): Promise<StoredAgentSuggestion | null>
    getAgentSuggestion(id: string): Promise<StoredAgentSuggestion | null>
    getAgentSuggestions(namespace: string, filters?: {
        status?: SuggestionStatus | SuggestionStatus[]
        sessionId?: string
        sourceSessionId?: string
        limit?: number
    }): Promise<StoredAgentSuggestion[]>
    updateAgentSuggestionStatus(id: string, status: SuggestionStatus): Promise<boolean>
    deleteAgentSuggestion(id: string): Promise<boolean>

    // === Agent Feedback 操作 ===
    createAgentFeedback(data: {
        suggestionId: string
        source: FeedbackSource
        userId?: string
        action: FeedbackAction
        evidenceJson?: unknown
        comment?: string
    }): Promise<StoredAgentFeedback | null>
    getAgentFeedback(id: number): Promise<StoredAgentFeedback | null>
    getAgentFeedbackBySuggestion(suggestionId: string): Promise<StoredAgentFeedback[]>

    // === Auto-Iteration 操作 ===
    getAutoIterationConfig(namespace: string): Promise<StoredAutoIterationConfig | null>
    upsertAutoIterationConfig(namespace: string, data: {
        enabled?: boolean
        policyJson?: Partial<Record<AutoIterActionType, AutoIterExecutionPolicy>>
        allowedProjects?: string[]
        notificationLevel?: AutoIterNotificationLevel
        keepLogsDays?: number
        updatedBy?: string
    }): Promise<StoredAutoIterationConfig | null>
    createAutoIterationLog(data: {
        namespace: string
        sourceSuggestionId?: string
        sourceSessionId?: string
        projectPath?: string
        actionType: AutoIterActionType
        actionDetail?: unknown
        reason?: string
    }): Promise<StoredAutoIterationLog | null>
    getAutoIterationLog(id: string): Promise<StoredAutoIterationLog | null>
    getAutoIterationLogs(namespace: string, filters?: {
        status?: AutoIterExecutionStatus | AutoIterExecutionStatus[]
        projectPath?: string
        limit?: number
        offset?: number
    }): Promise<StoredAutoIterationLog[]>
    updateAutoIterationLog(id: string, data: {
        executionStatus?: AutoIterExecutionStatus
        approvalMethod?: AutoIterApprovalMethod
        approvedBy?: string
        approvedAt?: number
        resultJson?: unknown
        errorMessage?: string
        rollbackAvailable?: boolean
        rollbackData?: unknown
        rolledBack?: boolean
        rolledBackAt?: number
        executedAt?: number
    }): Promise<boolean>
    deleteAutoIterationLog(id: string): Promise<boolean>
    cleanupOldAutoIterationLogs(namespace: string, keepDays: number): Promise<number>
    getSessionAutoIterConfig(sessionId: string): Promise<StoredSessionAutoIterConfig | null>
    isSessionAutoIterEnabled(sessionId: string): Promise<boolean>
    setSessionAutoIterEnabled(sessionId: string, enabled: boolean): Promise<StoredSessionAutoIterConfig | null>

    // === Session Creator ChatId 操作 ===
    setSessionCreatorChatId(sessionId: string, chatId: string, namespace: string): Promise<boolean>
    getSessionCreatorChatId(sessionId: string): Promise<string | null>
    clearSessionCreatorChatId(sessionId: string, namespace: string): Promise<boolean>

    // === Session Notification Subscription 操作 ===
    subscribeToSessionNotifications(sessionId: string, chatId: string, namespace: string): Promise<StoredSessionNotificationSubscription | null>
    subscribeToSessionNotificationsByClientId(sessionId: string, clientId: string, namespace: string): Promise<StoredSessionNotificationSubscription | null>
    unsubscribeFromSessionNotifications(sessionId: string, chatId: string): Promise<boolean>
    unsubscribeFromSessionNotificationsByClientId(sessionId: string, clientId: string): Promise<boolean>
    getSessionNotificationSubscription(sessionId: string, chatId: string): Promise<StoredSessionNotificationSubscription | null>
    getSessionNotificationSubscriptionByClientId(sessionId: string, clientId: string): Promise<StoredSessionNotificationSubscription | null>
    getSessionNotificationSubscribers(sessionId: string): Promise<string[]>
    getSessionNotificationSubscriberClientIds(sessionId: string): Promise<string[]>
    getSubscribedSessionsForChat(chatId: string): Promise<string[]>
    getSubscribedSessionsForClient(clientId: string): Promise<string[]>
    getSessionNotificationRecipients(sessionId: string): Promise<string[]>
    getSessionNotificationRecipientClientIds(sessionId: string): Promise<string[]>

    // === AI Profile 操作 ===
    getAIProfiles(namespace: string): Promise<StoredAIProfile[]>
    getAIProfile(id: string): Promise<StoredAIProfile | null>
    getAIProfileByName(namespace: string, name: string): Promise<StoredAIProfile | null>
    createAIProfile(data: {
        namespace: string
        name: string
        role: AIProfileRole
        specialties?: string[]
        personality?: string | null
        greetingTemplate?: string | null
        preferredProjects?: string[]
        workStyle?: string | null
        avatarEmoji?: string
    }): Promise<StoredAIProfile | null>
    updateAIProfile(id: string, data: Partial<StoredAIProfile>): Promise<StoredAIProfile | null>
    deleteAIProfile(id: string): Promise<boolean>
    updateAIProfileStatus(id: string, status: AIProfileStatus): Promise<void>
    updateAIProfileStats(id: string, stats: Partial<StoredAIProfile['stats']>): Promise<void>

    // === AI Profile Memory 操作 ===
    createProfileMemory(data: {
        namespace: string
        profileId: string
        memoryType: AIProfileMemoryType
        content: string
        importance?: number
        expiresAt?: number | null
        metadata?: unknown | null
    }): Promise<StoredAIProfileMemory | null>
    getProfileMemories(options: {
        namespace: string
        profileId?: string
        memoryType?: AIProfileMemoryType
        minImportance?: number
        limit?: number
        includeExpired?: boolean
    }): Promise<StoredAIProfileMemory[]>
    getProfileMemory(id: string): Promise<StoredAIProfileMemory | null>
    updateMemoryAccess(namespace: string, memoryId: string): Promise<void>
    updateProfileMemory(id: string, data: {
        content?: string
        importance?: number
        expiresAt?: number | null
        metadata?: unknown | null
    }): Promise<StoredAIProfileMemory | null>
    deleteExpiredMemories(namespace: string): Promise<number>
    deleteProfileMemories(namespace: string, profileId: string): Promise<number>
    deleteProfileMemory(id: string): Promise<boolean>

    // === AI Team 操作 ===
    createAITeam(data: {
        namespace: string
        name: string
        description?: string | null
        focus?: string | null
        config?: Partial<StoredAITeam['config']>
    }): Promise<StoredAITeam | null>
    getAITeam(id: string): Promise<StoredAITeam | null>
    getAITeams(namespace: string): Promise<StoredAITeam[]>
    getActiveAITeams(namespace: string): Promise<StoredAITeam[]>
    updateAITeam(id: string, data: {
        name?: string
        description?: string | null
        focus?: string | null
        status?: AITeamStatus
        config?: Partial<StoredAITeam['config']>
    }): Promise<StoredAITeam | null>
    updateAITeamStats(id: string, stats: Partial<StoredAITeam['stats']>): Promise<void>
    deleteAITeam(id: string): Promise<boolean>

    // === AI Team Member 操作 ===
    addAITeamMember(data: {
        teamId: string
        profileId: string
        role?: AITeamMemberRole
        specialization?: string | null
    }): Promise<StoredAITeamMember | null>
    getAITeamMember(teamId: string, profileId: string): Promise<StoredAITeamMember | null>
    getAITeamMembers(teamId: string): Promise<StoredAITeamMember[]>
    getTeamsForProfile(profileId: string): Promise<StoredAITeam[]>
    updateTeamMemberContribution(teamId: string, profileId: string, contribution: number): Promise<void>
    updateTeamMemberRole(teamId: string, profileId: string, role: AITeamMemberRole): Promise<void>
    removeAITeamMember(teamId: string, profileId: string): Promise<boolean>

    // === AI Team Knowledge 操作 ===
    addAITeamKnowledge(data: {
        teamId: string
        namespace: string
        title: string
        content: string
        category: StoredAITeamKnowledge['category']
        contributorProfileId: string
        importance?: number
    }): Promise<StoredAITeamKnowledge | null>
    getAITeamKnowledge(id: string): Promise<StoredAITeamKnowledge | null>
    getAITeamKnowledgeList(teamId: string, options?: {
        category?: StoredAITeamKnowledge['category']
        minImportance?: number
        limit?: number
    }): Promise<StoredAITeamKnowledge[]>
    updateTeamKnowledgeAccess(id: string): Promise<void>
    deleteAITeamKnowledge(id: string): Promise<boolean>

    // === AI Team with Members 操作 ===
    getAITeamWithMembers(teamId: string): Promise<{
        team: StoredAITeam
        members: Array<StoredAITeamMember & { profile: StoredAIProfile | null }>
    } | null>

    // === Feishu Chat Session 映射 ===
    createFeishuChatSession(data: {
        feishuChatId: string
        feishuChatType: string
        sessionId: string
        namespace: string
        feishuChatName?: string | null
    }): Promise<{ feishuChatId: string; sessionId: string }>
    getFeishuChatSession(feishuChatId: string): Promise<{ feishuChatId: string; feishuChatType: string; sessionId: string; namespace: string; status: string; feishuChatName: string | null; createdAt: number; updatedAt: number; lastMessageAt: number | null } | null>
    getActiveFeishuChatSessions(): Promise<Array<{ feishuChatId: string; feishuChatType: string; sessionId: string; namespace: string; feishuChatName: string | null; state: Record<string, unknown> | null }>>
    updateFeishuChatSession(feishuChatId: string, sessionId: string, status: string): Promise<boolean>
    updateFeishuChatSessionStatus(feishuChatId: string, status: string): Promise<boolean>
    touchFeishuChatSession(feishuChatId: string): Promise<boolean>
    updateFeishuChatState(feishuChatId: string, state: Record<string, unknown>): Promise<boolean>
    deleteFeishuChatSession(feishuChatId: string): Promise<boolean>

    // === 飞书消息持久化（单聊+群聊） ===
    saveFeishuChatMessage(data: {
        chatId: string
        messageId: string
        senderOpenId: string
        senderName: string
        messageType: string
        content: string
    }): Promise<void>
    getFeishuChatMessages(chatId: string, limit?: number, beforeTs?: number): Promise<Array<{
        messageId: string
        senderOpenId: string
        senderName: string
        messageType: string
        content: string
        createdAt: number
    }>>
    cleanOldFeishuChatMessages(olderThanMs: number): Promise<number>

    // === Brain Config ===
    getBrainConfig(namespace: string): Promise<StoredBrainConfig | null>
    setBrainConfig(namespace: string, config: {
        agent: BrainAgent
        claudeModelMode?: string
        codexModel?: string
        extra?: Record<string, unknown>
        updatedBy?: string | null
    }): Promise<StoredBrainConfig>

    // === Org License 操作 ===
    getOrgLicense(orgId: string): Promise<StoredOrgLicense | null>
    getAllOrgLicenses(): Promise<StoredAdminOrgLicense[]>
    upsertOrgLicense(data: {
        orgId: string
        startsAt: number
        expiresAt: number
        maxMembers: number
        maxConcurrentSessions?: number | null
        status?: LicenseStatus
        issuedBy: string
        note?: string | null
    }): Promise<StoredOrgLicense>
    updateOrgLicenseStatus(orgId: string, status: LicenseStatus): Promise<boolean>
    deleteOrgLicense(orgId: string): Promise<boolean>

    // === Organization 操作 ===
    createOrganization(data: { name: string; slug: string; createdBy: string }): Promise<StoredOrganization | null>
    getOrganization(id: string): Promise<StoredOrganization | null>
    getOrganizationBySlug(slug: string): Promise<StoredOrganization | null>
    getAllOrganizations(): Promise<StoredOrganization[]>
    getOrganizationsForUser(email: string): Promise<(StoredOrganization & { myRole: OrgRole })[]>
    updateOrganization(id: string, data: { name?: string; settings?: Record<string, unknown> }): Promise<StoredOrganization | null>
    deleteOrganization(id: string): Promise<boolean>

    // === Org Member 操作 ===
    addOrgMember(data: { orgId: string; userEmail: string; userId: string; role: OrgRole; invitedBy?: string }): Promise<StoredOrgMember | null>
    getOrgMembers(orgId: string): Promise<StoredOrgMember[]>
    getOrgMember(orgId: string, email: string): Promise<StoredOrgMember | null>
    updateOrgMemberRole(orgId: string, email: string, role: OrgRole): Promise<boolean>
    removeOrgMember(orgId: string, email: string): Promise<boolean>
    getUserOrgRole(orgId: string, email: string): Promise<OrgRole | null>

    // === Org Invitation 操作 ===
    createOrgInvitation(data: { orgId: string; email: string; role: OrgRole; invitedBy: string; expiresAt: number }): Promise<StoredOrgInvitation | null>
    getOrgInvitations(orgId: string): Promise<StoredOrgInvitation[]>
    getPendingInvitationsForUser(email: string): Promise<(StoredOrgInvitation & { orgName: string })[]>
    acceptOrgInvitation(id: string, userId: string, email: string): Promise<string | null>
    deleteOrgInvitation(id: string, orgId?: string): Promise<boolean>

    // === Download Files 操作 ===
    addDownloadFile(file: { sessionId: string; orgId: string | null; filename: string; mimeType: string; content: Buffer }): Promise<StoredDownloadFile>
    getDownloadFile(id: string): Promise<{ meta: StoredDownloadFile; content: Buffer } | null>
    listDownloadFiles(sessionId: string): Promise<StoredDownloadFile[]>

    // === 关闭连接 ===
    close(): Promise<void>
}

// Re-export types from types.ts for convenience
export type {
    StoredSession,
    StoredMachine,
    StoredMessage,
    StoredUser,
    StoredPushSubscription,
    StoredAdvisorState,
    StoredAgentSessionState,
    StoredAgentMemory,
    StoredAgentSuggestion,
    StoredAgentFeedback,
    StoredAutoIterationConfig,
    StoredAutoIterationLog,
    StoredSessionAutoIterConfig,
    StoredSessionNotificationSubscription,
    StoredAIProfile,
    StoredAIProfileMemory,
    StoredAITeam,
    StoredAITeamMember,
    StoredAITeamKnowledge,
    StoredProject,
    StoredRolePrompt,
    StoredInputPreset,
    StoredAllowedEmail,
    StoredOrganization,
    StoredOrgMember,
    StoredOrgInvitation,
    StoredOrgLicense,
    StoredAdminOrgLicense,
    StoredDownloadFile,
    LicenseStatus,
    OrgRole,
    UserRole,
    VersionedUpdateResult,
    SuggestionStatus,
    SuggestionCategory,
    SuggestionSeverity,
    SuggestionScope,
    MemoryType,
    FeedbackSource,
    FeedbackAction,
    AIProfileRole,
    AIProfileStatus,
    AIProfileMemoryType,
    AITeamStatus,
    AITeamMemberRole,
    AutoIterExecutionStatus,
    AutoIterActionType,
    AutoIterExecutionPolicy,
    AutoIterApprovalMethod,
    AutoIterNotificationLevel,
} from './types'
