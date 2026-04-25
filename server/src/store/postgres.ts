// PostgreSQL Store 实现
import { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import type { IStore } from './interface'
import { SESSION_SUMMARIES_DDL, SUMMARIZATION_RUNS_DDL } from './session-summaries-ddl'
import { AI_TASK_SCHEDULES_DDL, AI_TASK_RUNS_DDL, AI_TASK_INDEXES_DDL } from './ai-tasks-ddl'
import { APPROVALS_ALL_DDL } from './approvals-ddl'
import {
    ApprovalNotFoundError,
    type ApprovalRecord,
    type ApprovalAudit,
    type ApprovalMasterStatus,
    type ApprovalTxnContext,
    type ApprovalDecisionOutcome,
} from '../approvals/types'
import type {
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
    StoredSessionShare,
    StoredOrganization,
    StoredOrgMember,
    StoredOrgInvitation,
    StoredOrgLicense,
    StoredAdminOrgLicense,
    StoredDownloadFile,
    StoredPerson,
    StoredPersonIdentity,
    StoredPersonIdentityLink,
    StoredPersonIdentityAudit,
    PersonIdentityAuditAction,
    StoredCommunicationPlan,
    StoredCommunicationPlanAudit,
    CommunicationPlanPreferences,
    CommunicationPlanAuditAction,
    IdentityObservation,
    ResolvedActorContext,
    StoredBrainConfig,
    StoredUserSelfSystemConfig,
    BrainAgent,
    LicenseStatus,
    OrgRole,
    UserRole,
    VersionedUpdateResult,
    SuggestionStatus,
    MemoryType,
    AIProfileRole,
    AIProfileStatus,
    AIProfileMemoryType,
    AITeamStatus,
    AITeamMemberRole,
    AutoIterExecutionStatus,
    AutoIterApprovalMethod,
    PostgresConfig,
    SpawnAgentType,
    StoredSessionSearchMatchSource,
    StoredSessionSearchResult,
    IdentityChannel,
} from './types'
import { normalizeSessionSource } from '../sessionSourcePolicy'
import { getAllSessionOrchestrationChildSources } from '../sessionOrchestrationPolicy'
import { isAssistantOrAgentReplyMessage, isRealActivityMessage, isTurnStartUserMessage } from './messageUtils'

function parseTimestampCandidate(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) {
            return numeric
        }
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function extractMessageSourceTimestamp(value: unknown, depth = 0, seen = new Set<unknown>()): number | null {
    if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) {
        return null
    }

    seen.add(value)
    const record = value as Record<string, unknown>

    for (const key of ['timestamp', 'createdAt', 'created_at']) {
        const parsed = parseTimestampCandidate(record[key])
        if (parsed !== null) {
            return parsed
        }
    }

    for (const key of ['content', 'data', 'message', 'payload']) {
        const nested = extractMessageSourceTimestamp(record[key], depth + 1, seen)
        if (nested !== null) {
            return nested
        }
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const nested = extractMessageSourceTimestamp(item, depth + 1, seen)
            if (nested !== null) {
                return nested
            }
        }
    }

    return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as Record<string, unknown>
}

function asTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function asStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null
    }
    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
}

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&')
}

type Queryable = Pick<Pool, 'query'>

export class PostgresStore implements IStore {
    private pool: Pool

    private constructor(pool: Pool) {
        this.pool = pool
    }

