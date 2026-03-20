// PostgreSQL Store 实现
import { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import type { IStore } from './interface'
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
    StoredAgentGroup,
    StoredAgentGroupWithLastMessage,
    StoredAgentGroupMember,
    StoredAgentGroupMessage,
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
    UserRole,
    VersionedUpdateResult,
    SuggestionStatus,
    MemoryType,
    AgentGroupType,
    AgentGroupStatus,
    GroupMemberRole,
    GroupSenderType,
    GroupMessageType,
    AIProfileRole,
    AIProfileStatus,
    AIProfileMemoryType,
    AITeamStatus,
    AITeamMemberRole,
    AutoIterExecutionStatus,
    AutoIterApprovalMethod,
    PostgresConfig,
} from './types'

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
            connectionTimeoutMillis: 5000
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
                seq INTEGER DEFAULT 0,
                advisor_task_id TEXT,
                creator_chat_id TEXT,
                advisor_mode BOOLEAN DEFAULT FALSE,
                advisor_prompt_injected BOOLEAN DEFAULT FALSE,
                role_prompt_sent BOOLEAN DEFAULT FALSE
            );
            -- Add created_by column if not exists (migration)
            ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_by TEXT;
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);
            -- OpenCode session 查询优化索引
            CREATE INDEX IF NOT EXISTS idx_sessions_flavor ON sessions((metadata->>'flavor'));
            CREATE INDEX IF NOT EXISTS idx_sessions_flavor_namespace ON sessions((metadata->>'flavor'), namespace);
            CREATE INDEX IF NOT EXISTS idx_sessions_flavor_active ON sessions((metadata->>'flavor'), active) WHERE (metadata->>'flavor') = 'opencode';
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
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

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
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                UNIQUE(path, machine_id)
            );
            CREATE INDEX IF NOT EXISTS idx_projects_machine_id ON projects(machine_id);
            -- Migration: Add machine_id column if not exists (for existing databases)
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS machine_id TEXT;
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

            -- Agent Groups 表
            CREATE TABLE IF NOT EXISTS agent_groups (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                type TEXT DEFAULT 'collaboration',
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL,
                status TEXT DEFAULT 'active'
            );
            CREATE INDEX IF NOT EXISTS idx_agent_groups_namespace ON agent_groups(namespace);

            -- Agent Group Members 表
            CREATE TABLE IF NOT EXISTS agent_group_members (
                group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role TEXT DEFAULT 'member',
                agent_type TEXT,
                joined_at BIGINT NOT NULL,
                PRIMARY KEY (group_id, session_id)
            );

            -- Agent Group Messages 表
            CREATE TABLE IF NOT EXISTS agent_group_messages (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
                source_session_id TEXT,
                sender_type TEXT DEFAULT 'agent',
                content TEXT NOT NULL,
                message_type TEXT DEFAULT 'chat',
                created_at BIGINT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_group_messages_group ON agent_group_messages(group_id);

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
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_namespace ON ai_profiles(namespace);
            CREATE INDEX IF NOT EXISTS idx_ai_profiles_role ON ai_profiles(role);

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
        `)
    }

    // ========== Session 操作 ==========

    async getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Promise<StoredSession> {
        const existing = await this.pool.query(
            'SELECT * FROM sessions WHERE tag = $1 AND namespace = $2 ORDER BY created_at DESC LIMIT 1',
            [tag, namespace]
        )

        if (existing.rows.length > 0) {
            return this.toStoredSession(existing.rows[0])
        }

        const now = Date.now()
        const id = randomUUID()

        await this.pool.query(`
            INSERT INTO sessions (
                id, tag, namespace, machine_id, created_at, updated_at,
                metadata, metadata_version,
                agent_state, agent_state_version,
                todos, todos_updated_at,
                active, active_at, seq
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
            id, tag, namespace, null, now, now,
            metadata ? JSON.stringify(metadata) : null, 1,
            agentState ? JSON.stringify(agentState) : null, 1,
            null, null,
            true, now, 0  // 新 session 默认 active=true，这样心跳不会被归档检查阻止
        ])

        const result = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id])
        return this.toStoredSession(result.rows[0])
    }

    async updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const result = await client.query(`
                UPDATE sessions
                SET metadata = $1,
                    metadata_version = metadata_version + 1,
                    updated_at = $2,
                    seq = seq + 1
                WHERE id = $3 AND namespace = $4 AND metadata_version = $5
                RETURNING metadata_version
            `, [JSON.stringify(metadata), Date.now(), id, namespace, expectedVersion])

            if (result.rowCount === 1) {
                await client.query('COMMIT')
                return { result: 'success', version: expectedVersion + 1, value: metadata }
            }

            const current = await client.query(
                'SELECT metadata, metadata_version FROM sessions WHERE id = $1 AND namespace = $2',
                [id, namespace]
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
            await client.query('ROLLBACK')
            return { result: 'error' }
        } finally {
            client.release()
        }
    }

    async updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>> {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')

            const result = await client.query(`
                UPDATE sessions
                SET agent_state = $1,
                    agent_state_version = agent_state_version + 1,
                    updated_at = $2,
                    seq = seq + 1
                WHERE id = $3 AND namespace = $4 AND agent_state_version = $5
                RETURNING agent_state_version
            `, [JSON.stringify(agentState), Date.now(), id, namespace, expectedVersion])

            if (result.rowCount === 1) {
                await client.query('COMMIT')
                return { result: 'success', version: expectedVersion + 1, value: agentState }
            }

            const current = await client.query(
                'SELECT agent_state, agent_state_version FROM sessions WHERE id = $1 AND namespace = $2',
                [id, namespace]
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
            await client.query('ROLLBACK')
            return { result: 'error' }
        } finally {
            client.release()
        }
    }

    async setSessionTodos(id: string, todos: unknown, todosUpdatedAt: number, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions
            SET todos = $1, todos_updated_at = $2, updated_at = $3, seq = seq + 1
            WHERE id = $4 AND namespace = $5
        `, [JSON.stringify(todos), todosUpdatedAt, Date.now(), id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionAdvisorTaskId(id: string, advisorTaskId: string, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET advisor_task_id = $1, updated_at = $2 WHERE id = $3 AND namespace = $4
        `, [advisorTaskId, Date.now(), id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionAdvisorMode(id: string, advisorMode: boolean, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET advisor_mode = $1, updated_at = $2 WHERE id = $3 AND namespace = $4
        `, [advisorMode, Date.now(), id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionAdvisorPromptInjected(id: string, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET advisor_prompt_injected = TRUE, updated_at = $1 WHERE id = $2 AND namespace = $3
        `, [Date.now(), id, namespace])
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

    async setSessionRolePromptSent(id: string, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET role_prompt_sent = TRUE, updated_at = $1 WHERE id = $2 AND namespace = $3
        `, [Date.now(), id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionCreatedBy(id: string, email: string, namespace: string): Promise<boolean> {
        // 只在 created_by 为空时设置，避免覆盖已有的创建者信息
        const result = await this.pool.query(`
            UPDATE sessions SET created_by = $1, updated_at = $2
            WHERE id = $3 AND namespace = $4 AND created_by IS NULL
        `, [email, Date.now(), id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    async setSessionActive(id: string, active: boolean, activeAt: number, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions SET active = $1, active_at = $2
            WHERE id = $3 AND namespace = $4
        `, [active, activeAt, id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    async getSession(id: string): Promise<StoredSession | null> {
        const result = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredSession(result.rows[0]) : null
    }

    async getSessionByNamespace(id: string, namespace: string): Promise<StoredSession | null> {
        const result = await this.pool.query('SELECT * FROM sessions WHERE id = $1 AND namespace = $2', [id, namespace])
        return result.rows.length > 0 ? this.toStoredSession(result.rows[0]) : null
    }

    async getSessions(): Promise<StoredSession[]> {
        const result = await this.pool.query('SELECT * FROM sessions ORDER BY updated_at DESC')
        return result.rows.map(row => this.toStoredSession(row))
    }

    async getSessionsByNamespace(namespace: string): Promise<StoredSession[]> {
        const result = await this.pool.query('SELECT * FROM sessions WHERE namespace = $1 ORDER BY updated_at DESC', [namespace])
        return result.rows.map(row => this.toStoredSession(row))
    }

    async deleteSession(id: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM sessions WHERE id = $1', [id])
        return (result.rowCount ?? 0) > 0
    }

    async patchSessionMetadata(id: string, patch: Record<string, unknown>, namespace: string): Promise<boolean> {
        const result = await this.pool.query(`
            UPDATE sessions
            SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                metadata_version = metadata_version + 1,
                updated_at = $2,
                seq = seq + 1
            WHERE id = $3 AND namespace = $4
        `, [JSON.stringify(patch), Date.now(), id, namespace])
        return (result.rowCount ?? 0) > 0
    }

    // ========== Machine 操作 ==========

    async getOrCreateMachine(id: string, metadata: unknown, daemonState: unknown, namespace: string): Promise<StoredMachine> {
        const existing = await this.pool.query('SELECT * FROM machines WHERE id = $1 AND namespace = $2', [id, namespace])

        if (existing.rows.length > 0) {
            return this.toStoredMachine(existing.rows[0])
        }

        const now = Date.now()
        await this.pool.query(`
            INSERT INTO machines (id, namespace, created_at, updated_at, metadata, metadata_version, daemon_state, daemon_state_version, active, active_at, seq)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [id, namespace, now, now, metadata ? JSON.stringify(metadata) : null, 1, daemonState ? JSON.stringify(daemonState) : null, 1, false, null, 0])

        const result = await this.pool.query('SELECT * FROM machines WHERE id = $1', [id])
        return this.toStoredMachine(result.rows[0])
    }

    async updateMachineMetadata(id: string, metadata: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>> {
        // Preserve displayName from existing metadata if not provided in new metadata
        const currentMetadata = await this.pool.query('SELECT metadata FROM machines WHERE id = $1 AND namespace = $2', [id, namespace])
        let finalMetadata = metadata

        if (currentMetadata.rows.length > 0 && metadata && typeof metadata === 'object') {
            const existing = currentMetadata.rows[0].metadata
            if (existing && typeof existing === 'object' && 'displayName' in existing && !('displayName' in metadata)) {
                // Preserve displayName from existing metadata
                finalMetadata = { ...metadata as Record<string, unknown>, displayName: existing.displayName }
            }
        }

        const result = await this.pool.query(`
            UPDATE machines SET metadata = $1, metadata_version = metadata_version + 1, updated_at = $2, seq = seq + 1
            WHERE id = $3 AND namespace = $4 AND metadata_version = $5
            RETURNING metadata_version
        `, [JSON.stringify(finalMetadata), Date.now(), id, namespace, expectedVersion])

        if ((result.rowCount ?? 0) === 1) {
            return { result: 'success', version: expectedVersion + 1, value: finalMetadata }
        }

        const current = await this.pool.query('SELECT metadata, metadata_version FROM machines WHERE id = $1 AND namespace = $2', [id, namespace])
        if (current.rows.length === 0) return { result: 'error' }
        return { result: 'version-mismatch', version: current.rows[0].metadata_version, value: current.rows[0].metadata }
    }

    async updateMachineDaemonState(id: string, daemonState: unknown, expectedVersion: number, namespace: string): Promise<VersionedUpdateResult<unknown | null>> {
        const result = await this.pool.query(`
            UPDATE machines SET daemon_state = $1, daemon_state_version = daemon_state_version + 1, updated_at = $2, seq = seq + 1
            WHERE id = $3 AND namespace = $4 AND daemon_state_version = $5
            RETURNING daemon_state_version
        `, [JSON.stringify(daemonState), Date.now(), id, namespace, expectedVersion])

        if ((result.rowCount ?? 0) === 1) {
            return { result: 'success', version: expectedVersion + 1, value: daemonState }
        }

        const current = await this.pool.query('SELECT daemon_state, daemon_state_version FROM machines WHERE id = $1 AND namespace = $2', [id, namespace])
        if (current.rows.length === 0) return { result: 'error' }
        return { result: 'version-mismatch', version: current.rows[0].daemon_state_version, value: current.rows[0].daemon_state }
    }

    async getMachine(id: string): Promise<StoredMachine | null> {
        const result = await this.pool.query('SELECT * FROM machines WHERE id = $1', [id])
        return result.rows.length > 0 ? this.toStoredMachine(result.rows[0]) : null
    }

    async getMachineByNamespace(id: string, namespace: string): Promise<StoredMachine | null> {
        const result = await this.pool.query('SELECT * FROM machines WHERE id = $1 AND namespace = $2', [id, namespace])
        return result.rows.length > 0 ? this.toStoredMachine(result.rows[0]) : null
    }

    async getMachines(): Promise<StoredMachine[]> {
        const result = await this.pool.query('SELECT * FROM machines ORDER BY updated_at DESC')
        return result.rows.map(row => this.toStoredMachine(row))
    }

    async getMachinesByNamespace(namespace: string): Promise<StoredMachine[]> {
        const result = await this.pool.query('SELECT * FROM machines WHERE namespace = $1 ORDER BY updated_at DESC', [namespace])
        return result.rows.map(row => this.toStoredMachine(row))
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

            const now = Date.now()
            const id = randomUUID()

            await client.query(`
                INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [id, sessionId, JSON.stringify(content), now, nextSeq, localId || null])

            await client.query('UPDATE sessions SET seq = seq + 1, updated_at = $1 WHERE id = $2', [now, sessionId])

            await client.query('COMMIT')

            const result = await this.pool.query('SELECT * FROM messages WHERE id = $1', [id])
            return this.toStoredMessage(result.rows[0])
        } catch (err) {
            await client.query('ROLLBACK')
            throw err
        } finally {
            client.release()
        }
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
        const countResult = await this.pool.query('SELECT COUNT(*) FROM messages WHERE session_id = $1', [sessionId])
        const total = parseInt(countResult.rows[0].count, 10)

        if (total <= keepCount) {
            return { deleted: 0, remaining: total }
        }

        const deleteResult = await this.pool.query(`
            DELETE FROM messages WHERE session_id = $1 AND seq <= (
                SELECT seq FROM messages WHERE session_id = $1 ORDER BY seq DESC LIMIT 1 OFFSET $2
            )
        `, [sessionId, keepCount - 1])

        const deleted = deleteResult.rowCount ?? 0
        return { deleted, remaining: total - deleted }
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

    async getProjects(machineId?: string | null): Promise<StoredProject[]> {
        // 获取指定机器的项目 + 通用项目（machine_id IS NULL）
        let query = 'SELECT * FROM projects'
        const params: (string | null)[] = []

        if (machineId !== undefined) {
            // machineId 传入时：返回该机器的项目 + 通用项目
            // machineId 传入 null：只返回通用项目
            // machineId 不传入：返回所有项目
            if (machineId === null) {
                query += ' WHERE machine_id IS NULL'
            } else {
                query += ' WHERE machine_id = $1 OR machine_id IS NULL ORDER BY machine_id NULLS LAST, name'
                params.push(machineId)
            }
        } else {
            query += ' ORDER BY name'
        }

        const result = await this.pool.query(query, params)
        return result.rows.map(row => ({
            id: row.id,
            name: row.name,
            path: row.path,
            description: row.description,
            machineId: row.machine_id as string | null,
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
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    async addProject(name: string, path: string, description?: string, machineId?: string | null): Promise<StoredProject | null> {
        const id = randomUUID()
        const now = Date.now()
        try {
            await this.pool.query(
                'INSERT INTO projects (id, name, path, description, machine_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [id, name, path, description || null, machineId || null, now, now]
            )
            return { id, name, path, description: description || null, machineId: machineId || null, createdAt: now, updatedAt: now }
        } catch {
            return null
        }
    }

    async updateProject(id: string, name: string, path: string, description?: string, machineId?: string | null): Promise<StoredProject | null> {
        const now = Date.now()
        const result = await this.pool.query(
            'UPDATE projects SET name = $1, path = $2, description = $3, machine_id = $4, updated_at = $5 WHERE id = $6 RETURNING *',
            [name, path, description || null, machineId || null, now, id]
        )
        if (result.rows.length === 0) return null
        const row = result.rows[0]
        return {
            id: row.id,
            name: row.name,
            path: row.path,
            description: row.description,
            machineId: row.machine_id as string | null,
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

    async getAllInputPresets(): Promise<StoredInputPreset[]> {
        const result = await this.pool.query('SELECT * FROM input_presets ORDER BY trigger')
        return result.rows.map(row => ({
            id: row.id,
            trigger: row.trigger,
            title: row.title,
            prompt: row.prompt,
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
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at)
        }
    }

    async addInputPreset(trigger: string, title: string, prompt: string): Promise<StoredInputPreset | null> {
        const id = randomUUID()
        const now = Date.now()
        try {
            await this.pool.query(
                'INSERT INTO input_presets (id, trigger, title, prompt, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
                [id, trigger, title, prompt, now, now]
            )
            return { id, trigger, title, prompt, createdAt: now, updatedAt: now }
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

    // ========== Agent Group 操作 ==========

    async createAgentGroup(data: {
        namespace: string
        name: string
        description?: string | null
        type?: AgentGroupType
    }): Promise<StoredAgentGroup> {
        const id = randomUUID()
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO agent_groups (id, namespace, name, description, type, created_at, updated_at, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [id, data.namespace, data.name, data.description ?? null, data.type ?? 'collaboration', now, now, 'active'])

        const result = await this.getAgentGroup(id)
        if (!result) throw new Error('Failed to create agent group')
        return result
    }

    async getAgentGroup(id: string): Promise<StoredAgentGroup | null> {
        const result = await this.pool.query('SELECT * FROM agent_groups WHERE id = $1', [id])
        if (result.rows.length === 0) return null
        return this.toStoredAgentGroup(result.rows[0])
    }

    async getAgentGroups(namespace: string): Promise<StoredAgentGroup[]> {
        const result = await this.pool.query('SELECT * FROM agent_groups WHERE namespace = $1 ORDER BY updated_at DESC', [namespace])
        return result.rows.map(row => this.toStoredAgentGroup(row))
    }

    async getAgentGroupsWithLastMessage(namespace: string): Promise<StoredAgentGroupWithLastMessage[]> {
        const result = await this.pool.query(`
            SELECT g.*,
                   (SELECT COUNT(*) FROM agent_group_members WHERE group_id = g.id) as member_count,
                   m.content as last_message_content,
                   m.sender_type as last_message_sender_type,
                   m.created_at as last_message_created_at
            FROM agent_groups g
            LEFT JOIN LATERAL (
                SELECT content, sender_type, created_at FROM agent_group_messages
                WHERE group_id = g.id ORDER BY created_at DESC LIMIT 1
            ) m ON true
            WHERE g.namespace = $1
            ORDER BY g.updated_at DESC
        `, [namespace])

        return result.rows.map(row => ({
            ...this.toStoredAgentGroup(row),
            memberCount: Number(row.member_count),
            lastMessage: row.last_message_content ? {
                content: row.last_message_content,
                senderType: row.last_message_sender_type as GroupSenderType,
                createdAt: Number(row.last_message_created_at)
            } : null
        }))
    }

    async updateAgentGroupStatus(id: string, status: AgentGroupStatus): Promise<void> {
        await this.pool.query('UPDATE agent_groups SET status = $1, updated_at = $2 WHERE id = $3', [status, Date.now(), id])
    }

    async deleteAgentGroup(id: string): Promise<void> {
        await this.pool.query('DELETE FROM agent_groups WHERE id = $1', [id])
    }

    async addGroupMember(data: {
        groupId: string
        sessionId: string
        role?: GroupMemberRole
        agentType?: string | null
    }): Promise<StoredAgentGroupMember> {
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO agent_group_members (group_id, session_id, role, agent_type, joined_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (group_id, session_id) DO UPDATE SET role = EXCLUDED.role, agent_type = EXCLUDED.agent_type
        `, [data.groupId, data.sessionId, data.role ?? 'member', data.agentType ?? null, now])

        return {
            groupId: data.groupId,
            sessionId: data.sessionId,
            role: (data.role ?? 'member') as GroupMemberRole,
            agentType: data.agentType ?? null,
            joinedAt: now
        }
    }

    async removeGroupMember(groupId: string, sessionId: string): Promise<void> {
        await this.pool.query('DELETE FROM agent_group_members WHERE group_id = $1 AND session_id = $2', [groupId, sessionId])
    }

    async getGroupMembers(groupId: string): Promise<StoredAgentGroupMember[]> {
        const result = await this.pool.query('SELECT * FROM agent_group_members WHERE group_id = $1', [groupId])
        return result.rows.map(row => ({
            groupId: row.group_id,
            sessionId: row.session_id,
            role: row.role as GroupMemberRole,
            agentType: row.agent_type,
            joinedAt: Number(row.joined_at)
        }))
    }

    async getSessionGroups(sessionId: string): Promise<StoredAgentGroup[]> {
        const result = await this.pool.query(`
            SELECT g.* FROM agent_groups g
            JOIN agent_group_members m ON g.id = m.group_id
            WHERE m.session_id = $1
            ORDER BY g.updated_at DESC
        `, [sessionId])
        return result.rows.map(row => this.toStoredAgentGroup(row))
    }

    async getGroupsForSession(sessionId: string): Promise<StoredAgentGroup[]> {
        return this.getSessionGroups(sessionId)
    }

    async addGroupMessage(data: {
        groupId: string
        sourceSessionId?: string | null
        senderType?: GroupSenderType
        content: string
        messageType?: GroupMessageType
    }): Promise<StoredAgentGroupMessage> {
        const id = randomUUID()
        const now = Date.now()
        await this.pool.query(`
            INSERT INTO agent_group_messages (id, group_id, source_session_id, sender_type, content, message_type, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [id, data.groupId, data.sourceSessionId ?? null, data.senderType ?? 'agent', data.content, data.messageType ?? 'chat', now])

        await this.pool.query('UPDATE agent_groups SET updated_at = $1 WHERE id = $2', [now, data.groupId])

        return {
            id,
            groupId: data.groupId,
            sourceSessionId: data.sourceSessionId ?? null,
            senderType: (data.senderType ?? 'agent') as GroupSenderType,
            content: data.content,
            messageType: (data.messageType ?? 'chat') as GroupMessageType,
            createdAt: now
        }
    }

    async getGroupMessages(groupId: string, limit: number = 100, beforeId?: string): Promise<StoredAgentGroupMessage[]> {
        let query = 'SELECT * FROM agent_group_messages WHERE group_id = $1'
        const params: unknown[] = [groupId]

        if (beforeId) {
            query += ' AND created_at < (SELECT created_at FROM agent_group_messages WHERE id = $2)'
            params.push(beforeId)
        }

        query += ' ORDER BY created_at ASC, id ASC LIMIT $' + (params.length + 1)
        params.push(limit)

        const result = await this.pool.query(query, params)
        console.log(`[DEBUG] getGroupMessages(${groupId.slice(0,8)}...): query=${query}, beforeId=${beforeId}`)
        console.log(`[DEBUG] GROUP DB returned ${result.rows.length} messages, first 3 rows:`)
        result.rows.slice(0, 3).forEach((row, i) => {
            console.log(`[DEBUG]   Row${i}: id=${row.id}, created_at=${row.created_at}`)
        })
        const mapped = result.rows.map(row => ({
            id: row.id,
            groupId: row.group_id,
            sourceSessionId: row.source_session_id,
            senderType: row.sender_type as GroupSenderType,
            content: row.content,
            messageType: row.message_type as GroupMessageType,
            createdAt: Number(row.created_at)
        }))
        console.log(`[DEBUG] GROUP mapped, first 3 messages:`)
        mapped.slice(0, 3).forEach((msg, i) => {
            console.log(`[DEBUG]   Msg${i}: id=${msg.id}, createdAt=${msg.createdAt}`)
        })
        return mapped
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

    async createAIProfile(data: {
        namespace: string
        name: string
        role: AIProfileRole
        specialties?: string[]
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
                id, namespace, name, role, specialties, personality, greeting_template,
                preferred_projects, work_style, avatar_emoji, status, stats_json, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
            id,
            data.namespace,
            data.name,
            data.role,
            JSON.stringify(data.specialties ?? []),
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
            metadata: row.metadata,
            metadataVersion: row.metadata_version,
            agentState: row.agent_state,
            agentStateVersion: row.agent_state_version,
            todos: row.todos,
            todosUpdatedAt: row.todos_updated_at ? Number(row.todos_updated_at) : null,
            active: row.active === true,
            activeAt: row.active_at ? Number(row.active_at) : null,
            seq: row.seq,
            advisorTaskId: row.advisor_task_id,
            creatorChatId: row.creator_chat_id,
            advisorMode: row.advisor_mode === true,
            advisorPromptInjected: row.advisor_prompt_injected === true,
            rolePromptSent: row.role_prompt_sent === true
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
            seq: row.seq
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

    private toStoredAgentGroup(row: any): StoredAgentGroup {
        return {
            id: row.id,
            namespace: row.namespace,
            name: row.name,
            description: row.description,
            type: row.type as AgentGroupType,
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            status: row.status as AgentGroupStatus
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
            name: row.name,
            role: row.role as AIProfileRole,
            specialties: Array.isArray(row.specialties) ? row.specialties : [],
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
}
