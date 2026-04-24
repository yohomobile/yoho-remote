-- =============================================================
-- 2026-04-24 org_id backfill + schema finalization
-- =============================================================
--
-- 背景：dev-release 把 sessions / machines / ai_profiles / brain_config
-- 的多租户隔离从 `namespace` 迁到 `org_id`。新代码所有读路径都
-- `WHERE org_id = $1`，UNIQUE 索引也是 `(org_id, role) WHERE org_id IS NOT NULL`。
-- 老数据里 org_id 大量 NULL，需要在部署新代码前跑这份 migration。
--
-- 前置确认：
--   * Yoho org_id        = 2280991b-4c9c-44c8-ba1c-82b213551284
--   * DemoOrg org_id     = 098d0e96-3720-41a6-a8a0-91a44d18356d
--   * 本脚本对线上数据形态（2026-04-24 调研）编写；重跑前请再查分布。
--
-- 执行方式：
--   psql -h <host> -U guang -d yoho_remote -f scripts/migrations/2026-04-24-org-id-backfill.sql
--
-- 幂等性：DDL 全部 IF (NOT) EXISTS；数据清理里 sessions 用 WHERE org_id IS NULL
-- 再次执行不会误删已迁移好的行。ai_profiles 先做 window 选最新一条，不会
-- 对已经 `org_id IS NOT NULL` 的行再动。
--
-- =============================================================

BEGIN;

-- 0) 若线上尚未被 initSchema 自动加列，先把列加上（幂等）
ALTER TABLE ai_profiles  ADD COLUMN IF NOT EXISTS org_id TEXT;
ALTER TABLE brain_config ADD COLUMN IF NOT EXISTS org_id TEXT;

-- 1) 删除 114 行无主 sessions（created_by / machine_id / metadata email 全空）
--    这些是早期 smoke / openclaw / external-api / brain 遗留数据，
--    已确认无真实用户归属；关联 messages / summaries 由 FK CASCADE 删除。
DELETE FROM sessions
WHERE org_id IS NULL
  AND (created_by IS NULL OR created_by = '')
  AND (machine_id IS NULL OR machine_id = '')
  AND (metadata->>'createdByEmail') IS NULL
  AND (metadata->>'ownerEmail') IS NULL;

-- 2) ai_profiles: 每 role 保留最新一条迁到 Yoho，其余删除
--    (新 UNIQUE (org_id, role) WHERE org_id IS NOT NULL 要求一 org 一 role 一 profile)
WITH ranked AS (
    SELECT id,
           role,
           updated_at,
           ROW_NUMBER() OVER (PARTITION BY role ORDER BY updated_at DESC, created_at DESC, id) AS rn
    FROM ai_profiles
    WHERE org_id IS NULL
),
to_keep AS (
    SELECT id FROM ranked WHERE rn = 1
),
to_drop AS (
    SELECT id FROM ranked WHERE rn > 1
)
-- Delete losers first (ai_team_members FK has ON DELETE CASCADE)
DELETE FROM ai_profiles WHERE id IN (SELECT id FROM to_drop);

UPDATE ai_profiles
   SET org_id = '2280991b-4c9c-44c8-ba1c-82b213551284',
       updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
 WHERE org_id IS NULL;

-- 3) brain_config: 单行 namespace='default' 迁到 Yoho
UPDATE brain_config
   SET org_id = '2280991b-4c9c-44c8-ba1c-82b213551284',
       updated_at = FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000)
 WHERE org_id IS NULL
   AND namespace = 'default';

-- 4) 若还有其它 namespace 的 brain_config 残留（当前没有，但兜底报错以防）
DO $$
DECLARE
    leftover INT;
BEGIN
    SELECT COUNT(*) INTO leftover FROM brain_config WHERE org_id IS NULL;
    IF leftover > 0 THEN
        RAISE NOTICE 'brain_config still has % rows with NULL org_id — please handle manually before enabling UNIQUE index.', leftover;
    END IF;
END
$$;

-- 5) 建 UNIQUE 索引（仅对 org_id IS NOT NULL 行生效；先清完数据再建才不会冲突）
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_profiles_org_role_unique
    ON ai_profiles(org_id, role) WHERE org_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_config_org_id_unique
    ON brain_config(org_id) WHERE org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_profiles_org_id
    ON ai_profiles(org_id);

-- 6) 新建 user_self_system_settings 表（新代码依赖）
CREATE TABLE IF NOT EXISTS user_self_system_settings (
    org_id             TEXT NOT NULL,
    user_email         TEXT NOT NULL,
    enabled            BOOLEAN NOT NULL DEFAULT false,
    default_profile_id TEXT,
    memory_provider    TEXT NOT NULL DEFAULT 'yoho-memory',
    updated_at         BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM NOW()) * 1000),
    updated_by         TEXT,
    PRIMARY KEY (org_id, user_email)
);
CREATE INDEX IF NOT EXISTS idx_user_self_system_profile_id
    ON user_self_system_settings(default_profile_id);

-- 7) 健康检查（失败不回滚、仅打印 NOTICE）
DO $$
DECLARE
    null_sessions INT;
    null_profiles INT;
    null_brain INT;
BEGIN
    SELECT COUNT(*) INTO null_sessions FROM sessions WHERE org_id IS NULL;
    SELECT COUNT(*) INTO null_profiles FROM ai_profiles WHERE org_id IS NULL;
    SELECT COUNT(*) INTO null_brain    FROM brain_config WHERE org_id IS NULL;
    RAISE NOTICE '  Remaining NULL org_id — sessions: %, ai_profiles: %, brain_config: %',
        null_sessions, null_profiles, null_brain;
END
$$;

COMMIT;

-- 8) 回滚指引（非自动执行）：
-- 本迁移是破坏性清理，回滚需要事先在 DB 中快照对应表。
-- 建议先：
--   CREATE TABLE sessions_backup_20260424   AS TABLE sessions;
--   CREATE TABLE ai_profiles_backup_20260424 AS TABLE ai_profiles;
--   CREATE TABLE brain_config_backup_20260424 AS TABLE brain_config;
-- 再跑本脚本；若需要回滚：
--   TRUNCATE ai_profiles; INSERT INTO ai_profiles SELECT * FROM ai_profiles_backup_20260424;
--   ...（同理其他表）