    static async create(config: PostgresConfig): Promise<PostgresStore> {
        const pool = new Pool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            ssl: config.ssl,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
            statement_timeout: 30000
        })

        const store = new PostgresStore(pool)
        await store.initSchema()
        return store
    }

    private async initSchema(): Promise<void> {
        // 创建所有表
        await this.pool.query(`
            -- Sessions 表
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                namespace TEXT NOT NULL DEFAULT 'default',
                machine_id TEXT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                created_by TEXT,
                metadata JSONB,
                metadata_version INTEGER DEFAULT 1,
                agent_state JSONB,
                agent_state_version INTEGER DEFAULT 1,
                todos JSONB,
                todos_updated_at BIGINT,
                active BOOLEAN DEFAULT FALSE,
                active_at BIGINT,
                thinking BOOLEAN DEFAULT FALSE,
                thinking_at BIGINT,
                seq INTEGER DEFAULT 0,
                advisor_task_id TEXT,
                creator_chat_id TEXT,
                advisor_mode BOOLEAN DEFAULT FALSE,
                advisor_prompt_injected BOOLEAN DEFAULT FALSE,
                role_prompt_sent BOOLEAN DEFAULT FALSE,
                permission_mode TEXT,
                model_mode TEXT,
                model_reasoning_effort TEXT,
                fast_mode BOOLEAN,
                active_monitors JSONB
            );
            -- Add created_by column if not exists (migration)
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_by TEXT;
            -- Add model mode columns if not exists (migration)
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS permission_mode TEXT;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_mode TEXT;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model_reasoning_effort TEXT;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fast_mode BOOLEAN;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_reason TEXT;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_message_at BIGINT;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_monitors JSONB;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thinking BOOLEAN DEFAULT FALSE;
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS thinking_at BIGINT;
            UPDATE sessions SET last_message_at = sub.max_created
            FROM (
                SELECT session_id, MAX(created_at) AS max_created
                FROM messages
                WHERE content->>'role' IN ('user', 'agent', 'assistant')
                GROUP BY session_id
            ) sub
            WHERE sessions.id = sub.session_id AND sessions.last_message_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_sessions_last_message_at ON sessions(last_message_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);
            CREATE INDEX IF NOT EXISTS idx_sessions_flavor ON sessions((metadata->>'flavor'));
            CREATE INDEX IF NOT EXISTS idx_sessions_flavor_namespace ON sessions((metadata->>'flavor'), namespace);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_active_updated ON sessions(active, updated_at DESC) WHERE active = TRUE;

            -- Machines 表
            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                metadata JSONB,
                metadata_version INTEGER DEFAULT 1,
                daemon_state JSONB,
                daemon_state_version INTEGER DEFAULT 1,
                active BOOLEAN DEFAULT FALSE,
                active_at BIGINT,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

            -- Messages 表
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                content JSONB NOT NULL,
                created_at BIGINT NOT NULL,
                seq INTEGER NOT NULL,
                local_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            DROP INDEX IF EXISTS idx_messages_local_id;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id);

            -- Users 表
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                role TEXT NOT NULL DEFAULT 'developer',
                created_at BIGINT NOT NULL,
                UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
            CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

            -- Allowed Emails 表
            CREATE TABLE IF NOT EXISTS allowed_emails (
                id SERIAL PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL DEFAULT 'developer',
                share_all_sessions BOOLEAN NOT NULL DEFAULT TRUE,
                view_others_sessions BOOLEAN NOT NULL DEFAULT TRUE,
                created_at BIGINT NOT NULL
            );
            -- Migration: Add share_all_sessions column if not exists (default TRUE for team sharing)
            ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS share_all_sessions BOOLEAN NOT NULL DEFAULT TRUE;
            -- Migration: Add view_others_sessions column if not exists (default TRUE for viewing others' sessions)
            ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS view_others_sessions BOOLEAN NOT NULL DEFAULT TRUE;

            -- Session Shares 表 (Keycloak用户之间的session共享)
            CREATE TABLE IF NOT EXISTS session_shares (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                shared_with_email TEXT NOT NULL,
                shared_by_email TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                UNIQUE(session_id, shared_with_email)
            );
            CREATE INDEX IF NOT EXISTS idx_session_shares_session_id ON session_shares(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_shares_shared_with ON session_shares(shared_with_email);

            -- Projects 表
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                description TEXT,
                machine_id TEXT,
                workspace_group_id TEXT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE(path, machine_id)
            );
            -- Migration: Add machine_id column if not exists (for existing databases)
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS machine_id TEXT;
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_group_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_projects_machine_id ON projects(machine_id);
            CREATE INDEX IF NOT EXISTS idx_projects_workspace_group_id ON projects(workspace_group_id);
            ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_path_machine_id_key;
            -- Drop old unique constraint on path only (if exists)
            -- Note: PostgreSQL doesn't support IF EXISTS for constraints, so we use DO block

            -- Role Prompts 表
            CREATE TABLE IF NOT EXISTS role_prompts (
                role TEXT PRIMARY KEY,
                prompt TEXT NOT NULL,
                updated_at BIGINT NOT NULL
            );

            -- Push Subscriptions 表
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id SERIAL PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                endpoint TEXT NOT NULL UNIQUE,
                keys_p256dh TEXT NOT NULL,
                keys_auth TEXT NOT NULL,
                user_agent TEXT,
                client_id TEXT,
                chat_id TEXT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_client_id ON push_subscriptions(client_id);
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_chat_id ON push_subscriptions(chat_id);

            -- Input Presets 表
            CREATE TABLE IF NOT EXISTS input_presets (
                id TEXT PRIMARY KEY,
                trigger TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                prompt TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );

            -- Advisor State 表
            CREATE TABLE IF NOT EXISTS advisor_state (
                namespace TEXT PRIMARY KEY,
                advisor_session_id TEXT,
                machine_id TEXT,
                status TEXT DEFAULT 'idle',
                last_seen BIGINT,
                config_json JSONB,
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );

            -- Agent Session State 表
            CREATE TABLE IF NOT EXISTS agent_session_state (
                session_id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                last_seq INTEGER DEFAULT 0,
                summary TEXT,
                context_json JSONB,
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_session_state_namespace ON agent_session_state(namespace);

            -- Agent Memory 表
            CREATE TABLE IF NOT EXISTS agent_memory (
                id SERIAL PRIMARY KEY,
                namespace TEXT NOT NULL,
                type TEXT NOT NULL,
                content_json JSONB NOT NULL,
                source_ref TEXT,
                confidence REAL DEFAULT 0.5,
                expires_at BIGINT,
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_memory_namespace_type ON agent_memory(namespace, type);

            -- Agent Suggestions 表
            CREATE TABLE IF NOT EXISTS agent_suggestions (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                session_id TEXT,
                source_session_id TEXT,
                title TEXT NOT NULL,
                detail TEXT,
                category TEXT,
                severity TEXT DEFAULT 'low',
                confidence REAL DEFAULT 0.5,
                status TEXT DEFAULT 'pending',
                targets TEXT,
                scope TEXT DEFAULT 'session',
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_suggestions_namespace_status ON agent_suggestions(namespace, status);
            CREATE INDEX IF NOT EXISTS idx_agent_suggestions_created ON agent_suggestions(created_at);

            -- Agent Feedback 表
            CREATE TABLE IF NOT EXISTS agent_feedback (
                id SERIAL PRIMARY KEY,
                suggestion_id TEXT NOT NULL REFERENCES agent_suggestions(id) ON DELETE CASCADE,
                source TEXT NOT NULL,
                user_id TEXT,
                action TEXT NOT NULL,
                evidence_json JSONB,
                comment TEXT,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_feedback_suggestion ON agent_feedback(suggestion_id);

            -- Auto Iteration Config 表
            CREATE TABLE IF NOT EXISTS auto_iteration_config (
                namespace TEXT PRIMARY KEY,
                enabled BOOLEAN DEFAULT FALSE,
                policy_json JSONB,
                allowed_projects JSONB DEFAULT '[]',
                notification_level TEXT DEFAULT 'all',
                keep_logs_days INTEGER DEFAULT 30,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_by TEXT
            );

            -- Auto Iteration Logs 表
            CREATE TABLE IF NOT EXISTS auto_iteration_logs (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                source_suggestion_id TEXT,
                source_session_id TEXT,
                project_path TEXT,
                action_type TEXT NOT NULL,
                action_detail JSONB,
                reason TEXT,
                execution_status TEXT DEFAULT 'pending',
                approval_method TEXT,
                approved_by TEXT,
                approved_at BIGINT,
                result_json JSONB,
                error_message TEXT,
                rollback_available BOOLEAN DEFAULT FALSE,
                rollback_data JSONB,
                rolled_back BOOLEAN DEFAULT FALSE,
                rolled_back_at BIGINT,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                executed_at BIGINT
            );
            CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_namespace ON auto_iteration_logs(namespace);
            CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_status ON auto_iteration_logs(execution_status);
            CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_created ON auto_iteration_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_auto_iteration_logs_project ON auto_iteration_logs(project_path);

            -- Session Auto Iter Config 表
            CREATE TABLE IF NOT EXISTS session_auto_iter_config (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                auto_iter_enabled BOOLEAN DEFAULT TRUE,
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );

            -- Session Notification Subscriptions 表
            CREATE TABLE IF NOT EXISTS session_notification_subscriptions (
                id SERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                chat_id TEXT,
                client_id TEXT,
                namespace TEXT NOT NULL,
                subscribed_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                UNIQUE(session_id, chat_id),
                UNIQUE(session_id, client_id)
            );
            CREATE INDEX IF NOT EXISTS idx_session_notif_sub_session ON session_notification_subscriptions(session_id);
            CREATE INDEX IF NOT EXISTS idx_session_notif_sub_chat ON session_notification_subscriptions(chat_id);
            CREATE INDEX IF NOT EXISTS idx_session_notif_sub_client ON session_notification_subscriptions(client_id);

            -- AI Profiles 表
            CREATE TABLE IF NOT EXISTS ai_profiles (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                org_id TEXT,
                name TEXT NOT NULL,
                role TEXT NOT NULL,
                specialties JSONB,
                personality TEXT,
                greeting_template TEXT,
                preferred_projects JSONB,
                work_style TEXT,
                avatar_emoji TEXT DEFAULT '🤖',
                status TEXT DEFAULT 'idle',
                stats_json JSONB,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            ALTER TABLE ai_profiles ADD COLUMN IF NOT EXISTS org_id TEXT;
            ALTER TABLE ai_profiles ADD COLUMN IF NOT EXISTS behavior_anchors JSONB NOT NULL DEFAULT '[]'::jsonb;
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_namespace ON ai_profiles(namespace);
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_org_id ON ai_profiles(org_id);
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_role ON ai_profiles(role);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_profiles_org_role_unique ON ai_profiles(org_id, role) WHERE org_id IS NOT NULL;

            -- AI Profile Memories 表
            CREATE TABLE IF NOT EXISTS ai_profile_memories (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                profile_id TEXT NOT NULL,
                memory_type TEXT NOT NULL,
                content TEXT NOT NULL,
                importance REAL DEFAULT 0.5,
                access_count INTEGER DEFAULT 0,
                last_accessed_at BIGINT,
                expires_at BIGINT,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                metadata JSONB
            );
            CREATE INDEX IF NOT EXISTS idx_ai_profile_memories_namespace ON ai_profile_memories(namespace);
            CREATE INDEX IF NOT EXISTS idx_ai_profile_memories_profile ON ai_profile_memories(profile_id);
            CREATE INDEX IF NOT EXISTS idx_ai_profile_memories_type ON ai_profile_memories(memory_type);
            CREATE INDEX IF NOT EXISTS idx_ai_profile_memories_importance ON ai_profile_memories(importance);
            CREATE INDEX IF NOT EXISTS idx_ai_profile_memories_expires ON ai_profile_memories(expires_at);

            -- AI Teams 表
            CREATE TABLE IF NOT EXISTS ai_teams (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                focus TEXT,
                status TEXT DEFAULT 'active',
                config_json JSONB,
                stats_json JSONB,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_ai_teams_namespace ON ai_teams(namespace);
            CREATE INDEX IF NOT EXISTS idx_ai_teams_status ON ai_teams(status);

            -- AI Team Members 表
            CREATE TABLE IF NOT EXISTS ai_team_members (
                team_id TEXT NOT NULL REFERENCES ai_teams(id) ON DELETE CASCADE,
                profile_id TEXT NOT NULL REFERENCES ai_profiles(id) ON DELETE CASCADE,
                role TEXT DEFAULT 'member',
                joined_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                contribution INTEGER DEFAULT 0,
                specialization TEXT,
                PRIMARY KEY (team_id, profile_id)
            );
            CREATE INDEX IF NOT EXISTS idx_ai_team_members_profile ON ai_team_members(profile_id);

            -- AI Team Knowledge 表
            CREATE TABLE IF NOT EXISTS ai_team_knowledge (
                id TEXT PRIMARY KEY,
                team_id TEXT NOT NULL REFERENCES ai_teams(id) ON DELETE CASCADE,
                namespace TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL,
                contributor_profile_id TEXT NOT NULL,
                importance REAL DEFAULT 0.5,
                access_count INTEGER DEFAULT 0,
                created_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_ai_team_knowledge_team ON ai_team_knowledge(team_id);
            CREATE INDEX IF NOT EXISTS idx_ai_team_knowledge_category ON ai_team_knowledge(category);
            CREATE INDEX IF NOT EXISTS idx_ai_team_knowledge_importance ON ai_team_knowledge(importance);

            -- Drop brain tables (brain module removed)
            DROP TABLE IF EXISTS brain_executions CASCADE;
            DROP TABLE IF EXISTS brain_rounds CASCADE;
            DROP TABLE IF EXISTS brain_sessions CASCADE;

            -- Feishu Chat Sessions 映射表
            CREATE TABLE IF NOT EXISTS feishu_chat_sessions (
                id SERIAL PRIMARY KEY,
                feishu_chat_id TEXT NOT NULL UNIQUE,
                feishu_chat_type TEXT NOT NULL,
                session_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                status TEXT NOT NULL DEFAULT 'active',
                created_at BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_at BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                last_message_at BIGINT,
                feishu_chat_name TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_chat_sessions_session ON feishu_chat_sessions(session_id);
            CREATE INDEX IF NOT EXISTS idx_feishu_chat_sessions_status ON feishu_chat_sessions(status);

            -- Migration: add state JSONB column for runtime state persistence
            ALTER TABLE feishu_chat_sessions ADD COLUMN IF NOT EXISTS state JSONB DEFAULT '{}';

            -- 飞书消息持久化（单聊+群聊）
            CREATE TABLE IF NOT EXISTS feishu_chat_messages (
                id SERIAL PRIMARY KEY,
                chat_id TEXT NOT NULL,
                message_id TEXT NOT NULL UNIQUE,
                sender_open_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                message_type TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL,
                created_at BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
            );
            CREATE INDEX IF NOT EXISTS idx_fcm_chat_id_created ON feishu_chat_messages(chat_id, created_at DESC);

            -- Brain Config 表（K1 配置，独立于 IM 平台）
            CREATE TABLE IF NOT EXISTS brain_config (
                namespace TEXT PRIMARY KEY,
                org_id TEXT,
                agent TEXT NOT NULL DEFAULT 'claude',
                claude_model_mode TEXT NOT NULL DEFAULT 'opus',
                codex_model TEXT NOT NULL DEFAULT 'gpt-5.4',
                extra JSONB DEFAULT '{}',
                updated_at BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_by TEXT
            );
            ALTER TABLE brain_config ADD COLUMN IF NOT EXISTS org_id TEXT;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_config_org_id_unique ON brain_config(org_id) WHERE org_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS user_self_system_settings (
                org_id TEXT NOT NULL,
                user_email TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT false,
                default_profile_id TEXT,
                memory_provider TEXT NOT NULL DEFAULT 'yoho-memory',
                updated_at BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
                updated_by TEXT,
                PRIMARY KEY (org_id, user_email)
            );
            CREATE INDEX IF NOT EXISTS idx_user_self_system_profile_id ON user_self_system_settings(default_profile_id);

            -- Organizations 表
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                created_by TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                settings JSONB DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

            -- Org Members 表
            CREATE TABLE IF NOT EXISTS org_members (
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                user_email TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                joined_at BIGINT NOT NULL,
                invited_by TEXT,
                PRIMARY KEY (org_id, user_email)
            );
            CREATE INDEX IF NOT EXISTS idx_org_members_email ON org_members(user_email);
            CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);

            -- Org Invitations 表
            CREATE TABLE IF NOT EXISTS org_invitations (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                invited_by TEXT NOT NULL,
                created_at BIGINT NOT NULL,
                expires_at BIGINT NOT NULL,
                accepted_at BIGINT,
                UNIQUE(org_id, email)
            );
            CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON org_invitations(email);

            -- Org Licenses 表
            CREATE TABLE IF NOT EXISTS org_licenses (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
                starts_at BIGINT NOT NULL,
                expires_at BIGINT NOT NULL,
                max_members INT NOT NULL DEFAULT 5,
                max_concurrent_sessions INT,
                status TEXT NOT NULL DEFAULT 'active',
                issued_by TEXT NOT NULL,
                note TEXT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );

            -- Identity Graph: Persons
            CREATE TABLE IF NOT EXISTS persons (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                person_type TEXT NOT NULL DEFAULT 'human',
                status TEXT NOT NULL DEFAULT 'active',
                canonical_name TEXT,
                primary_email TEXT,
                employee_code TEXT,
                avatar_url TEXT,
                attributes JSONB NOT NULL DEFAULT '{}',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                created_by TEXT,
                merged_into_person_id TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_persons_namespace_org ON persons(namespace, org_id);
            CREATE INDEX IF NOT EXISTS idx_persons_primary_email ON persons(namespace, org_id, primary_email);
            CREATE INDEX IF NOT EXISTS idx_persons_employee_code ON persons(namespace, org_id, employee_code);

            -- Identity Graph: Channel identities
            CREATE TABLE IF NOT EXISTS person_identities (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                channel TEXT NOT NULL,
                provider_tenant_id TEXT,
                external_id TEXT NOT NULL,
                secondary_id TEXT,
                account_type TEXT NOT NULL DEFAULT 'human',
                assurance TEXT NOT NULL DEFAULT 'medium',
                canonical_email TEXT,
                display_name TEXT,
                login_name TEXT,
                employee_code TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                attributes JSONB NOT NULL DEFAULT '{}',
                first_seen_at BIGINT NOT NULL,
                last_seen_at BIGINT NOT NULL,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE(channel, provider_tenant_id, external_id)
            );
            CREATE INDEX IF NOT EXISTS idx_person_identities_namespace_org ON person_identities(namespace, org_id);
            CREATE INDEX IF NOT EXISTS idx_person_identities_email ON person_identities(namespace, org_id, canonical_email);
            CREATE INDEX IF NOT EXISTS idx_person_identities_employee_code ON person_identities(namespace, org_id, employee_code);

            -- Identity Graph: Person <-> identity links
            CREATE TABLE IF NOT EXISTS person_identity_links (
                id TEXT PRIMARY KEY,
                person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
                identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
                relation_type TEXT NOT NULL DEFAULT 'primary',
                state TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 0,
                source TEXT NOT NULL,
                evidence JSONB NOT NULL DEFAULT '[]',
                decision_reason TEXT,
                valid_from BIGINT NOT NULL,
                valid_to BIGINT,
                decided_by TEXT,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_person_identity_link
                ON person_identity_links(identity_id, relation_type)
                WHERE valid_to IS NULL AND state IN ('auto_verified', 'admin_verified');
            CREATE INDEX IF NOT EXISTS idx_person_identity_links_person ON person_identity_links(person_id);

            -- Identity Graph: governance audit trail for merge/unmerge/detach
            -- (admin actions on persons + identity links). NOT for approval
            -- candidates — those moved to the unified Approvals Engine.
            CREATE TABLE IF NOT EXISTS person_identity_audits (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                action TEXT NOT NULL,
                actor_email TEXT,
                person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
                target_person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
                identity_id TEXT REFERENCES person_identities(id) ON DELETE SET NULL,
                link_id TEXT REFERENCES person_identity_links(id) ON DELETE SET NULL,
                reason TEXT,
                payload JSONB NOT NULL DEFAULT '{}',
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_person_identity_audits_scope
                ON person_identity_audits(namespace, org_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_person_identity_audits_person
                ON person_identity_audits(person_id, target_person_id);
            CREATE INDEX IF NOT EXISTS idx_person_identity_audits_identity
                ON person_identity_audits(identity_id);

            -- Communication Plan (Phase 3A): per-person reply preferences
            CREATE TABLE IF NOT EXISTS communication_plans (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
                preferences JSONB NOT NULL DEFAULT '{}',
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                version INTEGER NOT NULL DEFAULT 1,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                updated_by TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_communication_plans_person
                ON communication_plans(namespace, COALESCE(org_id, ''), person_id);
            CREATE INDEX IF NOT EXISTS idx_communication_plans_scope
                ON communication_plans(namespace, org_id);

            CREATE TABLE IF NOT EXISTS communication_plan_audits (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                plan_id TEXT NOT NULL REFERENCES communication_plans(id) ON DELETE CASCADE,
                person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
                action TEXT NOT NULL,
                prior_preferences JSONB,
                new_preferences JSONB,
                prior_enabled BOOLEAN,
                new_enabled BOOLEAN,
                actor_email TEXT,
                reason TEXT,
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_communication_plan_audits_plan
                ON communication_plan_audits(plan_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_communication_plan_audits_person
                ON communication_plan_audits(person_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_communication_plan_audits_scope
                ON communication_plan_audits(namespace, org_id, created_at DESC);

            -- Phase 3 candidate tables (memory_conflict / team_memory /
            -- observation / person_identity_candidates) were merged into the
            -- unified Approvals Engine — see store/approvals-ddl.ts and the
            -- 2026-04-25 cutover note in docs/design/unified-approvals-engine.md.

            -- Migration: Add org_id to projects
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);
            DROP INDEX IF EXISTS idx_projects_shared_org_path_unique;
            DROP INDEX IF EXISTS idx_projects_shared_org_path_group_unique;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_local_org_machine_path_unique
                ON projects ((COALESCE(org_id, '')), machine_id, path)
                WHERE machine_id IS NOT NULL;

            -- Migration: Add org_id to input_presets
            ALTER TABLE input_presets ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_input_presets_org_id ON input_presets(org_id);

            -- Migration: Add org_id to sessions
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_sessions_org_id ON sessions(org_id);


            -- Migration: Add org_id to machines
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
            CREATE INDEX IF NOT EXISTS idx_machines_org_id ON machines(org_id);

            -- Session Downloads 表
            CREATE TABLE IF NOT EXISTS session_downloads (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                session_id TEXT NOT NULL,
                org_id TEXT,
                filename TEXT NOT NULL,
                mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                content BYTEA NOT NULL,
                size INTEGER NOT NULL,
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_session_downloads_session_id ON session_downloads(session_id);

            -- Migration: Add supported_agents to machines (admin-managed, not overwritten by daemon heartbeat)
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS supported_agents JSONB;

        `)

        await this.pool.query(SESSION_SUMMARIES_DDL)
        await this.pool.query(SUMMARIZATION_RUNS_DDL)
        await this.pool.query(AI_TASK_SCHEDULES_DDL)
        await this.pool.query(AI_TASK_RUNS_DDL)
        await this.pool.query(AI_TASK_INDEXES_DDL)
        await this.pool.query(APPROVALS_ALL_DDL)
    }

    // ========== Session 操作 ==========

    async getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, orgId: string): Promise<StoredSession> {
        const now = Date.now()
        const id = tag
        const result = await this.pool.query(`
            INSERT INTO sessions (
                id, tag, namespace, org_id, machine_id, created_at, updated_at,
                metadata, metadata_version,
                agent_state, agent_state_version,
                todos, todos_updated_at,
                active, active_at, seq
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            ON CONFLICT (id) DO UPDATE SET updated_at = $7
            RETURNING *
        `, [
            id, tag, orgId, orgId, null, now, now,
            metadata ? JSON.stringify(metadata) : null, 1,
            agentState ? JSON.stringify(agentState) : null, 1,
            null, null,
            true, now, 0  // 新 session 默认 active=true，这样心跳不会被归档检查阻止
        ])
        return this.toStoredSession(result.rows[0])
    }

    async updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number, orgId: string): Promise<VersionedUpdateResult<unknown | null>> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const result = await client.query(`
                UPDATE sessions
                SET metadata = $1,
                    metadata_version = metadata_version + 1,
                    updated_at = $2,
                    seq = seq + 1
                WHERE id = $3 AND org_id = $4 AND metadata_version = $5
                RETURNING metadata_version
            `, [JSON.stringify(metadata), Date.now(), id, orgId, expectedVersion])

            if (result.rowCount === 1) {
                await client.query('COMMIT')
                return { result: 'success', version: expectedVersion + 1, value: metadata }
            }

            const current = await client.query(
                'SELECT metadata, metadata_version FROM sessions WHERE id = $1 AND org_id = $2',
                [id, orgId]
            )
            await client.query('COMMIT')

            if (current.rows.length === 0) {
                return { result: 'error' }
            }

            return {
                result: 'version-mismatch',
                version: current.rows[0].metadata_version,
                value: current.rows[0].metadata
            }
        } catch {
            try { await client.query('ROLLBACK') } catch {}
            return { result: 'error' }
        } finally {
            client.release()
        }
    }

    async updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number, orgId: string): Promise<VersionedUpdateResult<unknown | null>> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const result = await client.query(`
                UPDATE sessions
                SET agent_state = $1,
                    agent_state_version = agent_state_version + 1,
                    updated_at = $2,
                    seq = seq + 1
                WHERE id = $3 AND org_id = $4 AND agent_state_version = $5
                RETURNING agent_state_version
            `, [JSON.stringify(agentState), Date.now(), id, orgId, expectedVersion])

            if (result.rowCount === 1) {
                await client.query('COMMIT')
                return { result: 'success', version: expectedVersion + 1, value: agentState }
            }

            const current = await client.query(
                'SELECT agent_state, agent_state_version FROM sessions WHERE id = $1 AND org_id = $2',
                [id, orgId]
            )
            await client.query('COMMIT')

            if (current.rows.length === 0) {
                return { result: 'error' }
            }

            return {
                result: 'version-mismatch',
                version: current.rows[0].agent_state_version,
                value: current.rows[0].agent_state
            }
        } catch {
            try { await client.query('ROLLBACK') } catch {}
            return { result: 'error' }
        } finally {
            client.release()
        }
    }

    async setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions
            SET todos = $1, todos_updated_at = $2, updated_at = $3, seq = seq + 1
            WHERE id = $4 AND org_id = $5
        `, [JSON.stringify(todos), todosUpdatedAt, Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionAdvisorTaskId(id: string, advisorTaskId: string, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET advisor_task_id = $1, updated_at = $2 WHERE id = $3 AND org_id = $4
        `, [advisorTaskId, Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionAdvisorMode(id: string, advisorMode: boolean, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET advisor_mode = $1, updated_at = $2 WHERE id = $3 AND org_id = $4
        `, [advisorMode, Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionAdvisorPromptInjected(id: string, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET advisor_prompt_injected = TRUE, updated_at = $1 WHERE id = $2 AND org_id = $3
        `, [Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    async shouldInjectAdvisorPrompt(id: string): Promise<boolean> {
        const result = await this.pool.query(
            'SELECT advisor_mode, advisor_prompt_injected FROM sessions WHERE id = $1',
            [id]
        )
        if (result.rows.length === 0) return false
        const row = result.rows[0]
        return row.advisor_mode === true && row.advisor_prompt_injected !== true
    }

    async isRolePromptSent(id: string): Promise<boolean> {
        const result = await this.pool.query('SELECT role_prompt_sent FROM sessions WHERE id = $1', [id])
        return result.rows.length > 0 && result.rows[0].role_prompt_sent === true
    }

    async setSessionRolePromptSent(id: string, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET role_prompt_sent = TRUE, updated_at = $1 WHERE id = $2 AND org_id = $3
        `, [Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionCreatedBy(id: string, email: string, orgId: string): Promise<boolean> {
        // 只在 created_by 为空时设置，避免覆盖已有的创建者信息
        const result = await this.pool.query(`
            UPDATE sessions SET created_by = $1, updated_at = $2
            WHERE id = $3 AND org_id = $4 AND created_by IS NULL
        `, [email, Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionOrgId(id: string, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET org_id = $1, namespace = $1, updated_at = $2
            WHERE id = $3 AND org_id IS NULL
        `, [orgId, Date.now(), id])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionActive(id: string, active: boolean, activeAt: number, orgId: string, terminationReason?: string | null): Promise<boolean> {
        const result = terminationReason === undefined
            ? await this.pool.query(`
                UPDATE sessions SET active = $1, active_at = $2
                WHERE id = $3 AND org_id = $4
            `, [active, activeAt, id, orgId])
            : terminationReason === null
                ? await this.pool.query(`
                    UPDATE sessions SET active = $1, active_at = $2, termination_reason = NULL
                    WHERE id = $3 AND org_id = $4
                `, [active, activeAt, id, orgId])
                : await this.pool.query(`
                    UPDATE sessions SET active = $1, active_at = $2, termination_reason = $5
                    WHERE id = $3 AND org_id = $4
                `, [active, activeAt, id, orgId, terminationReason])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionThinking(id: string, thinking: boolean, orgId: string): Promise<void> {
        await this.pool.query(`
            UPDATE sessions
            SET thinking = $1, thinking_at = $2
            WHERE id = $3 AND org_id = $4
        `, [thinking, Date.now(), id, orgId])
    }

    async getTurnBoundary(sessionId: string): Promise<{ turnStartSeq: number; turnEndSeq: number } | null> {
        const userResult = await this.pool.query(`
            SELECT seq, content
            FROM messages
            WHERE session_id = $1
              AND content->>'role' = 'user'
            ORDER BY seq DESC
            LIMIT 50
        `, [sessionId])

        let turnStartSeq: number | null = null
        for (const row of userResult.rows as Array<{ seq: number; content: unknown }>) {
            if (!isTurnStartUserMessage(row.content)) {
                continue
            }
            turnStartSeq = Number(row.seq)
            break
        }

        if (turnStartSeq == null) {
            return null
        }

        const tailResult = await this.pool.query(`
            SELECT seq, content
            FROM messages
            WHERE session_id = $1
              AND seq >= $2
            ORDER BY seq ASC
        `, [sessionId, turnStartSeq])

        let turnEndSeq = Number(turnStartSeq)
        let hasAssistantOrAgentReply = false
        for (const row of tailResult.rows) {
            if (isAssistantOrAgentReplyMessage(row.content)) {
                hasAssistantOrAgentReply = true
            }
            if (!isRealActivityMessage(row.content)) {
                continue
            }
            turnEndSeq = Number(row.seq)
        }

        if (!hasAssistantOrAgentReply || turnEndSeq <= Number(turnStartSeq)) {
            return null
        }

        return {
            turnStartSeq: Number(turnStartSeq),
            turnEndSeq
        }
    }

    async setSessionModelConfig(id: string, config: {
        permissionMode?: string
        modelMode?: string
        modelReasoningEffort?: string
        fastMode?: boolean
    }, orgId: string): Promise<boolean> {
        const updates: string[] = []
        const values: any[] = []
        let paramIndex = 1

        if (config.permissionMode !== undefined) {
            updates.push(`permission_mode = $${paramIndex++}`)
            values.push(config.permissionMode)
        }
        if (config.modelMode !== undefined) {
            updates.push(`model_mode = $${paramIndex++}`)
            values.push(config.modelMode)
        }
        if (config.modelReasoningEffort !== undefined) {
            updates.push(`model_reasoning_effort = $${paramIndex++}`)
            values.push(config.modelReasoningEffort)
        }
        if (config.fastMode !== undefined) {
            updates.push(`fast_mode = $${paramIndex++}`)
            values.push(config.fastMode)
        }

        if (updates.length === 0) {
            return true  // Nothing to update
        }

        updates.push(`updated_at = $${paramIndex++}`)
        values.push(Date.now())

        values.push(id)
        values.push(orgId)

        const result = await this.pool.query(`
            UPDATE sessions SET ${updates.join(', ')}
            WHERE id = $${paramIndex} AND org_id = $${paramIndex + 1}
        `, values)
        return (result.rowCount ?? 0) > 0
    }

    async setSessionActiveMonitors(id: string, activeMonitors: unknown, orgId: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions
            SET active_monitors = $1, updated_at = $2, seq = seq + 1
            WHERE id = $3 AND org_id = $4
        `, [
            JSON.stringify(activeMonitors),
            Date.now(),
            id,
            orgId
        ])
        return (result.rowCount ?? 0) > 0
    }

    async getSession(id: string): Promise<StoredSession | null> {
        const result = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredSession(result.rows[0]) : null
    }

    async getSessionByOrg(id: string, orgId: string): Promise<StoredSession | null> {
        const result = await this.pool.query('SELECT * FROM sessions WHERE id = $1 AND org_id = $2', [id, orgId])
        return result.rows.length > 0 ? this.toStoredSession(result.rows[0]) : null
    }

    async getSessionByNamespace(id: string, namespace: string): Promise<StoredSession | null> {
        return await this.getSessionByOrg(id, namespace)
    }

    async getSessions(orgId?: string | null): Promise<StoredSession[]> {
        if (orgId) {
            const result = await this.pool.query(
                'SELECT * FROM sessions WHERE org_id = $1 ORDER BY COALESCE(last_message_at, updated_at) DESC',
                [orgId]
            )
            return result.rows.map(row => this.toStoredSession(row))
        }
        const result = await this.pool.query('SELECT * FROM sessions ORDER BY COALESCE(last_message_at, updated_at) DESC')
        return result.rows.map(row => this.toStoredSession(row))
    }

    async getSessionsByOrg(orgId: string): Promise<StoredSession[]> {
        const result = await this.pool.query('SELECT * FROM sessions WHERE org_id = $1 ORDER BY COALESCE(last_message_at, updated_at) DESC', [orgId])
        return result.rows.map(row => this.toStoredSession(row))
    }

    async getSessionsByNamespace(namespace: string): Promise<StoredSession[]> {
        return await this.getSessionsByOrg(namespace)
    }

    async searchSessionHistory(input: {
        orgId?: string
        namespace?: string
        query: string
        limit: number
        includeOffline?: boolean
        mainSessionId?: string
        directory?: string
        flavor?: string
        source?: string
    }): Promise<StoredSessionSearchResult[]> {
        const normalizedQuery = input.query.trim().toLowerCase()
        if (!normalizedQuery) {
            return []
        }

        const tokens = Array.from(new Set(
            normalizedQuery
                .split(/[\s,，/|:_-]+/)
                .map(token => token.trim())
                .filter(token => token.length >= 2)
        )).slice(0, 8)
        const patternTerms = Array.from(new Set([normalizedQuery, ...tokens]))
        const patterns = patternTerms.map(term => `%${escapeLikePattern(term)}%`)

        const effectiveOrgId = input.orgId ?? input.namespace
        if (!effectiveOrgId) {
            return []
        }

        const conditions = ['s.org_id = $1']
        const params: unknown[] = [effectiveOrgId]
        let paramIndex = params.length + 1

        if (!input.includeOffline) {
            conditions.push('s.active = true')
        }
        if (input.mainSessionId) {
            const childSourceList = getAllSessionOrchestrationChildSources()
                .map((source) => `'${source}'`)
                .join(', ')
            conditions.push(`LOWER(COALESCE(s.metadata->>'source', '')) IN (${childSourceList})`)
            conditions.push(`s.metadata->>'mainSessionId' = $${paramIndex++}`)
            params.push(input.mainSessionId)
        }
        if (input.directory) {
            conditions.push(`s.metadata->>'path' = $${paramIndex++}`)
            params.push(input.directory)
        }
        if (input.flavor) {
            conditions.push(`COALESCE(s.metadata->>'flavor', 'claude') = $${paramIndex++}`)
            params.push(input.flavor)
        }
        if (input.source) {
            conditions.push(`LOWER(COALESCE(s.metadata->>'source', '')) = $${paramIndex++}`)
            params.push(normalizeSessionSource(input.source) ?? input.source.trim().toLowerCase())
        }

        const patternParam = paramIndex++
        params.push(patterns)
        conditions.push(`(
            LOWER(COALESCE(s.metadata->>'brainSummary', '')) LIKE ANY($${patternParam})
            OR LOWER(COALESCE(s.metadata->'summary'->>'text', '')) LIKE ANY($${patternParam})
            OR LOWER(COALESCE(s.metadata->>'path', '')) LIKE ANY($${patternParam})
            OR matched_summary.summary IS NOT NULL
        )`)

        const limitParam = paramIndex++
        params.push(Math.max(input.limit * 8, 24))

        const result = await this.pool.query(`
            SELECT
                s.*,
                matched_summary.summary AS matched_summary,
                matched_summary.created_at AS matched_summary_created_at,
                matched_summary.seq_start AS matched_summary_seq_start,
                matched_summary.seq_end AS matched_summary_seq_end
            FROM sessions s
            LEFT JOIN LATERAL (
                SELECT
                    ss.summary,
                    ss.created_at,
                    ss.seq_start,
                    ss.seq_end
                FROM session_summaries ss
                WHERE ss.session_id = s.id
                  AND ss.namespace = s.namespace
                  AND ss.level = 1
                  AND LOWER(ss.summary) LIKE ANY($${patternParam})
                ORDER BY ss.created_at DESC
                LIMIT 1
            ) matched_summary ON TRUE
            WHERE ${conditions.join('\n              AND ')}
            ORDER BY COALESCE(s.last_message_at, s.updated_at) DESC
            LIMIT $${limitParam}
        `, params)

        const weightBySource: Record<StoredSessionSearchMatchSource, number> = {
            'turn-summary': 9,
            'brain-summary': 7,
            title: 5,
            path: 3,
        }

        const scoreSource = (
            text: string | null,
            source: StoredSessionSearchMatchSource
        ): { score: number; text: string | null } => {
            const normalizedText = text?.trim()
            if (!normalizedText) {
                return { score: 0, text: null }
            }
            const lower = normalizedText.toLowerCase()
            let score = 0
            if (lower.includes(normalizedQuery)) {
                score += weightBySource[source] * 10
            }
            for (const token of tokens) {
                if (lower.includes(token)) {
                    score += weightBySource[source] * 3
                }
            }
            return { score, text: normalizedText }
        }

        const ranked = result.rows.map((row) => {
            const session = this.toStoredSession(row)
            const metadata = asRecord(session.metadata)
            const title = asTrimmedString(asRecord(metadata?.summary)?.text)
            const brainSummary = asTrimmedString(metadata?.brainSummary)
            const path = asTrimmedString(metadata?.path)
            const matchedSummary = asTrimmedString(row.matched_summary)

            const candidates: Array<{
                source: StoredSessionSearchMatchSource
                text: string | null
                createdAt: number | null
                seqStart: number | null
                seqEnd: number | null
                score: number
            }> = [
                {
                    source: 'turn-summary',
                    text: matchedSummary,
                    createdAt: row.matched_summary_created_at != null ? Number(row.matched_summary_created_at) : null,
                    seqStart: row.matched_summary_seq_start != null ? Number(row.matched_summary_seq_start) : null,
                    seqEnd: row.matched_summary_seq_end != null ? Number(row.matched_summary_seq_end) : null,
                    score: scoreSource(matchedSummary, 'turn-summary').score,
                },
                {
                    source: 'brain-summary',
                    text: brainSummary,
                    createdAt: null,
                    seqStart: null,
                    seqEnd: null,
                    score: scoreSource(brainSummary, 'brain-summary').score,
                },
                {
                    source: 'title',
                    text: title,
                    createdAt: null,
                    seqStart: null,
                    seqEnd: null,
                    score: scoreSource(title, 'title').score,
                },
                {
                    source: 'path',
                    text: path,
                    createdAt: null,
                    seqStart: null,
                    seqEnd: null,
                    score: scoreSource(path, 'path').score,
                },
            ]

            const best = candidates.sort((a, b) => b.score - a.score)[0]
            return best && best.score > 0
                ? {
                    session,
                    score: best.score,
                    match: {
                        source: best.source,
                        text: best.text ?? '',
                        createdAt: best.createdAt,
                        seqStart: best.seqStart,
                        seqEnd: best.seqEnd,
                    },
                }
                : null
        }).filter((item): item is StoredSessionSearchResult => Boolean(item))

        ranked.sort((a, b) => {
            if (a.score !== b.score) {
                return b.score - a.score
            }
            if (a.session.active !== b.session.active) {
                return a.session.active ? -1 : 1
            }
            return (b.session.lastMessageAt ?? b.session.updatedAt) - (a.session.lastMessageAt ?? a.session.updatedAt)
        })

        return ranked.slice(0, input.limit)
    }

    async getSessionContextSummaries(input: {
        orgId: string
        sessionId: string
        recentL1Limit: number
        latestL2Limit: number
    }): Promise<{
        recentL1: import('./types').StoredSessionContextSummary[]
        latestL2: import('./types').StoredSessionContextSummary[]
        latestL3: import('./types').StoredSessionContextSummary | null
    }> {
        const result = await this.pool.query(
            `(
                SELECT id, level, summary, metadata, seq_start, seq_end, created_at
                FROM session_summaries
                WHERE org_id = $1 AND session_id = $2 AND level = 3
                ORDER BY created_at DESC
                LIMIT 1
            )
            UNION ALL
            (
                SELECT id, level, summary, metadata, seq_start, seq_end, created_at
                FROM session_summaries
                WHERE org_id = $1 AND session_id = $2 AND level = 2
                ORDER BY seq_start DESC NULLS LAST, created_at DESC
                LIMIT $3
            )
            UNION ALL
            (
                SELECT id, level, summary, metadata, seq_start, seq_end, created_at
                FROM session_summaries
                WHERE org_id = $1 AND session_id = $2 AND level = 1
                ORDER BY seq_start DESC NULLS LAST, created_at DESC
                LIMIT $4
            )`,
            [input.orgId, input.sessionId, input.latestL2Limit, input.recentL1Limit]
        )

        const summaries = result.rows.map((row) => {
            const metadata = row.metadata && typeof row.metadata === 'object'
                ? row.metadata as Record<string, unknown>
                : {}
            return {
                id: String(row.id),
                level: Number(row.level) as 1 | 2 | 3,
                summary: String(row.summary),
                topic: typeof metadata.topic === 'string' ? metadata.topic : null,
                seqStart: row.seq_start == null ? null : Number(row.seq_start),
                seqEnd: row.seq_end == null ? null : Number(row.seq_end),
                createdAt: Number(row.created_at),
            }
        })

        return {
            recentL1: summaries.filter((summary) => summary.level === 1),
            latestL2: summaries
                .filter((summary) => summary.level === 2)
                .sort((a, b) => (a.seqStart ?? 0) - (b.seqStart ?? 0)),
            latestL3: summaries.find((summary) => summary.level === 3) ?? null,
        }
    }

    async getActiveSessionCount(orgId: string): Promise<number> {
        const result = await this.pool.query(
            'SELECT COUNT(*) as count FROM sessions WHERE org_id = $1 AND active = true',
            [orgId]
        )
        return Number(result.rows[0]?.count ?? 0)
    }

    async deleteSession(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM sessions WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    async patchSessionMetadata(id: string, patch: Record<string, unknown>, orgId: string, expectedVersion?: number): Promise<boolean> {
        // When expectedVersion is provided, fail-fast on concurrent writes (returns false on
        // mismatch). Otherwise behave as before — best-effort blind merge. Callers in critical
        // ordering paths (archive/unarchive, lifecycle changes) should pass expectedVersion;
        // simple status patches without ordering requirements can omit it.
        if (typeof expectedVersion === 'number') {
            const result = await this.pool.query(`
                UPDATE sessions
                SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                    metadata_version = metadata_version + 1,
                    updated_at = $2,
                    seq = seq + 1
                WHERE id = $3 AND org_id = $4 AND metadata_version = $5
            `, [JSON.stringify(patch), Date.now(), id, orgId, expectedVersion])
            return (result.rowCount ?? 0) > 0
        }
        const result = await this.pool.query(`
            UPDATE sessions
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                metadata_version = metadata_version + 1,
                updated_at = $2,
                seq = seq + 1
            WHERE id = $3 AND org_id = $4
        `, [JSON.stringify(patch), Date.now(), id, orgId])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Machine 操作 ==========

    async getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown, orgId: string): Promise<StoredMachine> {
        const existing = await this.pool.query('SELECT * FROM machines WHERE id = $1 AND org_id = $2', [id, orgId])

        if (existing.rows.length > 0) {
            return this.toStoredMachine(existing.rows[0])
        }

        const now = Date.now()
        await this.pool.query(`
            INSERT INTO machines (id, namespace, org_id, created_at, updated_at, metadata, metadata_version, daemon_state, daemon_state_version, active, active_at, seq)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [id, orgId, orgId, now, now, metadata ? JSON.stringify(metadata) : null, 1, daemonState ? JSON.stringify(daemonState) : null, 1, false, null, 0])

        const result = await this.pool.query('SELECT * FROM machines WHERE id = $1', [id])
        return this.toStoredMachine(result.rows[0])
    }

    async updateMachineMetadata(id: string, metadata: unknown, expectedVersion: number, orgId: string): Promise<VersionedUpdateResult<unknown | null>> {
        // Preserve manually configured metadata fields when daemon heartbeats do not send them.
        const currentMetadata = await this.pool.query('SELECT metadata FROM machines WHERE id = $1 AND org_id = $2', [id, orgId])
        let finalMetadata = metadata

        if (currentMetadata.rows.length > 0 && metadata && typeof metadata === 'object') {
            const existing = currentMetadata.rows[0].metadata
            if (existing && typeof existing === 'object') {
                const nextMetadata = { ...metadata as Record<string, unknown> }
                for (const key of ['displayName'] as const) {
                    if (key in existing && !(key in nextMetadata)) {
                        nextMetadata[key] = (existing as Record<string, unknown>)[key]
                    }
                }
                finalMetadata = nextMetadata
            }
        }

        const result = await this.pool.query(`
            UPDATE machines SET metadata = $1, metadata_version = metadata_version + 1, updated_at = $2, seq = seq + 1
            WHERE id = $3 AND org_id = $4 AND metadata_version = $5
            RETURNING metadata_version
        `, [JSON.stringify(finalMetadata), Date.now(), id, orgId, expectedVersion])

        if ((result.rowCount ?? 0) === 1) {
            return { result: 'success', version: expectedVersion + 1, value: finalMetadata }
        }

        const current = await this.pool.query('SELECT metadata, metadata_version FROM machines WHERE id = $1 AND org_id = $2', [id, orgId])
        if (current.rows.length === 0) return { result: 'error' }
        return { result: 'version-mismatch', version: current.rows[0].metadata_version, value: current.rows[0].metadata }
    }

    async updateMachineDaemonState(id: string, daemonState: unknown, expectedVersion: number, orgId: string): Promise<VersionedUpdateResult<unknown | null>> {
        const result = await this.pool.query(`
            UPDATE machines SET daemon_state = $1, daemon_state_version = daemon_state_version + 1, updated_at = $2, seq = seq + 1
            WHERE id = $3 AND org_id = $4 AND daemon_state_version = $5
            RETURNING daemon_state_version
        `, [JSON.stringify(daemonState), Date.now(), id, orgId, expectedVersion])

        if ((result.rowCount ?? 0) === 1) {
            return { result: 'success', version: expectedVersion + 1, value: daemonState }
        }

        const current = await this.pool.query('SELECT daemon_state, daemon_state_version FROM machines WHERE id = $1 AND org_id = $2', [id, orgId])
        if (current.rows.length === 0) return { result: 'error' }
        return { result: 'version-mismatch', version: current.rows[0].daemon_state_version, value: current.rows[0].daemon_state }
    }

    async getMachine(id: string): Promise<StoredMachine | null> {
        const result = await this.pool.query('SELECT * FROM machines WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredMachine(result.rows[0]) : null
    }

    async getMachineByOrg(id: string, orgId: string): Promise<StoredMachine | null> {
        const result = await this.pool.query('SELECT * FROM machines WHERE id = $1 AND org_id = $2', [id, orgId])
        return result.rows.length > 0 ? this.toStoredMachine(result.rows[0]) : null
    }

    async getMachineByNamespace(id: string, namespace: string): Promise<StoredMachine | null> {
        return await this.getMachineByOrg(id, namespace)
    }

    async getMachines(orgId?: string | null): Promise<StoredMachine[]> {
        if (orgId) {
            const result = await this.pool.query('SELECT * FROM machines WHERE org_id = $1 ORDER BY updated_at DESC', [orgId])
            return result.rows.map(row => this.toStoredMachine(row))
        }
        const result = await this.pool.query('SELECT * FROM machines ORDER BY updated_at DESC')
        return result.rows.map(row => this.toStoredMachine(row))
    }

    async getMachinesByOrg(orgId: string): Promise<StoredMachine[]> {
        const result = await this.pool.query('SELECT * FROM machines WHERE org_id = $1 ORDER BY updated_at DESC', [orgId])
        return result.rows.map(row => this.toStoredMachine(row))
    }

    async getMachinesByNamespace(namespace: string, orgId?: string | null): Promise<StoredMachine[]> {
        return await this.getMachinesByOrg(orgId ?? namespace)
    }

    async setMachineOrgId(id: string, orgId: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE machines SET org_id = $1, namespace = $1, updated_at = $2 WHERE id = $3',
            [orgId, Date.now(), id]
        )
        return (result.rowCount ?? 0) > 0
    }

    async setMachineSupportedAgents(id: string, supportedAgents: SpawnAgentType[] | null, orgId: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE machines SET supported_agents = $1, updated_at = $2, seq = seq + 1 WHERE id = $3 AND org_id = $4',
            [supportedAgents ? JSON.stringify(supportedAgents) : null, Date.now(), id, orgId]
        )
        return (result.rowCount ?? 0) > 0
    }

    // ========== Message 操作 ==========

    async addMessage(sessionId: string, content: unknown, localId?: string): Promise<StoredMessage> {
        // Use a transaction with row-level lock to prevent race conditions
        // when multiple streaming chunks arrive simultaneously
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            // Check for duplicate localId first (outside lock is fine - it's a safety check)
            if (localId) {
                const existing = await client.query(
                    'SELECT * FROM messages WHERE session_id = $1 AND local_id = $2',
                    [sessionId, localId]
                )
                if (existing.rows.length > 0) {
                    await client.query('COMMIT')
                    return this.toStoredMessage(existing.rows[0])
                }
            }

            // Lock the session row to serialize seq assignment
            // FOR UPDATE ensures only one transaction can compute next seq at a time
            await client.query(
                'SELECT id FROM sessions WHERE id = $1 FOR UPDATE',
                [sessionId]
            )

            // Now safely get next seq - no other transaction can read/write this session's messages
            const seqResult = await client.query(
                'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE session_id = $1',
                [sessionId]
            )
            const nextSeq = seqResult.rows[0].next_seq

            const persistedAt = extractMessageSourceTimestamp(content) ?? Date.now()
            const id = randomUUID()

            const insertResult = await client.query(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (session_id, local_id) DO NOTHING
            `, [id, sessionId, JSON.stringify(content), persistedAt, nextSeq, localId || null])

            if ((insertResult.rowCount ?? 0) === 0) {
                if (localId) {
                    const existing = await client.query(
                        'SELECT * FROM messages WHERE session_id = $1 AND local_id = $2 LIMIT 1',
                        [sessionId, localId]
                    )
                    if (existing.rows.length > 0) {
                        await client.query('COMMIT')
                        return this.toStoredMessage(existing.rows[0])
                    }
                }
                throw new Error('Failed to store message')
            }

            if (isRealActivityMessage(content)) {
                await client.query(
                    'UPDATE sessions SET seq = seq + 1, updated_at = $1, last_message_at = $1 WHERE id = $2',
                    [persistedAt, sessionId]
                )
            } else {
                await client.query(
                    'UPDATE sessions SET seq = seq + 1, updated_at = $1 WHERE id = $2',
                    [persistedAt, sessionId]
                )
            }

            await client.query('COMMIT')

            const result = await this.pool.query('SELECT * FROM messages WHERE id = $1', [id])
            return this.toStoredMessage(result.rows[0])
        } catch (err) {
            try { await client.query('ROLLBACK') } catch {}
            throw err
        } finally {
            client.release()
        }
    }

    async getMessageByLocalId(sessionId: string, localId: string): Promise<StoredMessage | null> {
        const result = await this.pool.query(
            'SELECT * FROM messages WHERE session_id = $1 AND local_id = $2 LIMIT 1',
            [sessionId, localId]
        )
        const row = result.rows[0]
        return row ? this.toStoredMessage(row) : null
    }

    async getMessages(sessionId: string, limit: number = 200, beforeSeq?: number): Promise<StoredMessage[]> {
        let query = 'SELECT * FROM messages WHERE session_id = $1'
        const params: unknown[] = [sessionId]

        if (beforeSeq !== undefined) {
            query += ' AND seq < $2 ORDER BY seq DESC, created_at DESC LIMIT $3'
            params.push(beforeSeq, limit)
        } else {
            query += ' ORDER BY seq DESC, created_at DESC LIMIT $2'
            params.push(limit)
        }

        const result = await this.pool.query(query, params)
        console.log(`[DEBUG] getMessages(${sessionId.slice(0,8)}...): query=${query}, beforeSeq=${beforeSeq}`)
        console.log(`[DEBUG] DB returned ${result.rows.length} messages, first 3 rows:`)
        result.rows.slice(0, 3).forEach((row, i) => {
            console.log(`[DEBUG]   Row${i}: seq=${row.seq}, created_at=${row.created_at}, id=${row.id}`)
        })
        const reversed = result.rows.reverse().map(row => this.toStoredMessage(row))
        console.log(`[DEBUG] After reverse(), first 3 messages:`)
        reversed.slice(0, 3).forEach((msg, i) => {
            console.log(`[DEBUG]   Msg${i}: seq=${msg.seq}, createdAt=${msg.createdAt}, id=${msg.id}`)
        })
        return reversed
    }

    async getMessagesAfter(sessionId: string, afterSeq: number, limit: number = 200): Promise<StoredMessage[]> {
        const result = await this.pool.query(
            'SELECT * FROM messages WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC, created_at ASC LIMIT $3',
            [sessionId, afterSeq, limit]
        )
        return result.rows.map(row => this.toStoredMessage(row))
    }

    async getMessageCount(sessionId: string): Promise<number> {
        const result = await this.pool.query('SELECT COUNT(*) FROM messages WHERE session_id = $1', [sessionId])
        return parseInt(result.rows[0].count, 10)
    }

    async clearMessages(sessionId: string, keepCount: number = 30): Promise<{ deleted: number; remaining: number }> {
        if (keepCount <= 0) {
            const deleteResult = await this.pool.query(
                'DELETE FROM messages WHERE session_id = $1',
                [sessionId]
            )
            const deleted = deleteResult.rowCount ?? 0
            return { deleted, remaining: 0 }
        }

        const countResult = await this.pool.query('SELECT COUNT(*) FROM messages WHERE session_id = $1', [sessionId])
        const total = parseInt(countResult.rows[0].count, 10)

        if (total <= keepCount) {
            return { deleted: 0, remaining: total }
        }

        const deleteResult = await this.pool.query(`
            DELETE FROM messages WHERE session_id = $1 AND seq <= (
                SELECT seq FROM messages WHERE session_id = $1 ORDER BY seq DESC LIMIT 1 OFFSET $2
            )
        `, [sessionId, keepCount])

        const deleted = deleteResult.rowCount ?? 0
        return { deleted, remaining: total - deleted }
    }

    async getSessionParticipants(
        sessionIds: string[],
        options: { limitPerSession?: number } = {},
    ): Promise<Map<string, unknown[]>> {
        const result = new Map<string, unknown[]>()
        if (sessionIds.length === 0) return result
        const limitPerSession = Math.max(1, options.limitPerSession ?? 10)

        const rows = await this.pool.query<{
            session_id: string
            actor: unknown
        }>(
            `
            SELECT session_id, actor
            FROM (
                SELECT
                    session_id,
                    actor,
                    MAX(created_at) AS last_at
                FROM (
                    SELECT session_id, content->'meta'->'actor' AS actor, created_at
                    FROM messages
                    WHERE session_id = ANY($1::text[])
                      AND jsonb_typeof(content->'meta'->'actor') = 'object'
                    UNION ALL
                    SELECT session_id, jsonb_array_elements(content->'meta'->'actors') AS actor, created_at
                    FROM messages
                    WHERE session_id = ANY($1::text[])
                      AND jsonb_typeof(content->'meta'->'actors') = 'array'
                ) AS raw
                GROUP BY session_id, actor
            ) AS grouped
            ORDER BY session_id, last_at DESC
            `,
            [sessionIds],
        )

        const seenKeys = new Map<string, Set<string>>()
        for (const row of rows.rows) {
            if (!row.actor || typeof row.actor !== 'object') continue
            const a = row.actor as Record<string, unknown>
            const key = typeof a.identityId === 'string' && a.identityId.length > 0
                ? a.identityId
                : `${String(a.channel ?? '')}:${String(a.externalId ?? '')}`
            if (!key) continue
            let keys = seenKeys.get(row.session_id)
            if (!keys) {
                keys = new Set<string>()
                seenKeys.set(row.session_id, keys)
            }
            if (keys.has(key)) continue
            let list = result.get(row.session_id)
            if (!list) {
                list = []
                result.set(row.session_id, list)
            }
            if (list.length >= limitPerSession) continue
            keys.add(key)
            list.push(row.actor)
        }
        return result
    }

    // ========== User 操作 ==========

    async getUser(platform: string, platformUserId: string): Promise<StoredUser | null> {
        const result = await this.pool.query(
            'SELECT * FROM users WHERE platform = $1 AND platform_user_id = $2 LIMIT 1',
            [platform, platformUserId]
        )
        return result.rows.length > 0 ? this.toStoredUser(result.rows[0]) : null
    }

    async getUsersByPlatform(platform: string): Promise<StoredUser[]> {
        const result = await this.pool.query('SELECT * FROM users WHERE platform = $1', [platform])
        return result.rows.map(row => this.toStoredUser(row))
    }

    async getUsersByPlatformAndNamespace(platform: string, namespace: string): Promise<StoredUser[]> {
        const result = await this.pool.query(
            'SELECT * FROM users WHERE platform = $1 AND namespace = $2',
            [platform, namespace]
        )
        return result.rows.map(row => this.toStoredUser(row))
    }

    async addUser(platform: string, platformUserId: string, namespace: string, role: UserRole = 'developer'): Promise<StoredUser> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO users (platform, platform_user_id, namespace, role, created_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (platform, platform_user_id) DO NOTHING
        `, [platform, platformUserId, namespace, role, now])

        const result = await this.pool.query(
            'SELECT * FROM users WHERE platform = $1 AND platform_user_id = $2',
            [platform, platformUserId]
        )
        return this.toStoredUser(result.rows[0])
    }

    async updateUserRole(platform: string, platformUserId: string, role: UserRole): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE users SET role = $1 WHERE platform = $2 AND platform_user_id = $3',
            [role, platform, platformUserId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async removeUser(platform: string, platformUserId: string): Promise<boolean> {
        const result = await this.pool.query(
            'DELETE FROM users WHERE platform = $1 AND platform_user_id = $2',
            [platform, platformUserId]
        )
        return (result.rowCount ?? 0) > 0
    }

    // ========== Email 白名单 ==========

    async getAllowedEmails(): Promise<string[]> {
        const result = await this.pool.query('SELECT email FROM allowed_emails')
        return result.rows.map(row => row.email)
    }

    async getAllowedUsers(): Promise<StoredAllowedEmail[]> {
        const result = await this.pool.query('SELECT email, role, share_all_sessions, view_others_sessions, created_at FROM allowed_emails')
        return result.rows.map(row => ({
            email: row.email,
            role: row.role as UserRole,
            shareAllSessions: row.share_all_sessions ?? true,  // 默认为 true
            viewOthersSessions: row.view_others_sessions ?? true,  // 默认为 true
            createdAt: Number(row.created_at)
        }))
    }

    async addAllowedEmail(email: string, role: UserRole = 'developer'): Promise<boolean> {
        try {
            await this.pool.query(
                'INSERT INTO allowed_emails (email, role, created_at) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
                [email, role, Date.now()]
            )
            return true
        } catch {
            return false
        }
    }

    async updateAllowedEmailRole(email: string, role: UserRole): Promise<boolean> {
        const result = await this.pool.query('UPDATE allowed_emails SET role = $1 WHERE email = $2', [role, email])
        return (result.rowCount ?? 0) > 0
    }

    async removeAllowedEmail(email: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM allowed_emails WHERE email = $1', [email])
        return (result.rowCount ?? 0) > 0
    }

    async isEmailAllowed(email: string): Promise<boolean> {
        const result = await this.pool.query('SELECT 1 FROM allowed_emails WHERE email = $1 LIMIT 1', [email])
        return result.rows.length > 0
    }

    async getEmailRole(email: string): Promise<UserRole | null> {
        const result = await this.pool.query('SELECT role FROM allowed_emails WHERE email = $1', [email])
        return result.rows.length > 0 ? result.rows[0].role as UserRole : null
    }

    async getShareAllSessions(email: string): Promise<boolean> {
        const result = await this.pool.query('SELECT share_all_sessions FROM allowed_emails WHERE email = $1', [email])
        // 默认为 true（团队共享模式）
        return result.rows.length > 0 ? (result.rows[0].share_all_sessions ?? true) : true
    }

    async setShareAllSessions(email: string, enabled: boolean): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE allowed_emails SET share_all_sessions = $1 WHERE email = $2',
            [enabled, email]
        )
        return (result.rowCount ?? 0) > 0
    }

    async getUsersWithShareAllSessions(): Promise<string[]> {
        const result = await this.pool.query('SELECT email FROM allowed_emails WHERE share_all_sessions = TRUE')
        return result.rows.map(row => row.email)
    }

    async getViewOthersSessions(email: string): Promise<boolean> {
        const result = await this.pool.query('SELECT view_others_sessions FROM allowed_emails WHERE email = $1', [email])
        // 默认为 true（团队共享模式）
        return result.rows.length > 0 ? (result.rows[0].view_others_sessions ?? true) : true
    }

    async setViewOthersSessions(email: string, enabled: boolean): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE allowed_emails SET view_others_sessions = $1 WHERE email = $2',
            [enabled, email]
        )
        return (result.rowCount ?? 0) > 0
    }

    // ========== Session Shares 操作 ==========

    async getSessionShares(sessionId: string): Promise<StoredSessionShare[]> {
        const result = await this.pool.query(
            'SELECT session_id, shared_with_email, shared_by_email, created_at FROM session_shares WHERE session_id = $1',
            [sessionId]
        )
        return result.rows.map(row => ({
            sessionId: row.session_id,
            sharedWithEmail: row.shared_with_email,
            sharedByEmail: row.shared_by_email,
            createdAt: Number(row.created_at)
        }))
    }

    async addSessionShare(sessionId: string, sharedWithEmail: string, sharedByEmail: string): Promise<boolean> {
        const now = Date.now()
        try {
            await this.pool.query(
                'INSERT INTO session_shares (session_id, shared_with_email, shared_by_email, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id, shared_with_email) DO NOTHING',
                [sessionId, sharedWithEmail, sharedByEmail, now]
            )
            return true
        } catch {
            return false
        }
    }

    async removeSessionShare(sessionId: string, sharedWithEmail: string): Promise<boolean> {
        const result = await this.pool.query(
            'DELETE FROM session_shares WHERE session_id = $1 AND shared_with_email = $2',
            [sessionId, sharedWithEmail]
        )
        return (result.rowCount ?? 0) > 0
    }

    async getSessionsSharedWithUser(email: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT DISTINCT session_id FROM session_shares WHERE shared_with_email = $1',
            [email]
        )
        return result.rows.map(row => row.session_id as string)
    }

    async isSessionSharedWith(sessionId: string, email: string): Promise<boolean> {
        const result = await this.pool.query(
            'SELECT 1 FROM session_shares WHERE session_id = $1 AND shared_with_email = $2 LIMIT 1',
            [sessionId, email]
        )
        return result.rows.length > 0
    }

    // ========== Session Privacy Mode 操作 ==========

    async getSessionPrivacyMode(sessionId: string): Promise<boolean> {
        const result = await this.pool.query(
            'SELECT metadata FROM sessions WHERE id = $1',
            [sessionId]
        )
        if (result.rows.length === 0) return false
        const metadata = result.rows[0].metadata as { privacyMode?: boolean } | null
        return metadata?.privacyMode === true
    }

    async setSessionPrivacyMode(sessionId: string, privacyMode: boolean, namespace: string): Promise<boolean> {
        // 首先获取当前 session 和 metadata 版本
        const currentResult = await this.pool.query(
            'SELECT metadata, metadata_version, namespace FROM sessions WHERE id = $1',
            [sessionId]
        )
        if (currentResult.rows.length === 0) return false

        const current = currentResult.rows[0]
        if (current.namespace !== namespace) return false

        const metadata = (current.metadata as { privacyMode?: boolean } | null) || {}
        const newMetadata = { ...metadata, privacyMode }
        const expectedVersion = current.metadata_version as number

        const result = await this.pool.query(
            `UPDATE sessions
             SET metadata = $1, metadata_version = metadata_version + 1, updated_at = EXTRACT(EPOCH FROM NOW()) * 1000
             WHERE id = $2 AND metadata_version = $3
             RETURNING metadata_version`,
            [JSON.stringify(newMetadata), sessionId, expectedVersion]
        )
        return (result.rowCount ?? 0) > 0
    }

    // ========== Project 操作 ==========

    async getProjects(machineId?: string | null, orgId?: string | null): Promise<StoredProject[]> {
        const conditions: string[] = ['machine_id IS NOT NULL']
        const params: (string | null)[] = []
        let idx = 1

        if (machineId) {
            conditions.push(`machine_id = $${idx}`)
            params.push(machineId)
            idx++
        }

        if (orgId !== undefined) {
            if (orgId === null) {
                conditions.push('org_id IS NULL')
            } else {
                conditions.push(`(org_id = $${idx} OR org_id IS NULL)`)
                params.push(orgId)
                idx++
            }
        }

        let query = 'SELECT * FROM projects'
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ')
        }
        query += ' ORDER BY name'

        const result = await this.pool.query(query, params)
        return result.rows.map(row => ({
            id: row.id,
            name: row.name,
            path: row.path,
            description: row.description,
            machineId: row.machine_id as string | null,
            orgId: row.org_id as string | null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }))
    }

    async getProject(id: string): Promise<StoredProject | null> {
        const result = await this.pool.query('SELECT * FROM projects WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            id: row.id,
            name: row.name,
            path: row.path,
            description: row.description,
            machineId: row.machine_id as string | null,
            orgId: row.org_id as string | null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    async addProject(name: string, path: string, description?: string, machineId?: string | null, orgId?: string | null): Promise<StoredProject | null> {
        const id = randomUUID()
        const now = Date.now()
        const normalizedMachineId = machineId?.trim() || null
        try {
            const conflict = await this.pool.query(
                `SELECT 1
                 FROM projects
                 WHERE path = $1
                   AND machine_id IS NOT DISTINCT FROM $2
                   AND org_id IS NOT DISTINCT FROM $3
                 LIMIT 1`,
                [path, normalizedMachineId, orgId ?? null]
            )
            if (conflict.rows.length > 0) {
                return null
            }

            await this.pool.query(
                'INSERT INTO projects (id, name, path, description, machine_id, org_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                [id, name, path, description || null, normalizedMachineId, orgId || null, now, now]
            )
            return {
                id,
                name,
                path,
                description: description || null,
                machineId: normalizedMachineId,
                orgId: orgId || null,
                createdAt: now,
                updatedAt: now
            }
        } catch {
            return null
        }
    }

    async updateProject(id: string, fields: {
        name?: string
        path?: string
        description?: string | null
        machineId?: string | null
        orgId?: string | null
    }): Promise<StoredProject | null> {
        const now = Date.now()
        const current = await this.pool.query(
            'SELECT name, path, description, machine_id, org_id FROM projects WHERE id = $1',
            [id]
        )
        if (current.rows.length === 0) return null
        const cur = current.rows[0]

        const effectiveName = fields.name ?? (cur.name as string)
        const effectivePath = fields.path ?? (cur.path as string)
        const effectiveDescription = fields.description !== undefined ? (fields.description || null) : (cur.description as string | null)
        const effectiveOrgId = fields.orgId !== undefined ? fields.orgId : (cur.org_id as string | null)
        const effectiveMachineId = fields.machineId !== undefined ? (fields.machineId?.trim() || null) : (cur.machine_id as string | null)

        const conflict = await this.pool.query(
            `SELECT 1
             FROM projects
             WHERE id <> $1
               AND path = $2
               AND machine_id IS NOT DISTINCT FROM $3
               AND org_id IS NOT DISTINCT FROM $4
             LIMIT 1`,
            [id, effectivePath, effectiveMachineId, effectiveOrgId ?? null]
        )
        if (conflict.rows.length > 0) {
            return null
        }

        const result = await this.pool.query(
            'UPDATE projects SET name = $1, path = $2, description = $3, machine_id = $4, updated_at = $5 WHERE id = $6 RETURNING *',
            [effectiveName, effectivePath, effectiveDescription, effectiveMachineId, now, id]
        )
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            id: row.id,
            name: row.name,
            path: row.path,
            description: row.description,
            machineId: row.machine_id as string | null,
            orgId: row.org_id as string | null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    async removeProject(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM projects WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Role Prompt 操作 ==========

    async getRolePrompt(role: UserRole): Promise<string | null> {
        const result = await this.pool.query('SELECT prompt FROM role_prompts WHERE role = $1', [role])
        return result.rows.length > 0 ? result.rows[0].prompt : null
    }

    async getAllRolePrompts(): Promise<StoredRolePrompt[]> {
        const result = await this.pool.query('SELECT role, prompt, updated_at FROM role_prompts')
        return result.rows.map(row => ({
            role: row.role as UserRole,
            prompt: row.prompt,
            updatedAt: Number(row.updated_at)
        }))
    }

    async setRolePrompt(role: UserRole, prompt: string): Promise<boolean> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO role_prompts (role, prompt, updated_at) VALUES ($1, $2, $3)
            ON CONFLICT (role) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = EXCLUDED.updated_at
        `, [role, prompt, now])
        return true
    }

    async removeRolePrompt(role: UserRole): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM role_prompts WHERE role = $1', [role])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Push Subscription 操作 ==========

    async getPushSubscriptions(namespace: string): Promise<StoredPushSubscription[]> {
        const result = await this.pool.query(
            'SELECT * FROM push_subscriptions WHERE namespace = $1',
            [namespace]
        )
        return result.rows.map(row => this.toStoredPushSubscription(row))
    }

    async getPushSubscriptionsByClientId(namespace: string, clientId: string): Promise<StoredPushSubscription[]> {
        const result = await this.pool.query(
            'SELECT * FROM push_subscriptions WHERE namespace = $1 AND client_id = $2',
            [namespace, clientId]
        )
        return result.rows.map(row => this.toStoredPushSubscription(row))
    }

    async getPushSubscriptionsByChatId(namespace: string, chatId: string): Promise<StoredPushSubscription[]> {
        const result = await this.pool.query(
            'SELECT * FROM push_subscriptions WHERE namespace = $1 AND chat_id = $2',
            [namespace, chatId]
        )
        return result.rows.map(row => this.toStoredPushSubscription(row))
    }

    async getPushSubscriptionByEndpoint(endpoint: string): Promise<StoredPushSubscription | null> {
        const result = await this.pool.query(
            'SELECT * FROM push_subscriptions WHERE endpoint = $1',
            [endpoint]
        )
        return result.rows.length > 0 ? this.toStoredPushSubscription(result.rows[0]) : null
    }

    async addOrUpdatePushSubscription(data: {
        namespace: string
        endpoint: string
        keys: { p256dh: string; auth: string }
        userAgent?: string
        clientId?: string
        chatId?: string
    }): Promise<StoredPushSubscription | null> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO push_subscriptions (namespace, endpoint, keys_p256dh, keys_auth, user_agent, client_id, chat_id, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (endpoint) DO UPDATE SET
                keys_p256dh = EXCLUDED.keys_p256dh,
                keys_auth = EXCLUDED.keys_auth,
                user_agent = EXCLUDED.user_agent,
                client_id = EXCLUDED.client_id,
                chat_id = EXCLUDED.chat_id,
                updated_at = EXCLUDED.updated_at
        `, [data.namespace, data.endpoint, data.keys.p256dh, data.keys.auth, data.userAgent || null, data.clientId || null, data.chatId || null, now, now])

        return this.getPushSubscriptionByEndpoint(data.endpoint)
    }

    async removePushSubscription(endpoint: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint])
        return (result.rowCount ?? 0) > 0
    }

    async removePushSubscriptionById(id: number): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM push_subscriptions WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Input Preset 操作 ==========

    async getAllInputPresets(orgId?: string | null): Promise<StoredInputPreset[]> {
        let query = 'SELECT * FROM input_presets'
        const params: string[] = []

        if (orgId !== undefined && orgId !== null) {
            query += ' WHERE org_id = $1 OR org_id IS NULL'
            params.push(orgId)
        }
        query += ' ORDER BY trigger'

        const result = await this.pool.query(query, params)
        return result.rows.map(row => ({
            id: row.id,
            trigger: row.trigger,
            title: row.title,
            prompt: row.prompt,
            orgId: row.org_id as string | null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }))
    }

    async getInputPreset(id: string): Promise<StoredInputPreset | null> {
        const result = await this.pool.query('SELECT * FROM input_presets WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            id: row.id,
            trigger: row.trigger,
            title: row.title,
            prompt: row.prompt,
            orgId: row.org_id as string | null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    async addInputPreset(trigger: string, title: string, prompt: string, orgId?: string | null): Promise<StoredInputPreset | null> {
        const id = randomUUID()
        const now = Date.now()
        try {
            await this.pool.query(
                'INSERT INTO input_presets (id, trigger, title, prompt, org_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [id, trigger, title, prompt, orgId || null, now, now]
            )
            return { id, trigger, title, prompt, orgId: orgId || null, createdAt: now, updatedAt: now }
        } catch {
            return null
        }
    }

    async updateInputPreset(id: string, trigger: string, title: string, prompt: string): Promise<StoredInputPreset | null> {
        const now = Date.now()
        const result = await this.pool.query(
            'UPDATE input_presets SET trigger = $1, title = $2, prompt = $3, updated_at = $4 WHERE id = $5 RETURNING *',
            [trigger, title, prompt, now, id]
        )
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            id: row.id,
            trigger: row.trigger,
            title: row.title,
            prompt: row.prompt,
            orgId: row.org_id as string | null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    async removeInputPreset(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM input_presets WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Advisor State 操作 ==========

    async getAdvisorState(namespace: string): Promise<StoredAdvisorState | null> {
        const result = await this.pool.query('SELECT * FROM advisor_state WHERE namespace = $1', [namespace])
        if (result.rows.length === 0) return null
        return this.toStoredAdvisorState(result.rows[0])
    }

    async upsertAdvisorState(namespace: string, data: {
        advisorSessionId?: string | null
        machineId?: string | null
        status?: 'idle' | 'running' | 'error'
        lastSeen?: number | null
        configJson?: unknown | null
    }): Promise<StoredAdvisorState | null> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO advisor_state (namespace, advisor_session_id, machine_id, status, last_seen, config_json, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (namespace) DO UPDATE SET
                advisor_session_id = COALESCE(EXCLUDED.advisor_session_id, advisor_state.advisor_session_id),
                machine_id = COALESCE(EXCLUDED.machine_id, advisor_state.machine_id),
                status = COALESCE(EXCLUDED.status, advisor_state.status),
                last_seen = COALESCE(EXCLUDED.last_seen, advisor_state.last_seen),
                config_json = COALESCE(EXCLUDED.config_json, advisor_state.config_json),
                updated_at = EXCLUDED.updated_at
        `, [
            namespace,
            data.advisorSessionId ?? null,
            data.machineId ?? null,
            data.status ?? 'idle',
            data.lastSeen ?? null,
            data.configJson ? JSON.stringify(data.configJson) : null,
            now
        ])

        return this.getAdvisorState(namespace)
    }

    // ========== Agent Session State 操作 ==========

    async getAgentSessionState(sessionId: string): Promise<StoredAgentSessionState | null> {
        const result = await this.pool.query('SELECT * FROM agent_session_state WHERE session_id = $1', [sessionId])
        if (result.rows.length === 0) return null
        return this.toStoredAgentSessionState(result.rows[0])
    }

    async getAgentSessionStatesByNamespace(namespace: string): Promise<StoredAgentSessionState[]> {
        const result = await this.pool.query('SELECT * FROM agent_session_state WHERE namespace = $1', [namespace])
        return result.rows.map(row => this.toStoredAgentSessionState(row))
    }

    async upsertAgentSessionState(sessionId: string, namespace: string, data: {
        lastSeq?: number
        summary?: string | null
        contextJson?: unknown | null
    }): Promise<StoredAgentSessionState | null> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO agent_session_state (session_id, namespace, last_seq, summary, context_json, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (session_id) DO UPDATE SET
                last_seq = COALESCE(EXCLUDED.last_seq, agent_session_state.last_seq),
                summary = COALESCE(EXCLUDED.summary, agent_session_state.summary),
                context_json = COALESCE(EXCLUDED.context_json, agent_session_state.context_json),
                updated_at = EXCLUDED.updated_at
        `, [
            sessionId,
            namespace,
            data.lastSeq ?? 0,
            data.summary ?? null,
            data.contextJson ? JSON.stringify(data.contextJson) : null,
            now
        ])

        return this.getAgentSessionState(sessionId)
    }

    async deleteAgentSessionState(sessionId: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM agent_session_state WHERE session_id = $1', [sessionId])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Agent Memory 操作 ==========

    async createAgentMemory(data: {
        namespace: string
        type: MemoryType
        contentJson: unknown
        sourceRef?: string | null
        confidence?: number
        expiresAt?: number | null
    }): Promise<StoredAgentMemory | null> {
        const now = Date.now()
        const result = await this.pool.query(`
            INSERT INTO agent_memory (namespace, type, content_json, source_ref, confidence, expires_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `, [
            data.namespace,
            data.type,
            JSON.stringify(data.contentJson),
            data.sourceRef ?? null,
            data.confidence ?? 0.5,
            data.expiresAt ?? null,
            now
        ])

        return this.getAgentMemory(result.rows[0].id)
    }

    async getAgentMemory(id: number): Promise<StoredAgentMemory | null> {
        const result = await this.pool.query('SELECT * FROM agent_memory WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAgentMemory(result.rows[0])
    }

    async getAgentMemories(namespace: string, type?: MemoryType, limit: number = 100): Promise<StoredAgentMemory[]> {
        let query = 'SELECT * FROM agent_memory WHERE namespace = $1'
        const params: unknown[] = [namespace]

        if (type) {
            query += ' AND type = $2'
            params.push(type)
        }

        query += ' ORDER BY updated_at DESC LIMIT $' + (params.length + 1)
        params.push(limit)

        const result = await this.pool.query(query, params)
        return result.rows.map(row => this.toStoredAgentMemory(row))
    }

    async deleteAgentMemory(id: number): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM agent_memory WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    async deleteExpiredAgentMemories(namespace: string): Promise<number> {
        const now = Date.now()
        const result = await this.pool.query(
            'DELETE FROM agent_memory WHERE namespace = $1 AND expires_at IS NOT NULL AND expires_at < $2',
            [namespace, now]
        )
        return result.rowCount ?? 0
    }

    // ========== Agent Suggestion 操作 ==========

    async createAgentSuggestion(data: {
        namespace: string
        sessionId?: string | null
        sourceSessionId?: string | null
        title: string
        detail?: string | null
        category?: string | null
        severity?: string
        confidence?: number
        targets?: string | null
        scope?: string
    }): Promise<StoredAgentSuggestion | null> {
        const id = randomUUID()
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO agent_suggestions (
                id, namespace, session_id, source_session_id, title, detail,
                category, severity, confidence, status, targets, scope, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
            id,
            data.namespace,
            data.sessionId ?? null,
            data.sourceSessionId ?? null,
            data.title,
            data.detail ?? null,
            data.category ?? null,
            data.severity ?? 'low',
            data.confidence ?? 0.5,
            'pending',
            data.targets ?? null,
            data.scope ?? 'session',
            now,
            now
        ])

        return this.getAgentSuggestion(id)
    }

    async getAgentSuggestion(id: string): Promise<StoredAgentSuggestion | null> {
        const result = await this.pool.query('SELECT * FROM agent_suggestions WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAgentSuggestion(result.rows[0])
    }

    async getAgentSuggestions(namespace: string, filters?: {
        status?: SuggestionStatus
        sessionId?: string
        limit?: number
    }): Promise<StoredAgentSuggestion[]> {
        let query = 'SELECT * FROM agent_suggestions WHERE namespace = $1'
        const params: unknown[] = [namespace]

        if (filters?.status) {
            query += ' AND status = $' + (params.length + 1)
            params.push(filters.status)
        }

        if (filters?.sessionId) {
            query += ' AND session_id = $' + (params.length + 1)
            params.push(filters.sessionId)
        }

        query += ' ORDER BY created_at DESC'

        if (filters?.limit) {
            query += ' LIMIT $' + (params.length + 1)
            params.push(filters.limit)
        }

        const result = await this.pool.query(query, params)
        return result.rows.map(row => this.toStoredAgentSuggestion(row))
    }

    async updateAgentSuggestionStatus(id: string, status: SuggestionStatus): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE agent_suggestions SET status = $1, updated_at = $2 WHERE id = $3',
            [status, Date.now(), id]
        )
        return (result.rowCount ?? 0) > 0
    }

    async deleteAgentSuggestion(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM agent_suggestions WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Agent Feedback 操作 ==========

    async createAgentFeedback(data: {
        suggestionId: string
        source: 'user' | 'auto' | 'advisor'
        userId?: string | null
        action: 'accept' | 'reject' | 'defer' | 'supersede'
        evidenceJson?: unknown | null
        comment?: string | null
    }): Promise<StoredAgentFeedback | null> {
        const now = Date.now()
        const result = await this.pool.query(`
            INSERT INTO agent_feedback (suggestion_id, source, user_id, action, evidence_json, comment, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
        `, [
            data.suggestionId,
            data.source,
            data.userId ?? null,
            data.action,
            data.evidenceJson ? JSON.stringify(data.evidenceJson) : null,
            data.comment ?? null,
            now
        ])

        return this.getAgentFeedback(result.rows[0].id)
    }

    async getAgentFeedback(id: number): Promise<StoredAgentFeedback | null> {
        const result = await this.pool.query('SELECT * FROM agent_feedback WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAgentFeedback(result.rows[0])
    }

    async getAgentFeedbackBySuggestion(suggestionId: string): Promise<StoredAgentFeedback[]> {
        const result = await this.pool.query(
            'SELECT * FROM agent_feedback WHERE suggestion_id = $1 ORDER BY created_at DESC',
            [suggestionId]
        )
        return result.rows.map(row => this.toStoredAgentFeedback(row))
    }

    // ========== Auto Iteration Config 操作 ==========

    async getAutoIterationConfig(namespace: string): Promise<StoredAutoIterationConfig | null> {
        const result = await this.pool.query('SELECT * FROM auto_iteration_config WHERE namespace = $1', [namespace])
        if (result.rows.length === 0) return null
        return this.toStoredAutoIterationConfig(result.rows[0])
    }

    async upsertAutoIterationConfig(namespace: string, data: {
        enabled?: boolean
        policyJson?: unknown | null
        allowedProjects?: string[]
        notificationLevel?: 'all' | 'errors_only' | 'none'
        keepLogsDays?: number
        updatedBy?: string | null
    }): Promise<StoredAutoIterationConfig | null> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO auto_iteration_config (
                namespace, enabled, policy_json, allowed_projects, notification_level, keep_logs_days, created_at, updated_at, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (namespace) DO UPDATE SET
                enabled = COALESCE(EXCLUDED.enabled, auto_iteration_config.enabled),
                policy_json = COALESCE(EXCLUDED.policy_json, auto_iteration_config.policy_json),
                allowed_projects = COALESCE(EXCLUDED.allowed_projects, auto_iteration_config.allowed_projects),
                notification_level = COALESCE(EXCLUDED.notification_level, auto_iteration_config.notification_level),
                keep_logs_days = COALESCE(EXCLUDED.keep_logs_days, auto_iteration_config.keep_logs_days),
                updated_at = EXCLUDED.updated_at,
                updated_by = EXCLUDED.updated_by
        `, [
            namespace,
            data.enabled ?? false,
            data.policyJson ? JSON.stringify(data.policyJson) : null,
            data.allowedProjects ? JSON.stringify(data.allowedProjects) : '[]',
            data.notificationLevel ?? 'all',
            data.keepLogsDays ?? 30,
            now,
            now,
            data.updatedBy ?? null
        ])

        return this.getAutoIterationConfig(namespace)
    }

    // ========== Auto Iteration Log 操作 ==========

    async createAutoIterationLog(data: {
        namespace: string
        sourceSuggestionId?: string | null
        sourceSessionId?: string | null
        projectPath?: string | null
        actionType: string
        actionDetail?: unknown | null
        reason?: string | null
    }): Promise<StoredAutoIterationLog | null> {
        const id = randomUUID()
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO auto_iteration_logs (
                id, namespace, source_suggestion_id, source_session_id, project_path,
                action_type, action_detail, reason, execution_status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
            id,
            data.namespace,
            data.sourceSuggestionId ?? null,
            data.sourceSessionId ?? null,
            data.projectPath ?? null,
            data.actionType,
            data.actionDetail ? JSON.stringify(data.actionDetail) : null,
            data.reason ?? null,
            'pending',
            now
        ])

        return this.getAutoIterationLog(id)
    }

    async getAutoIterationLog(id: string): Promise<StoredAutoIterationLog | null> {
        const result = await this.pool.query('SELECT * FROM auto_iteration_logs WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAutoIterationLog(result.rows[0])
    }

    async getAutoIterationLogs(namespace: string, filters?: {
        status?: AutoIterExecutionStatus
        projectPath?: string
        limit?: number
        offset?: number
    }): Promise<StoredAutoIterationLog[]> {
        let query = 'SELECT * FROM auto_iteration_logs WHERE namespace = $1'
        const params: unknown[] = [namespace]

        if (filters?.status) {
            query += ' AND execution_status = $' + (params.length + 1)
            params.push(filters.status)
        }

        if (filters?.projectPath) {
            query += ' AND project_path = $' + (params.length + 1)
            params.push(filters.projectPath)
        }

        query += ' ORDER BY created_at DESC'

        if (filters?.limit) {
            query += ' LIMIT $' + (params.length + 1)
            params.push(filters.limit)
        }

        if (filters?.offset) {
            query += ' OFFSET $' + (params.length + 1)
            params.push(filters.offset)
        }

        const result = await this.pool.query(query, params)
        return result.rows.map(row => this.toStoredAutoIterationLog(row))
    }

    async updateAutoIterationLog(id: string, data: {
        executionStatus?: AutoIterExecutionStatus
        approvalMethod?: AutoIterApprovalMethod
        approvedBy?: string
        approvedAt?: number
        resultJson?: unknown
        errorMessage?: string
        executedAt?: number
        rollbackAvailable?: boolean
        rollbackData?: unknown
        rolledBack?: boolean
        rolledBackAt?: number
    }): Promise<boolean> {
        const fields: string[] = []
        const values: unknown[] = []
        let paramIndex = 1

        if (data.executionStatus !== undefined) {
            fields.push(`execution_status = $${paramIndex++}`)
            values.push(data.executionStatus)
        }
        if (data.approvalMethod !== undefined) {
            fields.push(`approval_method = $${paramIndex++}`)
            values.push(data.approvalMethod)
        }
        if (data.approvedBy !== undefined) {
            fields.push(`approved_by = $${paramIndex++}`)
            values.push(data.approvedBy)
        }
        if (data.approvedAt !== undefined) {
            fields.push(`approved_at = $${paramIndex++}`)
            values.push(data.approvedAt)
        }
        if (data.resultJson !== undefined) {
            fields.push(`result_json = $${paramIndex++}`)
            values.push(data.resultJson ? JSON.stringify(data.resultJson) : null)
        }
        if (data.errorMessage !== undefined) {
            fields.push(`error_message = $${paramIndex++}`)
            values.push(data.errorMessage)
        }
        if (data.executedAt !== undefined) {
            fields.push(`executed_at = $${paramIndex++}`)
            values.push(data.executedAt)
        }
        if (data.rollbackAvailable !== undefined) {
            fields.push(`rollback_available = $${paramIndex++}`)
            values.push(data.rollbackAvailable)
        }
        if (data.rollbackData !== undefined) {
            fields.push(`rollback_data = $${paramIndex++}`)
            values.push(data.rollbackData ? JSON.stringify(data.rollbackData) : null)
        }
        if (data.rolledBack !== undefined) {
            fields.push(`rolled_back = $${paramIndex++}`)
            values.push(data.rolledBack)
        }
        if (data.rolledBackAt !== undefined) {
            fields.push(`rolled_back_at = $${paramIndex++}`)
            values.push(data.rolledBackAt)
        }

        if (fields.length === 0) return true

        values.push(id)
        const result = await this.pool.query(
            `UPDATE auto_iteration_logs SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
            values
        )

        return (result.rowCount ?? 0) > 0
    }

    async deleteAutoIterationLog(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM auto_iteration_logs WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    async cleanupOldAutoIterationLogs(namespace: string, keepDays: number): Promise<number> {
        const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
        const result = await this.pool.query(
            'DELETE FROM auto_iteration_logs WHERE namespace = $1 AND created_at < $2',
            [namespace, cutoff]
        )
        return result.rowCount ?? 0
    }

    // ========== Session Auto Iter Config 操作 ==========

    async getSessionAutoIterConfig(sessionId: string): Promise<StoredSessionAutoIterConfig | null> {
        const result = await this.pool.query('SELECT * FROM session_auto_iter_config WHERE session_id = $1', [sessionId])
        if (result.rows.length === 0) return null
        return {
            sessionId: result.rows[0].session_id,
            autoIterEnabled: result.rows[0].auto_iter_enabled === true,
            updatedAt: Number(result.rows[0].updated_at)
        }
    }

    async isSessionAutoIterEnabled(sessionId: string): Promise<boolean> {
        const result = await this.pool.query('SELECT auto_iter_enabled FROM session_auto_iter_config WHERE session_id = $1', [sessionId])
        return result.rows.length === 0 || result.rows[0].auto_iter_enabled === true
    }

    async setSessionAutoIterEnabled(sessionId: string, enabled: boolean): Promise<StoredSessionAutoIterConfig | null> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO session_auto_iter_config (session_id, auto_iter_enabled, updated_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (session_id) DO UPDATE SET auto_iter_enabled = EXCLUDED.auto_iter_enabled, updated_at = EXCLUDED.updated_at
        `, [sessionId, enabled, now])

        return this.getSessionAutoIterConfig(sessionId)
    }

    // ========== Session Creator Chat ID 操作 ==========

    async setSessionCreatorChatId(sessionId: string, chatId: string, namespace: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE sessions SET creator_chat_id = $1, updated_at = $2 WHERE id = $3 AND namespace = $4',
            [chatId, Date.now(), sessionId, namespace]
        )
        return (result.rowCount ?? 0) > 0
    }

    async getSessionCreatorChatId(sessionId: string): Promise<string | null> {
        const result = await this.pool.query('SELECT creator_chat_id FROM sessions WHERE id = $1', [sessionId])
        return result.rows.length > 0 ? result.rows[0].creator_chat_id : null
    }

    async clearSessionCreatorChatId(sessionId: string, namespace: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE sessions SET creator_chat_id = NULL, updated_at = $1 WHERE id = $2 AND namespace = $3',
            [Date.now(), sessionId, namespace]
        )
        return (result.rowCount ?? 0) > 0
    }

    // ========== Session Notification Subscription 操作 ==========

    async subscribeToSessionNotifications(sessionId: string, chatId: string, namespace: string): Promise<StoredSessionNotificationSubscription | null> {
        const now = Date.now()
        try {
            const result = await this.pool.query(`
                INSERT INTO session_notification_subscriptions (session_id, chat_id, namespace, subscribed_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (session_id, chat_id) DO UPDATE SET subscribed_at = EXCLUDED.subscribed_at
                RETURNING id
            `, [sessionId, chatId, namespace, now])

            return {
                id: result.rows[0].id,
                sessionId,
                chatId,
                clientId: null,
                namespace,
                subscribedAt: now
            }
        } catch {
            return null
        }
    }

    async subscribeToSessionNotificationsByClientId(sessionId: string, clientId: string, namespace: string): Promise<StoredSessionNotificationSubscription | null> {
        const now = Date.now()
        try {
            const result = await this.pool.query(`
                INSERT INTO session_notification_subscriptions (session_id, client_id, namespace, subscribed_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (session_id, client_id) DO UPDATE SET subscribed_at = EXCLUDED.subscribed_at
                RETURNING id
            `, [sessionId, clientId, namespace, now])

            return {
                id: result.rows[0].id,
                sessionId,
                chatId: null,
                clientId,
                namespace,
                subscribedAt: now
            }
        } catch {
            return null
        }
    }

    async unsubscribeFromSessionNotifications(sessionId: string, chatId: string): Promise<boolean> {
        const result = await this.pool.query(
            'DELETE FROM session_notification_subscriptions WHERE session_id = $1 AND chat_id = $2',
            [sessionId, chatId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async unsubscribeFromSessionNotificationsByClientId(sessionId: string, clientId: string): Promise<boolean> {
        const result = await this.pool.query(
            'DELETE FROM session_notification_subscriptions WHERE session_id = $1 AND client_id = $2',
            [sessionId, clientId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async getSessionNotificationSubscription(sessionId: string, chatId: string): Promise<StoredSessionNotificationSubscription | null> {
        const result = await this.pool.query(
            'SELECT * FROM session_notification_subscriptions WHERE session_id = $1 AND chat_id = $2',
            [sessionId, chatId]
        )
        if (result.rows.length === 0) return null
        return this.toStoredSessionNotificationSubscription(result.rows[0])
    }

    async getSessionNotificationSubscriptionByClientId(sessionId: string, clientId: string): Promise<StoredSessionNotificationSubscription | null> {
        const result = await this.pool.query(
            'SELECT * FROM session_notification_subscriptions WHERE session_id = $1 AND client_id = $2',
            [sessionId, clientId]
        )
        if (result.rows.length === 0) return null
        return this.toStoredSessionNotificationSubscription(result.rows[0])
    }

    async getSessionNotificationSubscribers(sessionId: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT chat_id FROM session_notification_subscriptions WHERE session_id = $1 AND chat_id IS NOT NULL',
            [sessionId]
        )
        return result.rows.map(row => row.chat_id)
    }

    async getSessionNotificationSubscriberClientIds(sessionId: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT client_id FROM session_notification_subscriptions WHERE session_id = $1 AND client_id IS NOT NULL',
            [sessionId]
        )
        return result.rows.map(row => row.client_id)
    }

    async getSubscribedSessionsForChat(chatId: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT session_id FROM session_notification_subscriptions WHERE chat_id = $1',
            [chatId]
        )
        return result.rows.map(row => row.session_id)
    }

    async getSubscribedSessionsForClient(clientId: string): Promise<string[]> {
        const result = await this.pool.query(
            'SELECT session_id FROM session_notification_subscriptions WHERE client_id = $1',
            [clientId]
        )
        return result.rows.map(row => row.session_id)
    }

    async getSessionNotificationRecipients(sessionId: string): Promise<string[]> {
        return this.getSessionNotificationSubscribers(sessionId)
    }

    async getSessionNotificationRecipientClientIds(sessionId: string): Promise<string[]> {
        return this.getSessionNotificationSubscriberClientIds(sessionId)
    }

    // ========== AI Profile 操作 ==========

    async getAIProfiles(namespace: string): Promise<StoredAIProfile[]> {
        const result = await this.pool.query('SELECT * FROM ai_profiles WHERE namespace = $1 ORDER BY name', [namespace])
        return result.rows.map(row => this.toStoredAIProfile(row))
    }

    async getAIProfilesByOrg(orgId: string): Promise<StoredAIProfile[]> {
        const result = await this.pool.query('SELECT * FROM ai_profiles WHERE org_id = $1 ORDER BY role, name', [orgId])
        return result.rows.map(row => this.toStoredAIProfile(row))
    }

    async getAIProfile(id: string): Promise<StoredAIProfile | null> {
        const result = await this.pool.query('SELECT * FROM ai_profiles WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAIProfile(result.rows[0])
    }

    async getAIProfileByName(namespace: string, name: string): Promise<StoredAIProfile | null> {
        const result = await this.pool.query(
            'SELECT * FROM ai_profiles WHERE namespace = $1 AND name = $2',
            [namespace, name]
        )
        if (result.rows.length === 0) return null
        return this.toStoredAIProfile(result.rows[0])
    }

    async getAIProfileByOrgAndRole(orgId: string, role: AIProfileRole): Promise<StoredAIProfile | null> {
        const result = await this.pool.query(
            'SELECT * FROM ai_profiles WHERE org_id = $1 AND role = $2',
            [orgId, role]
        )
        if (result.rows.length === 0) return null
        return this.toStoredAIProfile(result.rows[0])
    }

    async createAIProfile(data: {
        namespace: string
        orgId?: string | null
        name: string
        role: AIProfileRole
        specialties?: string[]
        behaviorAnchors?: string[]
        personality?: string | null
        greetingTemplate?: string | null
        preferredProjects?: string[]
        workStyle?: string | null
        avatarEmoji?: string
    }): Promise<StoredAIProfile | null> {
        const id = randomUUID()
        const now = Date.now()
        const stats = { tasksCompleted: 0, activeMinutes: 0, lastActiveAt: null }

        await this.pool.query(`
            INSERT INTO ai_profiles (
                id, namespace, org_id, name, role, specialties, behavior_anchors, personality, greeting_template,
                preferred_projects, work_style, avatar_emoji, status, stats_json, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [
            id,
            data.namespace,
            data.orgId ?? null,
            data.name,
            data.role,
            JSON.stringify(data.specialties ?? []),
            JSON.stringify(data.behaviorAnchors ?? []),
            data.personality ?? null,
            data.greetingTemplate ?? null,
            JSON.stringify(data.preferredProjects ?? []),
            data.workStyle ?? null,
            data.avatarEmoji ?? '🤖',
            'idle',
            JSON.stringify(stats),
            now,
            now
        ])

        return this.getAIProfile(id)
    }

    async updateAIProfile(id: string, data: {
        name?: string
        role?: AIProfileRole
        specialties?: string[]
        behaviorAnchors?: string[]
        personality?: string | null
        greetingTemplate?: string | null
        preferredProjects?: string[]
        workStyle?: string | null
        avatarEmoji?: string
    }): Promise<StoredAIProfile | null> {
        const fields: string[] = []
        const values: unknown[] = []
        let paramIndex = 1

        if (data.name !== undefined) {
            fields.push(`name = $${paramIndex++}`)
            values.push(data.name)
        }
        if (data.role !== undefined) {
            fields.push(`role = $${paramIndex++}`)
            values.push(data.role)
        }
        if (data.specialties !== undefined) {
            fields.push(`specialties = $${paramIndex++}`)
            values.push(JSON.stringify(data.specialties))
        }
        if (data.behaviorAnchors !== undefined) {
            fields.push(`behavior_anchors = $${paramIndex++}`)
            values.push(JSON.stringify(data.behaviorAnchors))
        }
        if (data.personality !== undefined) {
            fields.push(`personality = $${paramIndex++}`)
            values.push(data.personality)
        }
        if (data.greetingTemplate !== undefined) {
            fields.push(`greeting_template = $${paramIndex++}`)
            values.push(data.greetingTemplate)
        }
        if (data.preferredProjects !== undefined) {
            fields.push(`preferred_projects = $${paramIndex++}`)
            values.push(JSON.stringify(data.preferredProjects))
        }
        if (data.workStyle !== undefined) {
            fields.push(`work_style = $${paramIndex++}`)
            values.push(data.workStyle)
        }
        if (data.avatarEmoji !== undefined) {
            fields.push(`avatar_emoji = $${paramIndex++}`)
            values.push(data.avatarEmoji)
        }

        if (fields.length === 0) return this.getAIProfile(id)

        fields.push(`updated_at = $${paramIndex++}`)
        values.push(Date.now())
        values.push(id)

        await this.pool.query(
            `UPDATE ai_profiles SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
            values
        )

        return this.getAIProfile(id)
    }

    async deleteAIProfile(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM ai_profiles WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    async updateAIProfileStatus(id: string, status: AIProfileStatus): Promise<void> {
        await this.pool.query('UPDATE ai_profiles SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), id])
    }

    async updateAIProfileStats(id: string, stats: { tasksCompleted?: number; activeMinutes?: number; lastActiveAt?: number | null }): Promise<void> {
        const current = await this.getAIProfile(id)
        if (!current) return

        const newStats = {
            tasksCompleted: stats.tasksCompleted ?? current.stats.tasksCompleted,
            activeMinutes: stats.activeMinutes ?? current.stats.activeMinutes,
            lastActiveAt: stats.lastActiveAt ?? current.stats.lastActiveAt
        }

        await this.pool.query(
            'UPDATE ai_profiles SET stats_json = $1, updated_at = $2 WHERE id = $3',
            [JSON.stringify(newStats), Date.now(), id]
        )
    }

    // ========== AI Profile Memory 操作 ==========

    async createProfileMemory(data: {
        namespace: string
        profileId: string
        memoryType: AIProfileMemoryType
        content: string
        importance?: number
        expiresAt?: number | null
        metadata?: unknown | null
    }): Promise<StoredAIProfileMemory | null> {
        const id = randomUUID()
        const now = Date.now()

        await this.pool.query(`
            INSERT INTO ai_profile_memories (
                id, namespace, profile_id, memory_type, content, importance,
                access_count, last_accessed_at, expires_at, created_at, updated_at, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            id,
            data.namespace,
            data.profileId,
            data.memoryType,
            data.content,
            data.importance ?? 0.5,
            0,
            null,
            data.expiresAt ?? null,
            now,
            now,
            data.metadata ? JSON.stringify(data.metadata) : null
        ])

        return this.getProfileMemory(id)
    }

    async getProfileMemories(options: {
        namespace: string
        profileId?: string
        memoryType?: AIProfileMemoryType
        minImportance?: number
        limit?: number
    }): Promise<StoredAIProfileMemory[]> {
        let query = 'SELECT * FROM ai_profile_memories WHERE namespace = $1'
        const params: unknown[] = [options.namespace]

        if (options.profileId) {
            query += ' AND profile_id = $' + (params.length + 1)
            params.push(options.profileId)
        }

        if (options.memoryType) {
            query += ' AND memory_type = $' + (params.length + 1)
            params.push(options.memoryType)
        }

        if (options.minImportance !== undefined) {
            query += ' AND importance >= $' + (params.length + 1)
            params.push(options.minImportance)
        }

        query += ' ORDER BY importance DESC, updated_at DESC'

        if (options.limit) {
            query += ' LIMIT $' + (params.length + 1)
            params.push(options.limit)
        }

        const result = await this.pool.query(query, params)
        return result.rows.map(row => this.toStoredAIProfileMemory(row))
    }

    async getProfileMemory(id: string): Promise<StoredAIProfileMemory | null> {
        const result = await this.pool.query('SELECT * FROM ai_profile_memories WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAIProfileMemory(result.rows[0])
    }

    async updateMemoryAccess(namespace: string, memoryId: string): Promise<void> {
        await this.pool.query(`
            UPDATE ai_profile_memories
            SET access_count = access_count + 1, last_accessed_at = $1, updated_at = $1
            WHERE id = $2 AND namespace = $3
        `, [Date.now(), memoryId, namespace])
    }

    async updateProfileMemory(id: string, data: {
        content?: string
        importance?: number
        expiresAt?: number | null
        metadata?: unknown | null
    }): Promise<StoredAIProfileMemory | null> {
        const fields: string[] = []
        const values: unknown[] = []
        let paramIndex = 1

        if (data.content !== undefined) {
            fields.push(`content = $${paramIndex++}`)
            values.push(data.content)
        }
        if (data.importance !== undefined) {
            fields.push(`importance = $${paramIndex++}`)
            values.push(data.importance)
        }
        if (data.expiresAt !== undefined) {
            fields.push(`expires_at = $${paramIndex++}`)
            values.push(data.expiresAt)
        }
        if (data.metadata !== undefined) {
            fields.push(`metadata = $${paramIndex++}`)
            values.push(data.metadata ? JSON.stringify(data.metadata) : null)
        }

        if (fields.length === 0) return this.getProfileMemory(id)

        fields.push(`updated_at = $${paramIndex++}`)
        values.push(Date.now())
        values.push(id)

        await this.pool.query(
            `UPDATE ai_profile_memories SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
            values
        )

        return this.getProfileMemory(id)
    }

    async deleteExpiredMemories(namespace: string): Promise<number> {
        const now = Date.now()
        const result = await this.pool.query(
            'DELETE FROM ai_profile_memories WHERE namespace = $1 AND expires_at IS NOT NULL AND expires_at < $2',
            [namespace, now]
        )
        return result.rowCount ?? 0
    }

    async deleteProfileMemories(namespace: string, profileId: string): Promise<number> {
        const result = await this.pool.query(
            'DELETE FROM ai_profile_memories WHERE namespace = $1 AND profile_id = $2',
            [namespace, profileId]
        )
        return result.rowCount ?? 0
    }

    async deleteProfileMemory(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM ai_profile_memories WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== AI Team 操作 ==========

    async createAITeam(data: {
        namespace: string
        name: string
        description?: string | null
        focus?: string | null
        config?: { maxMembers?: number; autoAssign?: boolean; sharedKnowledge?: boolean }
    }): Promise<StoredAITeam | null> {
        const id = randomUUID()
        const now = Date.now()
        const config = {
            maxMembers: data.config?.maxMembers ?? 10,
            autoAssign: data.config?.autoAssign ?? true,
            sharedKnowledge: data.config?.sharedKnowledge ?? true
        }
        const stats = { tasksCompleted: 0, activeHours: 0, collaborationScore: 0 }

        await this.pool.query(`
            INSERT INTO ai_teams (id, namespace, name, description, focus, status, config_json, stats_json, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [id, data.namespace, data.name, data.description ?? null, data.focus ?? null, 'active', JSON.stringify(config), JSON.stringify(stats), now, now])

        return this.getAITeam(id)
    }

    async getAITeam(id: string): Promise<StoredAITeam | null> {
        const result = await this.pool.query('SELECT * FROM ai_teams WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAITeam(result.rows[0])
    }

    async getAITeams(namespace: string): Promise<StoredAITeam[]> {
        const result = await this.pool.query('SELECT * FROM ai_teams WHERE namespace = $1 ORDER BY name', [namespace])
        return result.rows.map(row => this.toStoredAITeam(row))
    }

    async getActiveAITeams(namespace: string): Promise<StoredAITeam[]> {
        const result = await this.pool.query(
            'SELECT * FROM ai_teams WHERE namespace = $1 AND status = $2 ORDER BY name',
            [namespace, 'active']
        )
        return result.rows.map(row => this.toStoredAITeam(row))
    }

    async updateAITeam(id: string, data: {
        name?: string
        description?: string | null
        focus?: string | null
        status?: AITeamStatus
        config?: { maxMembers?: number; autoAssign?: boolean; sharedKnowledge?: boolean }
    }): Promise<StoredAITeam | null> {
        const fields: string[] = []
        const values: unknown[] = []
        let paramIndex = 1

        if (data.name !== undefined) {
            fields.push(`name = $${paramIndex++}`)
            values.push(data.name)
        }
        if (data.description !== undefined) {
            fields.push(`description = $${paramIndex++}`)
            values.push(data.description)
        }
        if (data.focus !== undefined) {
            fields.push(`focus = $${paramIndex++}`)
            values.push(data.focus)
        }
        if (data.status !== undefined) {
            fields.push(`status = $${paramIndex++}`)
            values.push(data.status)
        }
        if (data.config !== undefined) {
            fields.push(`config_json = $${paramIndex++}`)
            values.push(JSON.stringify(data.config))
        }

        if (fields.length === 0) return this.getAITeam(id)

        fields.push(`updated_at = $${paramIndex++}`)
        values.push(Date.now())
        values.push(id)

        await this.pool.query(
            `UPDATE ai_teams SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
            values
        )

        return this.getAITeam(id)
    }

    async updateAITeamStats(id: string, stats: { tasksCompleted?: number; activeHours?: number; collaborationScore?: number }): Promise<void> {
        const current = await this.getAITeam(id)
        if (!current) return

        const newStats = {
            tasksCompleted: stats.tasksCompleted ?? current.stats.tasksCompleted,
            activeHours: stats.activeHours ?? current.stats.activeHours,
            collaborationScore: stats.collaborationScore ?? current.stats.collaborationScore
        }

        await this.pool.query(
            'UPDATE ai_teams SET stats_json = $1, updated_at = $2 WHERE id = $3',
            [JSON.stringify(newStats), Date.now(), id]
        )
    }

    async deleteAITeam(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM ai_teams WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== AI Team Member 操作 ==========

    async addAITeamMember(data: {
        teamId: string
        profileId: string
        role?: AITeamMemberRole
        specialization?: string | null
    }): Promise<StoredAITeamMember | null> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO ai_team_members (team_id, profile_id, role, joined_at, contribution, specialization)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (team_id, profile_id) DO UPDATE SET role = EXCLUDED.role, specialization = EXCLUDED.specialization
        `, [data.teamId, data.profileId, data.role ?? 'member', now, 0, data.specialization ?? null])

        return this.getAITeamMember(data.teamId, data.profileId)
    }

    async getAITeamMember(teamId: string, profileId: string): Promise<StoredAITeamMember | null> {
        const result = await this.pool.query(
            'SELECT * FROM ai_team_members WHERE team_id = $1 AND profile_id = $2',
            [teamId, profileId]
        )
        if (result.rows.length === 0) return null
        return this.toStoredAITeamMember(result.rows[0])
    }

    async getAITeamMembers(teamId: string): Promise<StoredAITeamMember[]> {
        const result = await this.pool.query('SELECT * FROM ai_team_members WHERE team_id = $1', [teamId])
        return result.rows.map(row => this.toStoredAITeamMember(row))
    }

    async getTeamsForProfile(profileId: string): Promise<StoredAITeam[]> {
        const result = await this.pool.query(`
            SELECT t.* FROM ai_teams t
            JOIN ai_team_members m ON t.id = m.team_id
            WHERE m.profile_id = $1
            ORDER BY t.name
        `, [profileId])
        return result.rows.map(row => this.toStoredAITeam(row))
    }

    async updateTeamMemberContribution(teamId: string, profileId: string, contribution: number): Promise<void> {
        await this.pool.query(
            'UPDATE ai_team_members SET contribution = $1 WHERE team_id = $2 AND profile_id = $3',
            [contribution, teamId, profileId]
        )
    }

    async updateTeamMemberRole(teamId: string, profileId: string, role: AITeamMemberRole): Promise<void> {
        await this.pool.query(
            'UPDATE ai_team_members SET role = $1 WHERE team_id = $2 AND profile_id = $3',
            [role, teamId, profileId]
        )
    }

    async removeAITeamMember(teamId: string, profileId: string): Promise<boolean> {
        const result = await this.pool.query(
            'DELETE FROM ai_team_members WHERE team_id = $1 AND profile_id = $2',
            [teamId, profileId]
        )
        return (result.rowCount ?? 0) > 0
    }

    // ========== AI Team Knowledge 操作 ==========

    async addAITeamKnowledge(data: {
        teamId: string
        namespace: string
        title: string
        content: string
        category: 'best-practice' | 'lesson-learned' | 'decision' | 'convention'
        contributorProfileId: string
        importance?: number
    }): Promise<StoredAITeamKnowledge | null> {
        const id = randomUUID()
        const now = Date.now()

        await this.pool.query(`
            INSERT INTO ai_team_knowledge (
                id, team_id, namespace, title, content, category,
                contributor_profile_id, importance, access_count, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
            id,
            data.teamId,
            data.namespace,
            data.title,
            data.content,
            data.category,
            data.contributorProfileId,
            data.importance ?? 0.5,
            0,
            now,
            now
        ])

        return this.getAITeamKnowledge(id)
    }

    async getAITeamKnowledge(id: string): Promise<StoredAITeamKnowledge | null> {
        const result = await this.pool.query('SELECT * FROM ai_team_knowledge WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAITeamKnowledge(result.rows[0])
    }

    async getAITeamKnowledgeList(teamId: string, options?: {
        category?: 'best-practice' | 'lesson-learned' | 'decision' | 'convention'
        minImportance?: number
        limit?: number
    }): Promise<StoredAITeamKnowledge[]> {
        let query = 'SELECT * FROM ai_team_knowledge WHERE team_id = $1'
        const params: unknown[] = [teamId]

        if (options?.category) {
            query += ' AND category = $' + (params.length + 1)
            params.push(options.category)
        }

        if (options?.minImportance !== undefined) {
            query += ' AND importance >= $' + (params.length + 1)
            params.push(options.minImportance)
        }

        query += ' ORDER BY importance DESC, updated_at DESC'

        if (options?.limit) {
            query += ' LIMIT $' + (params.length + 1)
            params.push(options.limit)
        }

        const result = await this.pool.query(query, params)
        return result.rows.map(row => this.toStoredAITeamKnowledge(row))
    }

    async updateTeamKnowledgeAccess(id: string): Promise<void> {
        await this.pool.query(
            'UPDATE ai_team_knowledge SET access_count = access_count + 1, updated_at = $1 WHERE id = $2',
            [Date.now(), id]
        )
    }

    async deleteAITeamKnowledge(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM ai_team_knowledge WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    async getAITeamWithMembers(teamId: string): Promise<{ team: StoredAITeam; members: Array<StoredAITeamMember & { profile: StoredAIProfile }> } | null> {
        const team = await this.getAITeam(teamId)
        if (!team) return null

        const result = await this.pool.query(`
            SELECT m.*, p.*,
                   m.team_id as m_team_id, m.profile_id as m_profile_id, m.role as m_role,
                   m.joined_at as m_joined_at, m.contribution as m_contribution, m.specialization as m_specialization
            FROM ai_team_members m
            JOIN ai_profiles p ON m.profile_id = p.id
            WHERE m.team_id = $1
        `, [teamId])

        const members = result.rows.map(row => ({
            teamId: row.m_team_id,
            profileId: row.m_profile_id,
            role: row.m_role as AITeamMemberRole,
            joinedAt: Number(row.m_joined_at),
            contribution: row.m_contribution,
            specialization: row.m_specialization,
            profile: this.toStoredAIProfile(row)
        }))

        return { team, members }
    }

    // ========== Download Files 操作 ==========

    async addDownloadFile(file: { sessionId: string; orgId: string | null; filename: string; mimeType: string; content: Buffer }): Promise<StoredDownloadFile> {
        const now = Date.now()
        const result = await this.pool.query(
            `INSERT INTO session_downloads (session_id, org_id, filename, mime_type, content, size, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [file.sessionId, file.orgId, file.filename, file.mimeType, file.content, file.content.length, now]
        )
        return {
            id: result.rows[0].id,
            sessionId: file.sessionId,
            orgId: file.orgId,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.content.length,
            createdAt: now,
        }
    }

    async getDownloadFile(id: string): Promise<{ meta: StoredDownloadFile; content: Buffer } | null> {
        const result = await this.pool.query(
            'SELECT * FROM session_downloads WHERE id = $1',
            [id]
        )
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            meta: {
                id: row.id,
                sessionId: row.session_id,
                orgId: row.org_id,
                filename: row.filename,
                mimeType: row.mime_type,
                size: Number(row.size),
                createdAt: Number(row.created_at),
            },
            content: row.content as Buffer,
        }
    }

    async listDownloadFiles(sessionId: string): Promise<StoredDownloadFile[]> {
        const result = await this.pool.query(
            'SELECT id, session_id, org_id, filename, mime_type, size, created_at FROM session_downloads WHERE session_id = $1 ORDER BY created_at DESC',
            [sessionId]
        )
        return result.rows.map(row => ({
            id: row.id,
            sessionId: row.session_id,
            orgId: row.org_id,
            filename: row.filename,
            mimeType: row.mime_type,
            size: Number(row.size),
            createdAt: Number(row.created_at),
        }))
    }

    async clearDownloadFiles(sessionId: string): Promise<number> {
        const result = await this.pool.query(
            'DELETE FROM session_downloads WHERE session_id = $1',
            [sessionId]
        )
        return Number(result.rowCount ?? 0)
    }

    // ========== Approvals Engine ==========
    // Master + payload + audit CRUD for the unified approval flow. Domain
    // semantics live in server/src/approvals/*; this layer stays agnostic.

    private toApprovalRecord(row: any): ApprovalRecord {
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id,
            domain: row.domain,
            subjectKind: row.subject_kind,
            subjectKey: row.subject_key,
            status: row.status as ApprovalMasterStatus,
            decidedBy: row.decided_by ?? null,
            decidedAt: row.decided_at != null ? Number(row.decided_at) : null,
            decisionReason: row.decision_reason ?? null,
            expiresAt: row.expires_at != null ? Number(row.expires_at) : null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }
    }

    private toApprovalAudit(row: any): ApprovalAudit {
        return {
            id: row.id,
            approvalId: row.approval_id,
            namespace: row.namespace,
            orgId: row.org_id,
            domain: row.domain,
            action: row.action,
            priorStatus: row.prior_status ?? null,
            newStatus: row.new_status ?? null,
            actorEmail: row.actor_email ?? null,
            actorRole: (row.actor_role ?? null) as ApprovalAudit['actorRole'],
            reason: row.reason ?? null,
            payloadSnapshot: row.payload_snapshot ?? null,
            createdAt: Number(row.created_at),
        }
    }

    /** Block column/table identifiers that would allow SQL injection through
     *  dynamic payload table queries. Snake_case ASCII only. */
    private assertApprovalIdent(name: string): void {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) {
            throw new Error(`Invalid approvals identifier: ${name}`)
        }
    }

    async listApprovals(filter: {
        namespace: string
        orgId: string
        domain?: string | null
        status?: ApprovalMasterStatus | null
        subjectKey?: string | null
        limit?: number
    }): Promise<ApprovalRecord[]> {
        const where: string[] = ['namespace = $1', 'org_id = $2']
        const params: unknown[] = [filter.namespace, filter.orgId]
        let idx = 3
        if (filter.domain) { where.push(`domain = $${idx++}`); params.push(filter.domain) }
        if (filter.status) { where.push(`status = $${idx++}`); params.push(filter.status) }
        if (filter.subjectKey) { where.push(`subject_key = $${idx++}`); params.push(filter.subjectKey) }
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
        params.push(limit)
        const result = await this.pool.query(
            `SELECT * FROM approvals WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC LIMIT $${idx}`,
            params,
        )
        return result.rows.map((row) => this.toApprovalRecord(row))
    }

    async getApproval(namespace: string, orgId: string, id: string): Promise<ApprovalRecord | null> {
        const result = await this.pool.query(
            `SELECT * FROM approvals WHERE namespace = $1 AND org_id = $2 AND id = $3`,
            [namespace, orgId, id],
        )
        return result.rows.length > 0 ? this.toApprovalRecord(result.rows[0]) : null
    }

    async getApprovalBySubject(
        namespace: string,
        orgId: string,
        domain: string,
        subjectKey: string,
    ): Promise<ApprovalRecord | null> {
        const result = await this.pool.query(
            `SELECT * FROM approvals
             WHERE namespace = $1 AND org_id = $2 AND domain = $3 AND subject_key = $4`,
            [namespace, orgId, domain, subjectKey],
        )
        return result.rows.length > 0 ? this.toApprovalRecord(result.rows[0]) : null
    }

    async getApprovalPayload<TPayload extends Record<string, unknown>>(
        namespace: string,
        approvalId: string,
        payloadTable: string,
    ): Promise<TPayload | null> {
        this.assertApprovalIdent(payloadTable)
        // Verify tenancy — refuse to read payload for an approval in another namespace.
        const tenancy = await this.pool.query(
            `SELECT 1 FROM approvals WHERE id = $1 AND namespace = $2`,
            [approvalId, namespace],
        )
        if (tenancy.rows.length === 0) return null
        const result = await this.pool.query(
            `SELECT * FROM ${payloadTable} WHERE approval_id = $1`,
            [approvalId],
        )
        if (result.rows.length === 0) return null
        return this.stripApprovalId(result.rows[0]) as TPayload
    }

    async upsertApproval<TPayload extends Record<string, unknown>>(data: {
        namespace: string
        orgId: string
        domain: string
        subjectKind: string
        subjectKey: string
        expiresAt?: number | null
        payloadTable: string
        payload: TPayload
    }): Promise<{ record: ApprovalRecord; payload: TPayload }> {
        this.assertApprovalIdent(data.payloadTable)
        const payloadKeys = Object.keys(data.payload)
        for (const key of payloadKeys) this.assertApprovalIdent(key)

        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const now = Date.now()

            const existing = await client.query(
                `SELECT * FROM approvals
                 WHERE namespace = $1 AND org_id = $2 AND domain = $3 AND subject_key = $4
                 FOR UPDATE`,
                [data.namespace, data.orgId, data.domain, data.subjectKey],
            )

            let record: ApprovalRecord
            if (existing.rows.length > 0) {
                const prev = this.toApprovalRecord(existing.rows[0])
                if (prev.status !== 'pending') {
                    throw new Error(
                        `Cannot overwrite decided approval ${prev.id} (status=${prev.status})`,
                    )
                }
                const updated = await client.query(
                    `UPDATE approvals SET updated_at = $1, expires_at = $2
                     WHERE id = $3 RETURNING *`,
                    [now, data.expiresAt ?? null, prev.id],
                )
                record = this.toApprovalRecord(updated.rows[0])
            } else {
                const id = randomUUID()
                const inserted = await client.query(
                    `INSERT INTO approvals
                     (id, namespace, org_id, domain, subject_kind, subject_key,
                      status, created_at, updated_at, expires_at)
                     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $7, $8)
                     RETURNING *`,
                    [
                        id,
                        data.namespace,
                        data.orgId,
                        data.domain,
                        data.subjectKind,
                        data.subjectKey,
                        now,
                        data.expiresAt ?? null,
                    ],
                )
                record = this.toApprovalRecord(inserted.rows[0])
            }

            // Upsert payload row (1:1 with approvals.id)
            const cols = ['approval_id', ...payloadKeys]
            const values: unknown[] = [record.id]
            for (const key of payloadKeys) {
                const v = data.payload[key]
                values.push(this.encodeApprovalPayloadValue(v))
            }
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
            const updateSet = payloadKeys.length > 0
                ? payloadKeys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')
                : 'approval_id = EXCLUDED.approval_id' // no-op but valid
            const payloadInsert = await client.query(
                `INSERT INTO ${data.payloadTable} (${cols.join(', ')})
                 VALUES (${placeholders})
                 ON CONFLICT (approval_id) DO UPDATE SET ${updateSet}
                 RETURNING *`,
                values,
            )
            await client.query('COMMIT')

            const payload = this.stripApprovalId(payloadInsert.rows[0]) as TPayload
            return { record, payload }
        } catch (err) {
            try { await client.query('ROLLBACK') } catch {}
            throw err
        } finally {
            client.release()
        }
    }

    async decideApproval<TPayload extends Record<string, unknown>>(args: {
        namespace: string
        approvalId: string
        payloadTable: string
        decide: (ctx: ApprovalTxnContext<TPayload>) => Promise<ApprovalDecisionOutcome<TPayload>>
    }): Promise<{ record: ApprovalRecord; payload: TPayload; audit: ApprovalAudit }> {
        this.assertApprovalIdent(args.payloadTable)

        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const recordResult = await client.query(
                `SELECT * FROM approvals WHERE id = $1 AND namespace = $2 FOR UPDATE`,
                [args.approvalId, args.namespace],
            )
            if (recordResult.rows.length === 0) {
                throw new ApprovalNotFoundError(args.approvalId)
            }
            const priorRecord = this.toApprovalRecord(recordResult.rows[0])

            const payloadResult = await client.query(
                `SELECT * FROM ${args.payloadTable} WHERE approval_id = $1`,
                [args.approvalId],
            )
            if (payloadResult.rows.length === 0) {
                throw new Error(
                    `Missing payload row for approval ${args.approvalId} in ${args.payloadTable}`,
                )
            }
            const payload = this.stripApprovalId(payloadResult.rows[0]) as TPayload

            const now = Date.now()
            const txnQuery = (text: string, params?: unknown[]) =>
                client.query(text, params) as Promise<{ rows: any[]; rowCount: number }>
            const outcome = await args.decide({ record: priorRecord, payload, now, query: txnQuery })

            const updated = await client.query(
                `UPDATE approvals
                 SET status = $1, decided_by = $2, decided_at = $3,
                     decision_reason = $4, updated_at = $5
                 WHERE id = $6 RETURNING *`,
                [
                    outcome.newStatus,
                    outcome.decidedBy,
                    outcome.newStatus === priorRecord.status ? priorRecord.decidedAt : now,
                    outcome.decisionReason,
                    now,
                    priorRecord.id,
                ],
            )
            const newRecord = this.toApprovalRecord(updated.rows[0])

            let finalPayload: TPayload = payload
            if (outcome.payloadPatch) {
                const patchKeys = Object.keys(outcome.payloadPatch)
                for (const key of patchKeys) this.assertApprovalIdent(key)
                if (patchKeys.length > 0) {
                    const setClause = patchKeys
                        .map((k, i) => `${k} = $${i + 2}`)
                        .join(', ')
                    const patchValues = patchKeys.map((k) =>
                        this.encodeApprovalPayloadValue(outcome.payloadPatch![k]),
                    )
                    const patched = await client.query(
                        `UPDATE ${args.payloadTable} SET ${setClause}
                         WHERE approval_id = $1 RETURNING *`,
                        [priorRecord.id, ...patchValues],
                    )
                    finalPayload = this.stripApprovalId(patched.rows[0]) as TPayload
                }
            }

            const auditId = randomUUID()
            const auditResult = await client.query(
                `INSERT INTO approval_audits
                 (id, approval_id, namespace, org_id, domain, action,
                  prior_status, new_status, actor_email, actor_role, reason,
                  payload_snapshot, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                 RETURNING *`,
                [
                    auditId,
                    priorRecord.id,
                    priorRecord.namespace,
                    priorRecord.orgId,
                    priorRecord.domain,
                    outcome.audit.action,
                    priorRecord.status,
                    outcome.newStatus,
                    outcome.audit.actorEmail,
                    outcome.audit.actorRole,
                    outcome.audit.reason,
                    JSON.stringify(finalPayload ?? null),
                    now,
                ],
            )
            const audit = this.toApprovalAudit(auditResult.rows[0])

            await client.query('COMMIT')
            return { record: newRecord, payload: finalPayload, audit }
        } catch (err) {
            try { await client.query('ROLLBACK') } catch {}
            throw err
        } finally {
            client.release()
        }
    }

    async listApprovalAudits(filter: {
        namespace: string
        orgId: string
        approvalId?: string | null
        domain?: string | null
        limit?: number
    }): Promise<ApprovalAudit[]> {
        const where: string[] = ['namespace = $1', 'org_id = $2']
        const params: unknown[] = [filter.namespace, filter.orgId]
        let idx = 3
        if (filter.approvalId) { where.push(`approval_id = $${idx++}`); params.push(filter.approvalId) }
        if (filter.domain) { where.push(`domain = $${idx++}`); params.push(filter.domain) }
        const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
        params.push(limit)
        const result = await this.pool.query(
            `SELECT * FROM approval_audits WHERE ${where.join(' AND ')}
             ORDER BY created_at DESC LIMIT $${idx}`,
            params,
        )
        return result.rows.map((row) => this.toApprovalAudit(row))
    }

    /** JSON-stringify object/array payload values so pg driver stores JSONB correctly. */
    private encodeApprovalPayloadValue(value: unknown): unknown {
        if (value === null || value === undefined) return value
        if (typeof value !== 'object') return value
        // Arrays + plain objects go into JSONB columns; pg handles Date/Buffer natively.
        if (value instanceof Date || Buffer.isBuffer(value)) return value
        return JSON.stringify(value)
    }

    private stripApprovalId(row: any): Record<string, unknown> {
        const { approval_id: _approvalId, ...rest } = row ?? {}
        return rest as Record<string, unknown>
    }

    async close(): Promise<void> {
        await this.pool.end()
    }

    /**
     * 获取连接池（用于 Review 等独立模块共享连接）
     */
    getPool(): Pool {
        return this.pool
    }

    // ========== 迁移辅助方法 ==========

    /**
     * Insert a session with a specific ID (for migration)
     */
    async insertSessionRaw(session: StoredSession): Promise<void> {
        await this.pool.query(`
            INSERT INTO sessions (
                id, tag, namespace, machine_id, created_at, updated_at,
                metadata, metadata_version,
                agent_state, agent_state_version,
                todos, todos_updated_at,
                active, active_at, seq,
                advisor_task_id, creator_chat_id, advisor_mode, advisor_prompt_injected, role_prompt_sent
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            ON CONFLICT (id) DO NOTHING
        `, [
            session.id,
            session.tag,
            session.namespace,
            session.machineId,
            session.createdAt,
            session.updatedAt,
            JSON.stringify(session.metadata),
            session.metadataVersion,
            JSON.stringify(session.agentState),
            session.agentStateVersion,
            JSON.stringify(session.todos),
            session.todosUpdatedAt,
            session.active,
            session.activeAt,
            session.seq,
            session.advisorTaskId,
            session.creatorChatId,
            session.advisorMode,
            session.advisorPromptInjected,
            session.rolePromptSent
        ])
    }

    /**
     * Insert a machine with specific data (for migration)
     */
    async insertMachineRaw(machine: StoredMachine): Promise<void> {
        await this.pool.query(`
            INSERT INTO machines (
                id, namespace, created_at, updated_at,
                metadata, metadata_version,
                daemon_state, daemon_state_version,
                active, active_at, seq
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO NOTHING
        `, [
            machine.id,
            machine.namespace || 'default',
            machine.createdAt,
            machine.updatedAt,
            JSON.stringify(machine.metadata),
            machine.metadataVersion,
            JSON.stringify(machine.daemonState),
            machine.daemonStateVersion,
            machine.active,
            machine.activeAt,
            machine.seq
        ])
    }

    /**
     * Insert a message with specific data (for migration)
     */
    async insertMessageRaw(message: StoredMessage): Promise<void> {
        await this.pool.query(`
            INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO NOTHING
        `, [
            message.id,
            message.sessionId,
            JSON.stringify(message.content),
            message.createdAt,
            message.seq,
            message.localId
        ])
    }

    // ========== 辅助转换函数 ==========

    private toStoredSession(row: any): StoredSession {
        return {
            id: row.id,
            tag: row.tag,
            namespace: row.namespace,
            machineId: row.machine_id,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            createdBy: row.created_by ?? null,
            orgId: row.org_id ?? null,
            metadata: row.metadata,
            metadataVersion: row.metadata_version,
            agentState: row.agent_state,
            agentStateVersion: row.agent_state_version,
            todos: row.todos,
            todosUpdatedAt: row.todos_updated_at ? Number(row.todos_updated_at) : null,
            active: row.active === true,
            activeAt: row.active_at ? Number(row.active_at) : null,
            thinking: row.thinking === true,
            thinkingAt: row.thinking_at != null ? Number(row.thinking_at) : null,
            seq: row.seq,
            advisorTaskId: row.advisor_task_id,
            creatorChatId: row.creator_chat_id,
            advisorMode: row.advisor_mode === true,
            advisorPromptInjected: row.advisor_prompt_injected === true,
            rolePromptSent: row.role_prompt_sent === true,
            permissionMode: row.permission_mode ?? null,
            modelMode: row.model_mode ?? null,
            modelReasoningEffort: row.model_reasoning_effort ?? null,
            fastMode: row.fast_mode ?? null,
            terminationReason: row.termination_reason ?? null,
            lastMessageAt: row.last_message_at != null ? Number(row.last_message_at) : null,
            activeMonitors: row.active_monitors ?? null
        }
    }

    private toStoredMachine(row: any): StoredMachine {
        return {
            id: row.id,
            namespace: row.namespace,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            metadata: row.metadata,
            metadataVersion: row.metadata_version,
            daemonState: row.daemon_state,
            daemonStateVersion: row.daemon_state_version,
            active: row.active === true,
            activeAt: row.active_at ? Number(row.active_at) : null,
            seq: row.seq,
            orgId: row.org_id ?? null,
            supportedAgents: (() => {
                if (!Array.isArray(row.supported_agents)) return null
                const filtered = row.supported_agents.filter((v: unknown) => v === 'claude' || v === 'codex') as SpawnAgentType[]
                return filtered.length > 0 ? filtered : null
            })()
        }
    }

    private toStoredMessage(row: any): StoredMessage {
        return {
            id: row.id,
            sessionId: row.session_id,
            content: row.content,
            createdAt: Number(row.created_at),
            seq: row.seq,
            localId: row.local_id
        }
    }

    private toStoredUser(row: any): StoredUser {
        return {
            id: row.id,
            platform: row.platform,
            platformUserId: row.platform_user_id,
            namespace: row.namespace,
            role: (row.role === 'operator' ? 'operator' : 'developer') as UserRole,
            createdAt: Number(row.created_at)
        }
    }

    private toStoredPushSubscription(row: any): StoredPushSubscription {
        return {
            id: row.id,
            namespace: row.namespace,
            endpoint: row.endpoint,
            keys: {
                p256dh: row.keys_p256dh,
                auth: row.keys_auth
            },
            userAgent: row.user_agent,
            clientId: row.client_id,
            chatId: row.chat_id,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAdvisorState(row: any): StoredAdvisorState {
        return {
            namespace: row.namespace,
            advisorSessionId: row.advisor_session_id,
            machineId: row.machine_id,
            status: row.status as 'idle' | 'running' | 'error',
            lastSeen: row.last_seen ? Number(row.last_seen) : null,
            configJson: row.config_json,
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAgentSessionState(row: any): StoredAgentSessionState {
        return {
            sessionId: row.session_id,
            namespace: row.namespace,
            lastSeq: row.last_seq,
            summary: row.summary,
            contextJson: row.context_json,
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAgentMemory(row: any): StoredAgentMemory {
        return {
            id: row.id,
            namespace: row.namespace,
            type: row.type as MemoryType,
            contentJson: row.content_json,
            sourceRef: row.source_ref,
            confidence: row.confidence,
            expiresAt: row.expires_at ? Number(row.expires_at) : null,
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAgentSuggestion(row: any): StoredAgentSuggestion {
        return {
            id: row.id,
            namespace: row.namespace,
            sessionId: row.session_id,
            sourceSessionId: row.source_session_id,
            title: row.title,
            detail: row.detail,
            category: row.category,
            severity: row.severity as 'low' | 'medium' | 'high' | 'critical',
            confidence: row.confidence,
            status: row.status as SuggestionStatus,
            targets: row.targets,
            scope: row.scope as 'session' | 'project' | 'team' | 'global',
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAgentFeedback(row: any): StoredAgentFeedback {
        return {
            id: row.id,
            suggestionId: row.suggestion_id,
            source: row.source as 'user' | 'auto' | 'advisor',
            userId: row.user_id,
            action: row.action as 'accept' | 'reject' | 'defer' | 'supersede',
            evidenceJson: row.evidence_json,
            comment: row.comment,
            createdAt: Number(row.created_at)
        }
    }

    private toStoredAutoIterationConfig(row: any): StoredAutoIterationConfig {
        return {
            namespace: row.namespace,
            enabled: row.enabled === true,
            policyJson: row.policy_json,
            allowedProjects: Array.isArray(row.allowed_projects) ? row.allowed_projects : [],
            notificationLevel: row.notification_level as 'all' | 'errors_only' | 'none',
            keepLogsDays: row.keep_logs_days,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            updatedBy: row.updated_by
        }
    }

    private toStoredAutoIterationLog(row: any): StoredAutoIterationLog {
        return {
            id: row.id,
            namespace: row.namespace,
            sourceSuggestionId: row.source_suggestion_id,
            sourceSessionId: row.source_session_id,
            projectPath: row.project_path,
            actionType: row.action_type as any,
            actionDetail: row.action_detail,
            reason: row.reason,
            executionStatus: row.execution_status as AutoIterExecutionStatus,
            approvalMethod: row.approval_method as any,
            approvedBy: row.approved_by,
            approvedAt: row.approved_at ? Number(row.approved_at) : null,
            resultJson: row.result_json,
            errorMessage: row.error_message,
            rollbackAvailable: row.rollback_available === true,
            rollbackData: row.rollback_data,
            rolledBack: row.rolled_back === true,
            rolledBackAt: row.rolled_back_at ? Number(row.rolled_back_at) : null,
            createdAt: Number(row.created_at),
            executedAt: row.executed_at ? Number(row.executed_at) : null
        }
    }

    private toStoredSessionNotificationSubscription(row: any): StoredSessionNotificationSubscription {
        return {
            id: row.id,
            sessionId: row.session_id,
            chatId: row.chat_id,
            clientId: row.client_id,
            namespace: row.namespace,
            subscribedAt: Number(row.subscribed_at)
        }
    }

    private toStoredAIProfile(row: any): StoredAIProfile {
        const stats = row.stats_json || { tasksCompleted: 0, activeMinutes: 0, lastActiveAt: null }
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id ?? null,
            name: row.name,
            role: row.role as AIProfileRole,
            specialties: Array.isArray(row.specialties) ? row.specialties : [],
            behaviorAnchors: Array.isArray(row.behavior_anchors) ? row.behavior_anchors : [],
            personality: row.personality,
            greetingTemplate: row.greeting_template,
            preferredProjects: Array.isArray(row.preferred_projects) ? row.preferred_projects : [],
            workStyle: row.work_style,
            avatarEmoji: row.avatar_emoji || '🤖',
            status: row.status as AIProfileStatus,
            stats: {
                tasksCompleted: stats.tasksCompleted ?? 0,
                activeMinutes: stats.activeMinutes ?? 0,
                lastActiveAt: stats.lastActiveAt ?? null
            },
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAIProfileMemory(row: any): StoredAIProfileMemory {
        return {
            id: row.id,
            namespace: row.namespace,
            profileId: row.profile_id,
            memoryType: row.memory_type as AIProfileMemoryType,
            content: row.content,
            importance: row.importance,
            accessCount: row.access_count,
            lastAccessedAt: row.last_accessed_at ? Number(row.last_accessed_at) : null,
            expiresAt: row.expires_at ? Number(row.expires_at) : null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            metadata: row.metadata
        }
    }

    private toStoredAITeam(row: any): StoredAITeam {
        const config = row.config_json || { maxMembers: 10, autoAssign: true, sharedKnowledge: true }
        const stats = row.stats_json || { tasksCompleted: 0, activeHours: 0, collaborationScore: 0 }
        return {
            id: row.id,
            namespace: row.namespace,
            name: row.name,
            description: row.description,
            focus: row.focus,
            status: row.status as AITeamStatus,
            config: {
                maxMembers: config.maxMembers ?? 10,
                autoAssign: config.autoAssign ?? true,
                sharedKnowledge: config.sharedKnowledge ?? true
            },
            stats: {
                tasksCompleted: stats.tasksCompleted ?? 0,
                activeHours: stats.activeHours ?? 0,
                collaborationScore: stats.collaborationScore ?? 0
            },
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    private toStoredAITeamMember(row: any): StoredAITeamMember {
        return {
            teamId: row.team_id,
            profileId: row.profile_id,
            role: row.role as AITeamMemberRole,
            joinedAt: Number(row.joined_at),
            contribution: row.contribution,
            specialization: row.specialization
        }
    }

    private toStoredAITeamKnowledge(row: any): StoredAITeamKnowledge {
        return {
            id: row.id,
            teamId: row.team_id,
            namespace: row.namespace,
            title: row.title,
            content: row.content,
            category: row.category as 'best-practice' | 'lesson-learned' | 'decision' | 'convention',
            contributorProfileId: row.contributor_profile_id,
            importance: row.importance,
            accessCount: row.access_count,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    // ========== Feishu Chat Session 操作 ==========

    async createFeishuChatSession(data: {
        feishuChatId: string
        feishuChatType: string
        sessionId: string
        namespace: string
        feishuChatName?: string | null
    }): Promise<{ feishuChatId: string; sessionId: string }> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO feishu_chat_sessions (feishu_chat_id, feishu_chat_type, session_id, namespace, status, created_at, updated_at, feishu_chat_name)
            VALUES ($1, $2, $3, $4, 'active', $5, $5, $6)
            ON CONFLICT (feishu_chat_id) DO UPDATE SET
                session_id = EXCLUDED.session_id,
                status = 'active',
                updated_at = EXCLUDED.updated_at,
                feishu_chat_name = COALESCE(EXCLUDED.feishu_chat_name, feishu_chat_sessions.feishu_chat_name)
        `, [data.feishuChatId, data.feishuChatType, data.sessionId, data.namespace, now, data.feishuChatName ?? null])
        return { feishuChatId: data.feishuChatId, sessionId: data.sessionId }
    }

    async getFeishuChatSession(feishuChatId: string): Promise<{ feishuChatId: string; feishuChatType: string; sessionId: string; namespace: string; status: string; feishuChatName: string | null; createdAt: number; updatedAt: number; lastMessageAt: number | null } | null> {
        const result = await this.pool.query(
            'SELECT * FROM feishu_chat_sessions WHERE feishu_chat_id = $1',
            [feishuChatId]
        )
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            feishuChatId: row.feishu_chat_id,
            feishuChatType: row.feishu_chat_type,
            sessionId: row.session_id,
            namespace: row.namespace,
            status: row.status,
            feishuChatName: row.feishu_chat_name,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            lastMessageAt: row.last_message_at ? Number(row.last_message_at) : null,
        }
    }

    async getActiveFeishuChatSessions(): Promise<Array<{ feishuChatId: string; feishuChatType: string; sessionId: string; namespace: string; feishuChatName: string | null; state: Record<string, unknown> | null }>> {
        const result = await this.pool.query(
            "SELECT feishu_chat_id, feishu_chat_type, session_id, namespace, feishu_chat_name, state FROM feishu_chat_sessions WHERE status = 'active'"
        )
        return result.rows.map((row: any) => ({
            feishuChatId: row.feishu_chat_id,
            feishuChatType: row.feishu_chat_type,
            sessionId: row.session_id,
            namespace: row.namespace,
            feishuChatName: row.feishu_chat_name,
            state: row.state || null,
        }))
    }

    async updateFeishuChatSession(feishuChatId: string, sessionId: string, status: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE feishu_chat_sessions SET session_id = $1, status = $2, updated_at = $3 WHERE feishu_chat_id = $4',
            [sessionId, status, Date.now(), feishuChatId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async updateFeishuChatSessionStatus(feishuChatId: string, status: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE feishu_chat_sessions SET status = $1, updated_at = $2 WHERE feishu_chat_id = $3',
            [status, Date.now(), feishuChatId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async touchFeishuChatSession(feishuChatId: string): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE feishu_chat_sessions SET last_message_at = $1, updated_at = $1 WHERE feishu_chat_id = $2',
            [Date.now(), feishuChatId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async updateFeishuChatState(feishuChatId: string, state: Record<string, unknown>): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE feishu_chat_sessions SET state = $1, updated_at = $2 WHERE feishu_chat_id = $3',
            [JSON.stringify(state), Date.now(), feishuChatId]
        )
        return (result.rowCount ?? 0) > 0
    }

    async deleteFeishuChatSession(feishuChatId: string): Promise<boolean> {
        const result = await this.pool.query(
            'DELETE FROM feishu_chat_sessions WHERE feishu_chat_id = $1',
            [feishuChatId]
        )
        return (result.rowCount ?? 0) > 0
    }

    // === 飞书消息持久化（单聊+群聊） ===

    async saveFeishuChatMessage(data: {
        chatId: string
        messageId: string
        senderOpenId: string
        senderName: string
        messageType: string
        content: string
    }): Promise<void> {
        await this.pool.query(
            `INSERT INTO feishu_chat_messages (chat_id, message_id, sender_open_id, sender_name, message_type, content, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (message_id) DO NOTHING`,
            [data.chatId, data.messageId, data.senderOpenId, data.senderName, data.messageType, data.content, Date.now()]
        )
    }

    async getFeishuChatMessages(chatId: string, limit = 50, beforeTs?: number): Promise<Array<{
        messageId: string
        senderOpenId: string
        senderName: string
        messageType: string
        content: string
        createdAt: number
    }>> {
        const params: unknown[] = [chatId]
        let sql = 'SELECT message_id, sender_open_id, sender_name, message_type, content, created_at FROM feishu_chat_messages WHERE chat_id = $1'
        if (beforeTs) {
            sql += ' AND created_at < $2'
            params.push(beforeTs)
        }
        sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`
        params.push(limit)

        const result = await this.pool.query(sql, params)
        return result.rows.map((r: any) => ({
            messageId: r.message_id,
            senderOpenId: r.sender_open_id,
            senderName: r.sender_name,
            messageType: r.message_type,
            content: r.content,
            createdAt: Number(r.created_at),
        }))
    }

    async cleanOldFeishuChatMessages(olderThanMs: number): Promise<number> {
        const cutoff = Date.now() - olderThanMs
        const result = await this.pool.query(
            'DELETE FROM feishu_chat_messages WHERE created_at < $1',
            [cutoff]
        )
        return result.rowCount ?? 0
    }

    // ========== Brain Config ==========

    async getBrainConfig(namespace: string): Promise<StoredBrainConfig | null> {
        const result = await this.pool.query(
            'SELECT * FROM brain_config WHERE namespace = $1',
            [namespace]
        )
        if (result.rows.length === 0) return null
        const r = result.rows[0]
        return {
            namespace: r.namespace,
            orgId: r.org_id ?? null,
            agent: r.agent,
            claudeModelMode: r.claude_model_mode,
            codexModel: r.codex_model,
            extra: r.extra || {},
            updatedAt: Number(r.updated_at),
            updatedBy: r.updated_by,
        }
    }

    async getBrainConfigByOrg(orgId: string): Promise<StoredBrainConfig | null> {
        const result = await this.pool.query(
            'SELECT * FROM brain_config WHERE org_id = $1',
            [orgId]
        )
        if (result.rows.length === 0) return null
        const r = result.rows[0]
        return {
            namespace: r.namespace,
            orgId: r.org_id ?? null,
            agent: r.agent,
            claudeModelMode: r.claude_model_mode,
            codexModel: r.codex_model,
            extra: r.extra || {},
            updatedAt: Number(r.updated_at),
            updatedBy: r.updated_by,
        }
    }

    async setBrainConfig(namespace: string, config: {
        agent: BrainAgent
        claudeModelMode?: string
        codexModel?: string
        extra?: Record<string, unknown>
        updatedBy?: string | null
    }): Promise<StoredBrainConfig> {
        const now = Date.now()
        const result = await this.pool.query(`
            INSERT INTO brain_config (namespace, agent, claude_model_mode, codex_model, extra, updated_at, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (namespace) DO UPDATE SET
                agent = EXCLUDED.agent,
                claude_model_mode = EXCLUDED.claude_model_mode,
                codex_model = EXCLUDED.codex_model,
                extra = EXCLUDED.extra,
                updated_at = EXCLUDED.updated_at,
                updated_by = EXCLUDED.updated_by
            RETURNING *
        `, [
            namespace,
            config.agent,
            config.claudeModelMode ?? 'opus',
            config.codexModel ?? 'gpt-5.4',
            JSON.stringify(config.extra ?? {}),
            now,
            config.updatedBy ?? null,
        ])
        const r = result.rows[0]
        return {
            namespace: r.namespace,
            orgId: r.org_id ?? null,
            agent: r.agent,
            claudeModelMode: r.claude_model_mode,
            codexModel: r.codex_model,
            extra: r.extra || {},
            updatedAt: Number(r.updated_at),
            updatedBy: r.updated_by,
        }
    }

    async setBrainConfigByOrg(orgId: string, config: {
        agent: BrainAgent
        claudeModelMode?: string
        codexModel?: string
        extra?: Record<string, unknown>
        updatedBy?: string | null
    }): Promise<StoredBrainConfig> {
        const now = Date.now()
        const namespace = `org:${orgId}`
        const result = await this.pool.query(`
            INSERT INTO brain_config (namespace, org_id, agent, claude_model_mode, codex_model, extra, updated_at, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (namespace) DO UPDATE SET
                org_id = EXCLUDED.org_id,
                agent = EXCLUDED.agent,
                claude_model_mode = EXCLUDED.claude_model_mode,
                codex_model = EXCLUDED.codex_model,
                extra = EXCLUDED.extra,
                updated_at = EXCLUDED.updated_at,
                updated_by = EXCLUDED.updated_by
            RETURNING *
        `, [
            namespace,
            orgId,
            config.agent,
            config.claudeModelMode ?? 'opus',
            config.codexModel ?? 'gpt-5.4',
            JSON.stringify(config.extra ?? {}),
            now,
            config.updatedBy ?? null,
        ])
        const r = result.rows[0]
        return {
            namespace: r.namespace,
            orgId: r.org_id ?? null,
            agent: r.agent,
            claudeModelMode: r.claude_model_mode,
            codexModel: r.codex_model,
            extra: r.extra || {},
            updatedAt: Number(r.updated_at),
            updatedBy: r.updated_by,
        }
    }

    async getUserSelfSystemConfig(orgId: string, userEmail: string): Promise<StoredUserSelfSystemConfig | null> {
        const result = await this.pool.query(
            'SELECT * FROM user_self_system_settings WHERE org_id = $1 AND user_email = $2',
            [orgId, this.normalizeEmail(userEmail)]
        )
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            orgId: row.org_id,
            userEmail: row.user_email,
            enabled: row.enabled === true,
            defaultProfileId: row.default_profile_id ?? null,
            memoryProvider: row.memory_provider === 'none' ? 'none' : 'yoho-memory',
            updatedAt: Number(row.updated_at),
            updatedBy: row.updated_by ?? null,
        }
    }

    async setUserSelfSystemConfig(input: {
        orgId: string
        userEmail: string
        enabled: boolean
        defaultProfileId?: string | null
        memoryProvider: 'yoho-memory' | 'none'
        updatedBy?: string | null
    }): Promise<StoredUserSelfSystemConfig> {
        const now = Date.now()
        const normalizedEmail = this.normalizeEmail(input.userEmail)
        const result = await this.pool.query(`
            INSERT INTO user_self_system_settings (
                org_id, user_email, enabled, default_profile_id, memory_provider, updated_at, updated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (org_id, user_email) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                default_profile_id = EXCLUDED.default_profile_id,
                memory_provider = EXCLUDED.memory_provider,
                updated_at = EXCLUDED.updated_at,
                updated_by = EXCLUDED.updated_by
            RETURNING *
        `, [
            input.orgId,
            normalizedEmail,
            input.enabled,
            input.defaultProfileId ?? null,
            input.memoryProvider,
            now,
            input.updatedBy ?? null,
        ])
        const row = result.rows[0]
        return {
            orgId: row.org_id,
            userEmail: row.user_email,
            enabled: row.enabled === true,
            defaultProfileId: row.default_profile_id ?? null,
            memoryProvider: row.memory_provider === 'none' ? 'none' : 'yoho-memory',
            updatedAt: Number(row.updated_at),
            updatedBy: row.updated_by ?? null,
        }
    }

    async clearSelfSystemProfileReferences(
        orgId: string,
        profileId: string,
        updatedBy?: string | null,
    ): Promise<{ clearedUserConfigs: number; clearedOrgConfig: boolean }> {
        const now = Date.now()
        const userResult = await this.pool.query(`
            UPDATE user_self_system_settings
            SET enabled = false,
                default_profile_id = NULL,
                updated_at = $3,
                updated_by = $4
            WHERE org_id = $1 AND default_profile_id = $2
        `, [
            orgId,
            profileId,
            now,
            updatedBy ?? null,
        ])

        let clearedOrgConfig = false
        const currentBrainConfig = await this.getBrainConfigByOrg(orgId)
        const currentExtra = isRecord(currentBrainConfig?.extra) ? currentBrainConfig.extra : null
        const currentSelfSystem = currentExtra && isRecord(currentExtra.selfSystem)
            ? currentExtra.selfSystem
            : null
        const currentDefaultProfileId = typeof currentSelfSystem?.defaultProfileId === 'string'
            ? currentSelfSystem.defaultProfileId.trim()
            : ''

        if (currentBrainConfig && currentDefaultProfileId === profileId) {
            await this.setBrainConfigByOrg(orgId, {
                agent: currentBrainConfig.agent,
                claudeModelMode: currentBrainConfig.claudeModelMode,
                codexModel: currentBrainConfig.codexModel,
                extra: {
                    ...currentBrainConfig.extra,
                    selfSystem: {
                        ...currentSelfSystem,
                        enabled: false,
                        defaultProfileId: null,
                    },
                },
                updatedBy: updatedBy ?? null,
            })
            clearedOrgConfig = true
        }

        return {
            clearedUserConfigs: userResult.rowCount ?? 0,
            clearedOrgConfig,
        }
    }

    async deleteAIProfileWithSelfSystemCleanup(
        orgId: string,
        profileId: string,
        updatedBy?: string | null,
    ): Promise<boolean> {
        const client = await this.pool.connect()
        const now = Date.now()
        try {
            await client.query('BEGIN')

            const brainConfigNamespace = `org:${orgId}`
            const brainConfigResult = await client.query(
                'SELECT * FROM brain_config WHERE namespace = $1 FOR UPDATE',
                [brainConfigNamespace],
            )
            if (brainConfigResult.rows.length > 0) {
                const row = brainConfigResult.rows[0]
                const extra = isRecord(row.extra) ? row.extra : {}
                const selfSystem = isRecord(extra.selfSystem) ? extra.selfSystem : null
                const currentDefaultProfileId = typeof selfSystem?.defaultProfileId === 'string'
                    ? selfSystem.defaultProfileId.trim()
                    : ''
                if (currentDefaultProfileId === profileId) {
                    await client.query(`
                        UPDATE brain_config
                        SET extra = $1,
                            updated_at = $2,
                            updated_by = $3
                        WHERE namespace = $4
                    `, [
                        JSON.stringify({
                            ...extra,
                            selfSystem: {
                                ...selfSystem,
                                enabled: false,
                                defaultProfileId: null,
                            },
                        }),
                        now,
                        updatedBy ?? null,
                        brainConfigNamespace,
                    ])
                }
            }

            await client.query(`
                UPDATE user_self_system_settings
                SET enabled = false,
                    default_profile_id = NULL,
                    updated_at = $3,
                    updated_by = $4
                WHERE org_id = $1 AND default_profile_id = $2
            `, [
                orgId,
                profileId,
                now,
                updatedBy ?? null,
            ])

            const deleteResult = await client.query(
                'DELETE FROM ai_profiles WHERE id = $1 AND org_id = $2',
                [profileId, orgId],
            )
            if ((deleteResult.rowCount ?? 0) === 0) {
                await client.query('ROLLBACK')
                return false
            }

            await client.query('COMMIT')
            return true
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }

    // ========== Organization 操作 ==========

    private toStoredOrganization(row: any): StoredOrganization {
        return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            createdBy: row.created_by,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            settings: row.settings ?? {},
        }
    }

    private toStoredOrgMember(row: any): StoredOrgMember {
        return {
            orgId: row.org_id,
            userEmail: row.user_email,
            userId: row.user_id,
            role: row.role as OrgRole,
            joinedAt: Number(row.joined_at),
            invitedBy: row.invited_by,
        }
    }

    private toStoredOrgInvitation(row: any): StoredOrgInvitation {
        return {
            id: row.id,
            orgId: row.org_id,
            email: row.email,
            role: row.role as OrgRole,
            invitedBy: row.invited_by,
            createdAt: Number(row.created_at),
            expiresAt: Number(row.expires_at),
            acceptedAt: row.accepted_at ? Number(row.accepted_at) : null,
        }
    }

    private normalizeEmail(email: string): string {
        return email.trim().toLowerCase()
    }

    private normalizeOptionalEmail(email: string | null | undefined): string | null {
        const trimmed = email?.trim()
        return trimmed ? trimmed.toLowerCase() : null
    }

    private normalizeOptionalString(value: string | null | undefined): string | null {
        const trimmed = value?.trim()
        return trimmed ? trimmed : null
    }

    private toStoredPerson(row: any): StoredPerson {
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id ?? null,
            personType: row.person_type,
            status: row.status,
            canonicalName: row.canonical_name ?? null,
            primaryEmail: row.primary_email ?? null,
            employeeCode: row.employee_code ?? null,
            avatarUrl: row.avatar_url ?? null,
            attributes: row.attributes ?? {},
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            createdBy: row.created_by ?? null,
            mergedIntoPersonId: row.merged_into_person_id ?? null,
        }
    }

    private toStoredPersonIdentity(row: any): StoredPersonIdentity {
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id ?? null,
            channel: row.channel,
            providerTenantId: row.provider_tenant_id ? row.provider_tenant_id : null,
            externalId: row.external_id,
            secondaryId: row.secondary_id ?? null,
            accountType: row.account_type,
            assurance: row.assurance,
            canonicalEmail: row.canonical_email ?? null,
            displayName: row.display_name ?? null,
            loginName: row.login_name ?? null,
            employeeCode: row.employee_code ?? null,
            status: row.status,
            attributes: row.attributes ?? {},
            firstSeenAt: Number(row.first_seen_at),
            lastSeenAt: Number(row.last_seen_at),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }
    }

    private toStoredPersonIdentityLink(row: any): StoredPersonIdentityLink {
        return {
            id: row.id,
            personId: row.person_id,
            identityId: row.identity_id,
            relationType: row.relation_type,
            state: row.state,
            confidence: Number(row.confidence),
            source: row.source,
            evidence: Array.isArray(row.evidence) ? row.evidence : [],
            decisionReason: row.decision_reason ?? null,
            validFrom: Number(row.valid_from),
            validTo: row.valid_to ? Number(row.valid_to) : null,
            decidedBy: row.decided_by ?? null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }
    }

    private toStoredPersonIdentityAudit(row: any): StoredPersonIdentityAudit {
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id ?? null,
            action: row.action as PersonIdentityAuditAction,
            actorEmail: row.actor_email ?? null,
            personId: row.person_id ?? null,
            targetPersonId: row.target_person_id ?? null,
            identityId: row.identity_id ?? null,
            linkId: row.link_id ?? null,
            reason: row.reason ?? null,
            payload: row.payload ?? {},
            createdAt: Number(row.created_at),
        }
    }

    private toStoredCommunicationPlan(row: any): StoredCommunicationPlan {
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id ?? null,
            personId: row.person_id,
            preferences: (row.preferences ?? {}) as CommunicationPlanPreferences,
            enabled: row.enabled === true,
            version: Number(row.version ?? 1),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            updatedBy: row.updated_by ?? null,
        }
    }

    private toStoredCommunicationPlanAudit(row: any): StoredCommunicationPlanAudit {
        return {
            id: row.id,
            namespace: row.namespace,
            orgId: row.org_id ?? null,
            planId: row.plan_id,
            personId: row.person_id,
            action: row.action as CommunicationPlanAuditAction,
            priorPreferences: (row.prior_preferences ?? null) as CommunicationPlanPreferences | null,
            newPreferences: (row.new_preferences ?? null) as CommunicationPlanPreferences | null,
            priorEnabled: row.prior_enabled === null || row.prior_enabled === undefined ? null : row.prior_enabled === true,
            newEnabled: row.new_enabled === null || row.new_enabled === undefined ? null : row.new_enabled === true,
            actorEmail: row.actor_email ?? null,
            reason: row.reason ?? null,
            createdAt: Number(row.created_at),
        }
    }

    private buildResolvedActor(
        identity: StoredPersonIdentity,
        person: StoredPerson | null,
        resolution: ResolvedActorContext['resolution'],
    ): ResolvedActorContext {
        return {
            identityId: identity.id,
            personId: person?.id ?? null,
            channel: identity.channel,
            resolution,
            displayName: identity.displayName ?? person?.canonicalName ?? null,
            email: identity.canonicalEmail ?? person?.primaryEmail ?? null,
            externalId: identity.externalId,
            accountType: identity.accountType,
        }
    }

    private async findPersonsByExactEmail(namespace: string, orgId: string | null | undefined, email: string): Promise<StoredPerson[]> {
        const result = await this.pool.query(
            `SELECT * FROM persons
             WHERE namespace = $1
               AND org_id IS NOT DISTINCT FROM $2
               AND LOWER(primary_email) = $3
               AND status = 'active'
             ORDER BY created_at ASC`,
            [namespace, orgId ?? null, this.normalizeEmail(email)]
        )
        return result.rows.map((row: any) => this.toStoredPerson(row))
    }

    private async findPersonsByEmployeeCode(namespace: string, orgId: string | null | undefined, employeeCode: string): Promise<StoredPerson[]> {
        const result = await this.pool.query(
            `SELECT * FROM persons
             WHERE namespace = $1
               AND org_id IS NOT DISTINCT FROM $2
               AND employee_code = $3
               AND status = 'active'
             ORDER BY created_at ASC`,
            [namespace, orgId ?? null, employeeCode]
        )
        return result.rows.map((row: any) => this.toStoredPerson(row))
    }

    async createOrganization(data: { name: string; slug: string; createdBy: string }): Promise<StoredOrganization | null> {
        const now = Date.now()
        const id = randomUUID()
        try {
            await this.pool.query(
                `INSERT INTO organizations (id, name, slug, created_by, created_at, updated_at, settings)
                 VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
                [id, data.name, data.slug, data.createdBy, now, now]
            )
            return { id, name: data.name, slug: data.slug, createdBy: data.createdBy, createdAt: now, updatedAt: now, settings: {} }
        } catch (e: any) {
            if (e.code === '23505') return null // unique violation (slug)
            throw e
        }
    }

    async getOrganization(id: string): Promise<StoredOrganization | null> {
        const result = await this.pool.query('SELECT * FROM organizations WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredOrganization(result.rows[0]) : null
    }

    async getOrganizationBySlug(slug: string): Promise<StoredOrganization | null> {
        const result = await this.pool.query('SELECT * FROM organizations WHERE slug = $1', [slug])
        return result.rows.length > 0 ? this.toStoredOrganization(result.rows[0]) : null
    }

    async getAllOrganizations(): Promise<StoredOrganization[]> {
        const result = await this.pool.query(
            'SELECT * FROM organizations ORDER BY created_at ASC, name ASC'
        )
        return result.rows.map((row: any) => this.toStoredOrganization(row))
    }

    async getOrganizationsForUser(email: string): Promise<(StoredOrganization & { myRole: OrgRole })[]> {
        const normalizedEmail = this.normalizeEmail(email)
        const result = await this.pool.query(
            `SELECT o.*, m.role as my_role FROM organizations o
             INNER JOIN org_members m ON o.id = m.org_id
             WHERE LOWER(m.user_email) = $1
             ORDER BY o.created_at ASC`,
            [normalizedEmail]
        )
        return result.rows.map((r: any) => ({
            ...this.toStoredOrganization(r),
            myRole: r.my_role as OrgRole,
        }))
    }

    async updateOrganization(id: string, data: { name?: string; settings?: Record<string, unknown> }): Promise<StoredOrganization | null> {
        const sets: string[] = ['updated_at = $2']
        const params: unknown[] = [id, Date.now()]
        let idx = 3

        if (data.name !== undefined) {
            sets.push(`name = $${idx}`)
            params.push(data.name)
            idx++
        }
        if (data.settings !== undefined) {
            sets.push(`settings = $${idx}`)
            params.push(JSON.stringify(data.settings))
            idx++
        }

        const result = await this.pool.query(
            `UPDATE organizations SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
            params
        )
        return result.rows.length > 0 ? this.toStoredOrganization(result.rows[0]) : null
    }

    async deleteOrganization(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM organizations WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Org Member 操作 ==========

    async addOrgMember(data: { orgId: string; userEmail: string; userId: string; role: OrgRole; invitedBy?: string }): Promise<StoredOrgMember | null> {
        const now = Date.now()
        const normalizedEmail = this.normalizeEmail(data.userEmail)
        try {
            await this.pool.query(
                `INSERT INTO org_members (org_id, user_email, user_id, role, joined_at, invited_by)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [data.orgId, normalizedEmail, data.userId, data.role, now, data.invitedBy ?? null]
            )
            return { orgId: data.orgId, userEmail: normalizedEmail, userId: data.userId, role: data.role, joinedAt: now, invitedBy: data.invitedBy ?? null }
        } catch (e: any) {
            if (e.code === '23505') return null // already a member
            throw e
        }
    }

    async getOrgMembers(orgId: string): Promise<StoredOrgMember[]> {
        const result = await this.pool.query(
            'SELECT * FROM org_members WHERE org_id = $1 ORDER BY joined_at ASC',
            [orgId]
        )
        return result.rows.map((r: any) => this.toStoredOrgMember(r))
    }

    async getOrgMember(orgId: string, email: string): Promise<StoredOrgMember | null> {
        const normalizedEmail = this.normalizeEmail(email)
        const result = await this.pool.query(
            'SELECT * FROM org_members WHERE org_id = $1 AND LOWER(user_email) = $2',
            [orgId, normalizedEmail]
        )
        return result.rows.length > 0 ? this.toStoredOrgMember(result.rows[0]) : null
    }

    async updateOrgMemberRole(orgId: string, email: string, role: OrgRole): Promise<boolean> {
        const normalizedEmail = this.normalizeEmail(email)
        const result = await this.pool.query(
            'UPDATE org_members SET role = $3, user_email = $4 WHERE org_id = $1 AND LOWER(user_email) = $2',
            [orgId, normalizedEmail, role, normalizedEmail]
        )
        return (result.rowCount ?? 0) > 0
    }

    async removeOrgMember(orgId: string, email: string): Promise<boolean> {
        const normalizedEmail = this.normalizeEmail(email)
        const result = await this.pool.query(
            'DELETE FROM org_members WHERE org_id = $1 AND LOWER(user_email) = $2',
            [orgId, normalizedEmail]
        )
        return (result.rowCount ?? 0) > 0
    }

    async getUserOrgRole(orgId: string, email: string): Promise<OrgRole | null> {
        const normalizedEmail = this.normalizeEmail(email)
        const result = await this.pool.query(
            'SELECT role FROM org_members WHERE org_id = $1 AND LOWER(user_email) = $2',
            [orgId, normalizedEmail]
        )
        return result.rows.length > 0 ? result.rows[0].role as OrgRole : null
    }

    // ========== Org Invitation 操作 ==========

    async createOrgInvitation(data: { orgId: string; email: string; role: OrgRole; invitedBy: string; expiresAt: number }): Promise<StoredOrgInvitation | null> {
        const now = Date.now()
        const id = randomUUID()
        const normalizedEmail = this.normalizeEmail(data.email)

        const existing = await this.pool.query(
            `UPDATE org_invitations
             SET email = $3, role = $4, invited_by = $5, created_at = $6, expires_at = $7, accepted_at = NULL
             WHERE org_id = $1 AND LOWER(email) = $2
             RETURNING *`,
            [data.orgId, normalizedEmail, normalizedEmail, data.role, data.invitedBy, now, data.expiresAt]
        )
        if (existing.rows.length > 0) {
            return this.toStoredOrgInvitation(existing.rows[0])
        }

        const result = await this.pool.query(
            `INSERT INTO org_invitations (id, org_id, email, role, invited_by, created_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [id, data.orgId, normalizedEmail, data.role, data.invitedBy, now, data.expiresAt]
        )
        return result.rows.length > 0 ? this.toStoredOrgInvitation(result.rows[0]) : null
    }

    async getOrgInvitations(orgId: string): Promise<StoredOrgInvitation[]> {
        const result = await this.pool.query(
            'SELECT * FROM org_invitations WHERE org_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC',
            [orgId]
        )
        return result.rows.map((r: any) => this.toStoredOrgInvitation(r))
    }

    async getPendingInvitationsForUser(email: string): Promise<(StoredOrgInvitation & { orgName: string })[]> {
        const now = Date.now()
        const normalizedEmail = this.normalizeEmail(email)
        const result = await this.pool.query(
            `SELECT i.*, o.name as org_name FROM org_invitations i
             INNER JOIN organizations o ON i.org_id = o.id
             WHERE LOWER(i.email) = $1 AND i.accepted_at IS NULL AND i.expires_at > $2
             ORDER BY i.created_at DESC`,
            [normalizedEmail, now]
        )
        return result.rows.map((r: any) => ({
            ...this.toStoredOrgInvitation(r),
            orgName: r.org_name,
        }))
    }

    async acceptOrgInvitation(id: string, userId: string, email: string): Promise<string | null> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const now = Date.now()
            const normalizedEmail = this.normalizeEmail(email)

            // Get invitation and verify it belongs to this user
            const invResult = await client.query(
                'SELECT * FROM org_invitations WHERE id = $1 AND LOWER(email) = $2 AND accepted_at IS NULL AND expires_at > $3',
                [id, normalizedEmail, now]
            )
            if (invResult.rows.length === 0) {
                try { await client.query('ROLLBACK') } catch {}
                return null
            }

            const inv = invResult.rows[0]

            // Mark as accepted
            await client.query(
                'UPDATE org_invitations SET accepted_at = $2 WHERE id = $1',
                [id, now]
            )

            // Add as member, while repairing case-only email drift in existing rows.
            const updateResult = await client.query(
                `UPDATE org_members
                 SET user_email = $3, user_id = $4, role = $5, invited_by = $6
                 WHERE org_id = $1 AND LOWER(user_email) = $2
                 RETURNING org_id`,
                [inv.org_id, normalizedEmail, normalizedEmail, userId, inv.role, inv.invited_by]
            )
            if (updateResult.rows.length === 0) {
                await client.query(
                    `INSERT INTO org_members (org_id, user_email, user_id, role, joined_at, invited_by)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [inv.org_id, normalizedEmail, userId, inv.role, now, inv.invited_by]
                )
            }

            await client.query('COMMIT')
            return inv.org_id as string
        } catch (e) {
            try { await client.query('ROLLBACK') } catch {}
            throw e
        } finally {
            client.release()
        }
    }

    async deleteOrgInvitation(id: string, orgId?: string): Promise<boolean> {
        if (orgId) {
            const result = await this.pool.query('DELETE FROM org_invitations WHERE id = $1 AND org_id = $2', [id, orgId])
            return (result.rowCount ?? 0) > 0
        }
        const result = await this.pool.query('DELETE FROM org_invitations WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Identity Graph 操作 ==========

    async createPerson(data: {
        namespace: string
        orgId?: string | null
        personType?: StoredPerson['personType']
        canonicalName?: string | null
        primaryEmail?: string | null
        employeeCode?: string | null
        avatarUrl?: string | null
        attributes?: Record<string, unknown>
        createdBy?: string | null
    }): Promise<StoredPerson> {
        const now = Date.now()
        const id = randomUUID()
        const result = await this.pool.query(
            `INSERT INTO persons (
                id, namespace, org_id, person_type, status, canonical_name,
                primary_email, employee_code, avatar_url, attributes,
                created_at, updated_at, created_by, merged_into_person_id
             ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $10, $11, NULL)
             RETURNING *`,
            [
                id,
                data.namespace,
                data.orgId ?? null,
                data.personType ?? 'human',
                this.normalizeOptionalString(data.canonicalName),
                this.normalizeOptionalEmail(data.primaryEmail),
                this.normalizeOptionalString(data.employeeCode),
                this.normalizeOptionalString(data.avatarUrl),
                JSON.stringify(data.attributes ?? {}),
                now,
                data.createdBy ?? null,
            ]
        )
        return this.toStoredPerson(result.rows[0])
    }

    async getPerson(id: string): Promise<StoredPerson | null> {
        const result = await this.pool.query('SELECT * FROM persons WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredPerson(result.rows[0]) : null
    }

    async getPersonWithIdentities(options: {
        namespace: string
        orgId?: string | null
        personId: string
    }): Promise<{
        person: StoredPerson
        identities: Array<{ identity: StoredPersonIdentity; link: StoredPersonIdentityLink }>
    } | null> {
        const personResult = await this.pool.query(
            `SELECT * FROM persons
             WHERE id = $1
               AND namespace = $2
               AND org_id IS NOT DISTINCT FROM $3`,
            [options.personId, options.namespace, options.orgId ?? null]
        )
        if (personResult.rows.length === 0) {
            return null
        }
        const person = this.toStoredPerson(personResult.rows[0])

        const linksResult = await this.pool.query(
            `SELECT * FROM person_identity_links
             WHERE person_id = $1
               AND valid_to IS NULL
               AND state IN ('auto_verified', 'admin_verified')
             ORDER BY confidence DESC, updated_at DESC`,
            [options.personId]
        )

        if (linksResult.rows.length === 0) {
            return { person, identities: [] }
        }

        const links: StoredPersonIdentityLink[] = linksResult.rows.map((row: any) => this.toStoredPersonIdentityLink(row))
        const identityIds = links.map((link) => link.identityId)

        const identitiesResult = await this.pool.query(
            'SELECT * FROM person_identities WHERE id = ANY($1::text[])',
            [identityIds]
        )
        const identityMap = new Map<string, StoredPersonIdentity>()
        for (const row of identitiesResult.rows) {
            const identity = this.toStoredPersonIdentity(row)
            identityMap.set(identity.id, identity)
        }

        const identities: Array<{ identity: StoredPersonIdentity; link: StoredPersonIdentityLink }> = []
        for (const link of links) {
            const identity = identityMap.get(link.identityId)
            if (identity) {
                identities.push({ identity, link })
            }
        }

        return { person, identities }
    }

    async searchPersons(options: {
        namespace: string
        orgId?: string | null
        q?: string | null
        limit?: number
    }): Promise<StoredPerson[]> {
        const q = this.normalizeOptionalString(options.q)
        const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
        const params: unknown[] = [options.namespace, options.orgId ?? null]
        let sql = `
            SELECT * FROM persons
            WHERE namespace = $1
              AND org_id IS NOT DISTINCT FROM $2
              AND status <> 'merged'
        `
        if (q) {
            params.push(`%${q.toLowerCase()}%`)
            sql += ` AND (
                LOWER(COALESCE(canonical_name, '')) LIKE $${params.length}
                OR LOWER(COALESCE(primary_email, '')) LIKE $${params.length}
                OR LOWER(COALESCE(employee_code, '')) LIKE $${params.length}
            )`
        }
        params.push(limit)
        sql += ` ORDER BY updated_at DESC, created_at DESC LIMIT $${params.length}`
        const result = await this.pool.query(sql, params)
        return result.rows.map((row: any) => this.toStoredPerson(row))
    }

    async upsertPersonIdentity(observation: IdentityObservation): Promise<StoredPersonIdentity> {
        const now = Date.now()
        const providerTenantId = this.normalizeOptionalString(observation.providerTenantId) ?? ''
        const result = await this.pool.query(
            `INSERT INTO person_identities (
                id, namespace, org_id, channel, provider_tenant_id, external_id,
                secondary_id, account_type, assurance, canonical_email, display_name,
                login_name, employee_code, status, attributes, first_seen_at,
                last_seen_at, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active', $14, $15, $15, $15, $15)
             ON CONFLICT (channel, provider_tenant_id, external_id) DO UPDATE SET
                namespace = EXCLUDED.namespace,
                org_id = EXCLUDED.org_id,
                secondary_id = COALESCE(EXCLUDED.secondary_id, person_identities.secondary_id),
                account_type = EXCLUDED.account_type,
                assurance = EXCLUDED.assurance,
                canonical_email = COALESCE(EXCLUDED.canonical_email, person_identities.canonical_email),
                display_name = COALESCE(EXCLUDED.display_name, person_identities.display_name),
                login_name = COALESCE(EXCLUDED.login_name, person_identities.login_name),
                employee_code = COALESCE(EXCLUDED.employee_code, person_identities.employee_code),
                attributes = person_identities.attributes || EXCLUDED.attributes,
                last_seen_at = EXCLUDED.last_seen_at,
                updated_at = EXCLUDED.updated_at
             RETURNING *`,
            [
                randomUUID(),
                observation.namespace,
                observation.orgId ?? null,
                observation.channel,
                providerTenantId,
                observation.externalId.trim(),
                this.normalizeOptionalString(observation.secondaryId),
                observation.accountType ?? 'human',
                observation.assurance,
                this.normalizeOptionalEmail(observation.canonicalEmail),
                this.normalizeOptionalString(observation.displayName),
                this.normalizeOptionalString(observation.loginName),
                this.normalizeOptionalString(observation.employeeCode),
                JSON.stringify(observation.attributes ?? {}),
                now,
            ]
        )
        return this.toStoredPersonIdentity(result.rows[0])
    }

    async getPersonIdentity(id: string): Promise<StoredPersonIdentity | null> {
        const result = await this.pool.query('SELECT * FROM person_identities WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredPersonIdentity(result.rows[0]) : null
    }

    async findResolvedActorByChannelExternalId(channel: IdentityChannel, externalId: string): Promise<ResolvedActorContext | null> {
        const normalizedExternalId = this.normalizeOptionalString(externalId)
        if (!normalizedExternalId) {
            return null
        }

        const result = await this.pool.query(
            `SELECT * FROM person_identities
             WHERE channel = $1
               AND external_id = $2
             ORDER BY updated_at DESC`,
            [channel, normalizedExternalId]
        )
        if (result.rows.length !== 1) {
            return null
        }

        const identity = this.toStoredPersonIdentity(result.rows[0])
        const activeLink = await this.getActiveIdentityLink(identity.id)
        if (!activeLink) {
            return this.buildResolvedActor(identity, null, 'unresolved')
        }

        let linkedPerson = await this.getPerson(activeLink.personId)
        if (linkedPerson?.status === 'merged' && linkedPerson.mergedIntoPersonId) {
            linkedPerson = await this.getPerson(linkedPerson.mergedIntoPersonId) ?? linkedPerson
        }
        return this.buildResolvedActor(identity, linkedPerson, activeLink.state)
    }

    async getActiveIdentityLink(identityId: string): Promise<StoredPersonIdentityLink | null> {
        const result = await this.pool.query(
            `SELECT * FROM person_identity_links
             WHERE identity_id = $1
               AND valid_to IS NULL
               AND state IN ('auto_verified', 'admin_verified')
             ORDER BY confidence DESC, updated_at DESC
             LIMIT 1`,
            [identityId]
        )
        return result.rows.length > 0 ? this.toStoredPersonIdentityLink(result.rows[0]) : null
    }

    async createPersonIdentityLink(data: {
        personId: string
        identityId: string
        relationType?: StoredPersonIdentityLink['relationType']
        state: StoredPersonIdentityLink['state']
        confidence?: number
        source: StoredPersonIdentityLink['source']
        evidence?: unknown[]
        decisionReason?: string | null
        decidedBy?: string | null
    }): Promise<StoredPersonIdentityLink> {
        const now = Date.now()
        const result = await this.pool.query(
            `INSERT INTO person_identity_links (
                id, person_id, identity_id, relation_type, state, confidence,
                source, evidence, decision_reason, valid_from, valid_to,
                decided_by, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $10, $10)
             RETURNING *`,
            [
                randomUUID(),
                data.personId,
                data.identityId,
                data.relationType ?? 'primary',
                data.state,
                data.confidence ?? 0,
                data.source,
                JSON.stringify(data.evidence ?? []),
                data.decisionReason ?? null,
                now,
                data.decidedBy ?? null,
            ]
        )
        return this.toStoredPersonIdentityLink(result.rows[0])
    }

    private async insertPersonIdentityAudit(
        queryable: Queryable,
        data: {
            namespace: string
            orgId?: string | null
            action: PersonIdentityAuditAction
            actorEmail?: string | null
            personId?: string | null
            targetPersonId?: string | null
            identityId?: string | null
            linkId?: string | null
            reason?: string | null
            payload?: unknown
            createdAt?: number
        },
    ): Promise<StoredPersonIdentityAudit> {
        const createdAt = data.createdAt ?? Date.now()
        const result = await queryable.query(
            `INSERT INTO person_identity_audits (
                id, namespace, org_id, action, actor_email, person_id,
                target_person_id, identity_id, link_id, reason, payload, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
                randomUUID(),
                data.namespace,
                data.orgId ?? null,
                data.action,
                data.actorEmail ?? null,
                data.personId ?? null,
                data.targetPersonId ?? null,
                data.identityId ?? null,
                data.linkId ?? null,
                data.reason ?? null,
                data.payload ?? {},
                createdAt,
            ],
        )
        return this.toStoredPersonIdentityAudit(result.rows[0])
    }


    async mergePersons(data: {
        namespace: string
        orgId?: string | null
        sourcePersonId: string
        targetPersonId: string
        reason?: string | null
        decidedBy?: string | null
    }): Promise<StoredPerson | null> {
        if (data.sourcePersonId === data.targetPersonId) {
            throw new Error('sourcePersonId and targetPersonId must be different')
        }

        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const sourceResult = await client.query(
                `SELECT * FROM persons
                 WHERE id = $1
                   AND namespace = $2
                   AND org_id IS NOT DISTINCT FROM $3
                 FOR UPDATE`,
                [data.sourcePersonId, data.namespace, data.orgId ?? null],
            )
            const targetResult = await client.query(
                `SELECT * FROM persons
                 WHERE id = $1
                   AND namespace = $2
                   AND org_id IS NOT DISTINCT FROM $3
                 FOR UPDATE`,
                [data.targetPersonId, data.namespace, data.orgId ?? null],
            )
            if (sourceResult.rows.length === 0 || targetResult.rows.length === 0) {
                await client.query('ROLLBACK')
                return null
            }

            const source = this.toStoredPerson(sourceResult.rows[0])
            const target = this.toStoredPerson(targetResult.rows[0])
            if (source.status === 'merged') {
                throw new Error('source person is already merged')
            }
            if (target.status === 'merged') {
                throw new Error('target person is merged')
            }

            const now = Date.now()
            const updateResult = await client.query(
                `UPDATE persons
                 SET status = 'merged',
                     merged_into_person_id = $2,
                     updated_at = $3
                 WHERE id = $1
                 RETURNING *`,
                [source.id, target.id, now],
            )
            const merged = this.toStoredPerson(updateResult.rows[0])
            await this.insertPersonIdentityAudit(client, {
                namespace: data.namespace,
                orgId: data.orgId ?? null,
                action: 'merge_persons',
                actorEmail: data.decidedBy ?? null,
                personId: source.id,
                targetPersonId: target.id,
                reason: data.reason ?? null,
                payload: {
                    sourcePerson: source,
                    targetPerson: target,
                },
                createdAt: now,
            })
            await client.query('COMMIT')
            return merged
        } catch (error) {
            try { await client.query('ROLLBACK') } catch {}
            throw error
        } finally {
            client.release()
        }
    }

    async unmergePerson(data: {
        namespace: string
        orgId?: string | null
        personId: string
        reason?: string | null
        decidedBy?: string | null
    }): Promise<StoredPerson | null> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const personResult = await client.query(
                `SELECT * FROM persons
                 WHERE id = $1
                   AND namespace = $2
                   AND org_id IS NOT DISTINCT FROM $3
                 FOR UPDATE`,
                [data.personId, data.namespace, data.orgId ?? null],
            )
            if (personResult.rows.length === 0) {
                await client.query('ROLLBACK')
                return null
            }

            const person = this.toStoredPerson(personResult.rows[0])
            if (person.status !== 'merged') {
                throw new Error('person is not merged')
            }

            const now = Date.now()
            const updateResult = await client.query(
                `UPDATE persons
                 SET status = 'active',
                     merged_into_person_id = NULL,
                     updated_at = $2
                 WHERE id = $1
                 RETURNING *`,
                [person.id, now],
            )
            const unmerged = this.toStoredPerson(updateResult.rows[0])
            await this.insertPersonIdentityAudit(client, {
                namespace: data.namespace,
                orgId: data.orgId ?? null,
                action: 'unmerge_person',
                actorEmail: data.decidedBy ?? null,
                personId: person.id,
                targetPersonId: person.mergedIntoPersonId,
                reason: data.reason ?? null,
                payload: {
                    personBefore: person,
                },
                createdAt: now,
            })
            await client.query('COMMIT')
            return unmerged
        } catch (error) {
            try { await client.query('ROLLBACK') } catch {}
            throw error
        } finally {
            client.release()
        }
    }

    async detachPersonIdentityLink(data: {
        namespace: string
        orgId?: string | null
        linkId: string
        reason?: string | null
        decidedBy?: string | null
    }): Promise<StoredPersonIdentityLink | null> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const linkResult = await client.query(
                `SELECT l.*
                 FROM person_identity_links l
                 INNER JOIN persons p ON p.id = l.person_id
                 WHERE l.id = $1
                   AND p.namespace = $2
                   AND p.org_id IS NOT DISTINCT FROM $3
                   AND l.valid_to IS NULL
                   AND l.state IN ('auto_verified', 'admin_verified')
                 FOR UPDATE`,
                [data.linkId, data.namespace, data.orgId ?? null],
            )
            if (linkResult.rows.length === 0) {
                await client.query('ROLLBACK')
                return null
            }

            const previousLink = this.toStoredPersonIdentityLink(linkResult.rows[0])
            const now = Date.now()
            const updateResult = await client.query(
                `UPDATE person_identity_links
                 SET state = 'detached',
                     valid_to = $2,
                     decision_reason = $3,
                     decided_by = $4,
                     updated_at = $2
                 WHERE id = $1
                 RETURNING *`,
                [data.linkId, now, data.reason ?? null, data.decidedBy ?? null],
            )
            const detached = this.toStoredPersonIdentityLink(updateResult.rows[0])
            await this.insertPersonIdentityAudit(client, {
                namespace: data.namespace,
                orgId: data.orgId ?? null,
                action: 'detach_identity_link',
                actorEmail: data.decidedBy ?? null,
                personId: previousLink.personId,
                identityId: previousLink.identityId,
                linkId: previousLink.id,
                reason: data.reason ?? null,
                payload: {
                    linkBefore: previousLink,
                },
                createdAt: now,
            })
            await client.query('COMMIT')
            return detached
        } catch (error) {
            try { await client.query('ROLLBACK') } catch {}
            throw error
        } finally {
            client.release()
        }
    }

    async listPersonIdentityAudits(options: {
        namespace: string
        orgId?: string | null
        personId?: string | null
        identityId?: string | null
        limit?: number
    }): Promise<StoredPersonIdentityAudit[]> {
        const params: unknown[] = [options.namespace, options.orgId ?? null]
        let sql = `
            SELECT * FROM person_identity_audits
            WHERE namespace = $1
              AND org_id IS NOT DISTINCT FROM $2
        `
        if (options.personId) {
            params.push(options.personId)
            sql += ` AND (person_id = $${params.length} OR target_person_id = $${params.length})`
        }
        if (options.identityId) {
            params.push(options.identityId)
            sql += ` AND identity_id = $${params.length}`
        }
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
        params.push(limit)
        sql += ` ORDER BY created_at DESC LIMIT $${params.length}`
        const result = await this.pool.query(sql, params)
        return result.rows.map((row) => this.toStoredPersonIdentityAudit(row))
    }

    private async insertCommunicationPlanAudit(
        queryable: Queryable,
        data: {
            namespace: string
            orgId?: string | null
            planId: string
            personId: string
            action: CommunicationPlanAuditAction
            priorPreferences?: CommunicationPlanPreferences | null
            newPreferences?: CommunicationPlanPreferences | null
            priorEnabled?: boolean | null
            newEnabled?: boolean | null
            actorEmail?: string | null
            reason?: string | null
            createdAt?: number
        },
    ): Promise<StoredCommunicationPlanAudit> {
        const createdAt = data.createdAt ?? Date.now()
        const result = await queryable.query(
            `INSERT INTO communication_plan_audits (
                id, namespace, org_id, plan_id, person_id, action,
                prior_preferences, new_preferences, prior_enabled, new_enabled,
                actor_email, reason, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
            [
                randomUUID(),
                data.namespace,
                data.orgId ?? null,
                data.planId,
                data.personId,
                data.action,
                data.priorPreferences === undefined || data.priorPreferences === null
                    ? null
                    : JSON.stringify(data.priorPreferences),
                data.newPreferences === undefined || data.newPreferences === null
                    ? null
                    : JSON.stringify(data.newPreferences),
                data.priorEnabled ?? null,
                data.newEnabled ?? null,
                data.actorEmail ?? null,
                data.reason ?? null,
                createdAt,
            ],
        )
        return this.toStoredCommunicationPlanAudit(result.rows[0])
    }

    async getCommunicationPlanByPerson(options: {
        namespace: string
        orgId?: string | null
        personId: string
    }): Promise<StoredCommunicationPlan | null> {
        const result = await this.pool.query(
            `SELECT * FROM communication_plans
             WHERE namespace = $1
               AND org_id IS NOT DISTINCT FROM $2
               AND person_id = $3
             LIMIT 1`,
            [options.namespace, options.orgId ?? null, options.personId],
        )
        if (result.rows.length === 0) return null
        return this.toStoredCommunicationPlan(result.rows[0])
    }

    async upsertCommunicationPlan(input: {
        namespace: string
        orgId?: string | null
        personId: string
        preferences: CommunicationPlanPreferences
        enabled?: boolean
        editedBy?: string | null
        reason?: string | null
    }): Promise<StoredCommunicationPlan> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const existingResult = await client.query(
                `SELECT * FROM communication_plans
                 WHERE namespace = $1
                   AND org_id IS NOT DISTINCT FROM $2
                   AND person_id = $3
                 FOR UPDATE`,
                [input.namespace, input.orgId ?? null, input.personId],
            )
            const now = Date.now()
            const enabled = input.enabled ?? (existingResult.rows[0]?.enabled ?? true)
            let plan: StoredCommunicationPlan
            let action: CommunicationPlanAuditAction
            let priorPlan: StoredCommunicationPlan | null = null

            if (existingResult.rows.length === 0) {
                const inserted = await client.query(
                    `INSERT INTO communication_plans (
                        id, namespace, org_id, person_id, preferences, enabled,
                        version, created_at, updated_at, updated_by
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     RETURNING *`,
                    [
                        randomUUID(),
                        input.namespace,
                        input.orgId ?? null,
                        input.personId,
                        JSON.stringify(input.preferences),
                        enabled,
                        1,
                        now,
                        now,
                        input.editedBy ?? null,
                    ],
                )
                plan = this.toStoredCommunicationPlan(inserted.rows[0])
                action = 'created'
            } else {
                priorPlan = this.toStoredCommunicationPlan(existingResult.rows[0])
                const updated = await client.query(
                    `UPDATE communication_plans
                     SET preferences = $1,
                         enabled = $2,
                         version = version + 1,
                         updated_at = $3,
                         updated_by = $4
                     WHERE id = $5
                     RETURNING *`,
                    [
                        JSON.stringify(input.preferences),
                        enabled,
                        now,
                        input.editedBy ?? null,
                        priorPlan.id,
                    ],
                )
                plan = this.toStoredCommunicationPlan(updated.rows[0])
                action = 'updated'
            }

            await this.insertCommunicationPlanAudit(client, {
                namespace: plan.namespace,
                orgId: plan.orgId,
                planId: plan.id,
                personId: plan.personId,
                action,
                priorPreferences: priorPlan?.preferences ?? null,
                newPreferences: plan.preferences,
                priorEnabled: priorPlan?.enabled ?? null,
                newEnabled: plan.enabled,
                actorEmail: input.editedBy ?? null,
                reason: input.reason ?? null,
                createdAt: now,
            })
            await client.query('COMMIT')
            return plan
        } catch (error) {
            try { await client.query('ROLLBACK') } catch {}
            throw error
        } finally {
            client.release()
        }
    }

    async setCommunicationPlanEnabled(input: {
        namespace: string
        orgId?: string | null
        personId: string
        enabled: boolean
        editedBy?: string | null
        reason?: string | null
    }): Promise<StoredCommunicationPlan | null> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            const existingResult = await client.query(
                `SELECT * FROM communication_plans
                 WHERE namespace = $1
                   AND org_id IS NOT DISTINCT FROM $2
                   AND person_id = $3
                 FOR UPDATE`,
                [input.namespace, input.orgId ?? null, input.personId],
            )
            if (existingResult.rows.length === 0) {
                await client.query('ROLLBACK')
                return null
            }
            const priorPlan = this.toStoredCommunicationPlan(existingResult.rows[0])
            if (priorPlan.enabled === input.enabled) {
                await client.query('COMMIT')
                return priorPlan
            }
            const now = Date.now()
            const updated = await client.query(
                `UPDATE communication_plans
                 SET enabled = $1,
                     version = version + 1,
                     updated_at = $2,
                     updated_by = $3
                 WHERE id = $4
                 RETURNING *`,
                [input.enabled, now, input.editedBy ?? null, priorPlan.id],
            )
            const plan = this.toStoredCommunicationPlan(updated.rows[0])
            await this.insertCommunicationPlanAudit(client, {
                namespace: plan.namespace,
                orgId: plan.orgId,
                planId: plan.id,
                personId: plan.personId,
                action: input.enabled ? 'enabled' : 'disabled',
                priorPreferences: priorPlan.preferences,
                newPreferences: plan.preferences,
                priorEnabled: priorPlan.enabled,
                newEnabled: plan.enabled,
                actorEmail: input.editedBy ?? null,
                reason: input.reason ?? null,
                createdAt: now,
            })
            await client.query('COMMIT')
            return plan
        } catch (error) {
            try { await client.query('ROLLBACK') } catch {}
            throw error
        } finally {
            client.release()
        }
    }

    async listCommunicationPlanAudits(options: {
        namespace: string
        orgId?: string | null
        personId?: string | null
        planId?: string | null
        limit?: number
    }): Promise<StoredCommunicationPlanAudit[]> {
        const params: unknown[] = [options.namespace, options.orgId ?? null]
        let sql = `
            SELECT * FROM communication_plan_audits
            WHERE namespace = $1
              AND org_id IS NOT DISTINCT FROM $2
        `
        if (options.personId) {
            params.push(options.personId)
            sql += ` AND person_id = $${params.length}`
        }
        if (options.planId) {
            params.push(options.planId)
            sql += ` AND plan_id = $${params.length}`
        }
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 100)
        params.push(limit)
        sql += ` ORDER BY created_at DESC LIMIT $${params.length}`
        const result = await this.pool.query(sql, params)
        return result.rows.map((row) => this.toStoredCommunicationPlanAudit(row))
    }


    async resolveActorByIdentityObservation(observation: IdentityObservation): Promise<ResolvedActorContext> {
        const identity = await this.upsertPersonIdentity(observation)
        const activeLink = await this.getActiveIdentityLink(identity.id)
        if (activeLink) {
            let linkedPerson = await this.getPerson(activeLink.personId)
            if (linkedPerson?.status === 'merged' && linkedPerson.mergedIntoPersonId) {
                linkedPerson = await this.getPerson(linkedPerson.mergedIntoPersonId) ?? linkedPerson
            }
            return this.buildResolvedActor(identity, linkedPerson, activeLink.state)
        }

        if (identity.accountType === 'shared' || identity.accountType === 'service' || identity.accountType === 'bot') {
            return this.buildResolvedActor(identity, null, identity.accountType === 'shared' ? 'shared' : 'unresolved')
        }
        if (identity.assurance === 'low') {
            return this.buildResolvedActor(identity, null, 'unresolved')
        }

        const employeeMatches = identity.employeeCode
            ? await this.findPersonsByEmployeeCode(identity.namespace, identity.orgId, identity.employeeCode)
            : []
        const emailMatches = employeeMatches.length === 0 && identity.canonicalEmail
            ? await this.findPersonsByExactEmail(identity.namespace, identity.orgId, identity.canonicalEmail)
            : []
        const matches = employeeMatches.length > 0 ? employeeMatches : emailMatches

        if (matches.length === 1) {
            await this.createPersonIdentityLink({
                personId: matches[0].id,
                identityId: identity.id,
                state: 'auto_verified',
                confidence: employeeMatches.length > 0 ? 0.98 : 0.95,
                source: 'auto',
                evidence: employeeMatches.length > 0 ? ['employee_code_exact'] : ['email_exact_unique'],
                decisionReason: 'identity resolver auto match',
            })
            return this.buildResolvedActor(identity, matches[0], 'auto_verified')
        }

        if (matches.length > 1) {
            await this.proposeIdentityApproval(identity, {
                score: 0.75,
                risk_flags: ['ambiguous_person_match'],
                evidence: identity.employeeCode ? ['employee_code_multiple'] : ['email_multiple'],
                matcher_version: 'identity-graph-v1',
            })
            return this.buildResolvedActor(identity, null, 'unresolved')
        }

        if (identity.channel === 'keycloak' && identity.canonicalEmail) {
            const person = await this.createPerson({
                namespace: identity.namespace,
                orgId: identity.orgId,
                canonicalName: identity.displayName,
                primaryEmail: identity.canonicalEmail,
                employeeCode: identity.employeeCode,
                createdBy: identity.canonicalEmail,
            })
            await this.createPersonIdentityLink({
                personId: person.id,
                identityId: identity.id,
                state: 'auto_verified',
                confidence: 0.99,
                source: 'auto',
                evidence: ['keycloak_authenticated', 'new_person_from_verified_login'],
                decisionReason: 'first keycloak login for verified email',
            })
            return this.buildResolvedActor(identity, person, 'auto_verified')
        }

        if (identity.canonicalEmail || identity.displayName) {
            await this.proposeIdentityApproval(identity, {
                score: 0.7,
                evidence: ['new_identity_review'],
                matcher_version: 'identity-graph-v1',
            })
        }

        return this.buildResolvedActor(identity, null, 'unresolved')
    }

    /**
     * Internal helper: surface a freshly-detected identity match as an
     * approval candidate in the unified `approvals` schema. Wraps
     * `upsertApproval` so the resolver doesn't need to know about
     * subjectKey conventions or payload-table layout.
     */
    private async proposeIdentityApproval(
        identity: StoredPersonIdentity,
        payload: {
            score: number
            risk_flags?: unknown[]
            evidence: unknown[]
            matcher_version: string
            candidate_person_id?: string | null
            auto_action?: string
            suppress_until?: number | null
        },
    ): Promise<void> {
        if (!identity.orgId) return // approvals.org_id is NOT NULL
        const subjectKey = `id:${identity.id}:${payload.candidate_person_id ?? 'new'}`
        await this.upsertApproval({
            namespace: identity.namespace,
            orgId: identity.orgId,
            domain: 'identity',
            subjectKind: 'identity_candidate',
            subjectKey,
            payloadTable: 'approval_payload_identity',
            payload: {
                identity_id: identity.id,
                candidate_person_id: payload.candidate_person_id ?? null,
                score: payload.score,
                auto_action: payload.auto_action ?? 'review',
                risk_flags: payload.risk_flags ?? [],
                evidence: payload.evidence,
                matcher_version: payload.matcher_version,
                suppress_until: payload.suppress_until ?? null,
            },
        }).catch((err) => {
            // Best-effort: a duplicate or already-decided subject just means
            // the resolver re-detected an existing review item.
            console.warn('[identity] proposeIdentityApproval failed:', err)
        })
    }

    // ========== Org License 操作 ==========

    private toStoredOrgLicense(row: any): StoredOrgLicense {
        return {
            id: row.id,
            orgId: row.org_id,
            startsAt: Number(row.starts_at),
            expiresAt: Number(row.expires_at),
            maxMembers: Number(row.max_members),
            maxConcurrentSessions: row.max_concurrent_sessions != null ? Number(row.max_concurrent_sessions) : null,
            status: row.status as LicenseStatus,
            issuedBy: row.issued_by,
            note: row.note ?? null,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
        }
    }

    async getOrgLicense(orgId: string): Promise<StoredOrgLicense | null> {
        const result = await this.pool.query('SELECT * FROM org_licenses WHERE org_id = $1', [orgId])
        return result.rows.length > 0 ? this.toStoredOrgLicense(result.rows[0]) : null
    }

    async getAllOrgLicenses(): Promise<StoredAdminOrgLicense[]> {
        const result = await this.pool.query(
            `SELECT
                l.*,
                o.name as org_name,
                o.slug as org_slug,
                COUNT(m.user_email)::int as member_count
             FROM org_licenses l
             INNER JOIN organizations o ON l.org_id = o.id
             LEFT JOIN org_members m ON m.org_id = l.org_id
             GROUP BY l.id, o.name, o.slug
             ORDER BY l.created_at DESC`
        )
        return result.rows.map((r: any) => ({
            ...this.toStoredOrgLicense(r),
            orgName: r.org_name,
            orgSlug: r.org_slug,
            memberCount: Number(r.member_count),
        }))
    }

    async upsertOrgLicense(data: {
        orgId: string
        startsAt: number
        expiresAt: number
        maxMembers: number
        maxConcurrentSessions?: number | null
        status?: LicenseStatus
        issuedBy: string
        note?: string | null
    }): Promise<StoredOrgLicense> {
        const now = Date.now()
        const id = randomUUID()
        const status = data.status ?? 'active'
        const result = await this.pool.query(
            `INSERT INTO org_licenses (id, org_id, starts_at, expires_at, max_members, max_concurrent_sessions, status, issued_by, note, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (org_id) DO UPDATE SET
                starts_at = $3, expires_at = $4, max_members = $5, max_concurrent_sessions = $6,
                status = $7, issued_by = $8, note = $9, updated_at = $11
             RETURNING *`,
            [id, data.orgId, data.startsAt, data.expiresAt, data.maxMembers,
             data.maxConcurrentSessions ?? null, status, data.issuedBy, data.note ?? null, now, now]
        )
        return this.toStoredOrgLicense(result.rows[0])
    }

    async updateOrgLicenseStatus(orgId: string, status: LicenseStatus): Promise<boolean> {
        const result = await this.pool.query(
            'UPDATE org_licenses SET status = $2, updated_at = $3 WHERE org_id = $1',
            [orgId, status, Date.now()]
        )
        return (result.rowCount ?? 0) > 0
    }

    async deleteOrgLicense(orgId: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM org_licenses WHERE org_id = $1', [orgId])
        return (result.rowCount ?? 0) > 0
    }
}
