# Session Orchestration 代码片段快速查找

## 1. Spawn Session - 关键代码片段

### machines.ts: POST /machines/:id/spawn (L124-262)

```typescript
app.post('/machines/:id/spawn', async (c) => {
    const result = await engine.spawnSession(
        machineId,
        parsed.data.directory,
        requestedAgent,
        parsed.data.yolo,
        {
            sessionType: spawnTarget.sessionType,
            worktreeName: spawnTarget.worktreeName,
            tokenSourceId: resolvedTokenSource?.tokenSource.id,
            // ... 完整选项见 SESSION_ORCHESTRATION_GUIDE.md
        }
    )

    // 异步后处理（不阻塞响应）
    if (result.type === 'success') {
        void (async () => {
            const isOnline = await waitForSessionOnline(engine, result.sessionId, 60_000)
            if (!isOnline) return
            
            const hasSocket = await engine.waitForSocketInRoom(result.sessionId, 5000)
            
            if (email) {
                await store.setSessionCreatedBy(result.sessionId, email, namespace)
            }
            if (orgId) {
                await store.setSessionOrgId(result.sessionId, orgId, namespace)
            }
            await sendInitPrompt(engine, result.sessionId, role, userName, machineId)
        })().catch(err => {
            console.error(`[machines/spawn] Post-spawn setup failed for session ${result.sessionId}:`, err)
        })
    }

    return c.json(result)
})
```

### SyncEngine.spawnSession (L3862-3976)

```typescript
async spawnSession(
    machineId: string,
    directory: string,
    agent: string = 'claude',
    yolo?: boolean,
    options?: { /* ... */ }
): Promise<{ type: 'success'; sessionId: string; logs?: unknown[] } | { type: 'error'; message: string; logs?: unknown[] }> {
    // 1. Validate supported agents
    const machine = this.machines.get(machineId)
    if (machine?.supportedAgents && machine.supportedAgents.length > 0) {
        const requestedAgent = (agent || 'claude') as SpawnAgentType
        if (!machine.supportedAgents.includes(requestedAgent)) {
            return {
                type: 'error',
                message: `Machine "${displayName}" does not support agent "${requestedAgent}"`
            }
        }
    }

    // 2. Call machine RPC
    const result = await this.machineRpc(
        machineId,
        'spawn-yoho-remote-session',
        {
            type: 'spawn-in-directory',
            directory,
            agent,
            yolo,
            sessionType: options?.sessionType,
            // ... 完整 payload 见文件
        }
    )

    // 3. Handle response
    if (result?.type === 'success' && typeof obj.sessionId === 'string') {
        return { type: 'success', sessionId: obj.sessionId, logs }
    }
    
    // 4. Error handling
    return { type: 'error', message: obj.errorMessage || 'Unexpected spawn result' }
}
```

---

## 2. Send Message - 关键代码片段

### SyncEngine.sendMessage (L3489-3570)

```typescript
async sendMessage(
    sessionId: string,
    payload: {
        text: string
        localId?: string | null
        sentFrom?: string
        meta?: Record<string, unknown>
    }
): Promise<SendMessageOutcome> {
    const session = this.sessions.get(sessionId)
    const localId = typeof payload.localId === 'string' && payload.localId.length > 0
        ? payload.localId
        : null

    // 1. Deduplication check
    if (localId) {
        const cachedDuplicate = this.getCachedMessageByLocalId(sessionId, localId)
        if (cachedDuplicate) {
            return this.getDuplicateSendOutcome(session, cachedDuplicate)
        }
    }

    // 2. Brain-child init buffering
    if ((payload.sentFrom as string) === 'brain') {
        const isBrainChild = getSessionSourceFromMetadata(session?.metadata) === 'brain-child'
        if (isBrainChild && !this.brainChildInitCompleted.has(sessionId)) {
            // Buffer message until init completes
            const pending = this.brainChildPendingMessages.get(sessionId) ?? []
            pending.push({ text: payload.text, localId })
            this.brainChildPendingMessages.set(sessionId, pending)
            return {
                status: 'queued',
                queue: 'brain-child-init',
                queueDepth: pending.length,
            }
        }
    }

    // 3. Clear abort/thinking state
    if (session?.abortedAt) {
        session.abortedAt = undefined
    }

    // 4. Build message content
    const sentFrom = payload.sentFrom ?? 'webapp'
    const content = {
        role: 'user',
        content: {
            type: 'text',
            text: payload.text
        },
        meta: {
            // ...
        }
    }

    // 5. Enqueue or send
    // ... 继续处理逻辑
}
```

---

## 3. Brain Session Spawn - 关键代码片段

### sessions.ts: POST /brain/sessions (L1011-1216)

```typescript
app.post('/brain/sessions', async (c) => {
    // 1. Parse & validate request
    const parsed = createBrainSessionSchema.safeParse(body)
    if (!parsed.success) {
        return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
    }

    const namespace = c.get('namespace')
    const email = c.get('email')

    // 2. Get Brain config
    const brainConfig = await store.getBrainConfig(namespace || 'default')
    const childModelDefaults = extractBrainChildModelDefaults(brainConfig?.extra)
    const requestedAgent = parsed.data.agent ?? brainConfig?.agent ?? 'claude'

    // 3. Get compatible machines
    const candidateMachines = engine.getOnlineMachinesByNamespace(namespace, orgId ?? undefined)
    const compatibleMachines = candidateMachines.filter(
        (machine) => !machine.supportedAgents || machine.supportedAgents.includes(requestedAgent)
    )

    // 4. Iterate & spawn on first successful machine
    let result: Awaited<ReturnType<typeof engine.spawnSession>> | null = null
    for (const machine of compatibleMachines) {
        const homeDir = machine.metadata?.homeDir || '/tmp'
        const brainDirectory = `${homeDir}/.yoho-remote/brain-workspace`

        // Build Brain preferences
        const brainPreferences = buildBrainSessionPreferences({
            machineSelectionMode: requestedMachineId ? 'manual' : 'auto',
            machineId: machine.id,
            childClaudeModels: effectiveChildModels.childClaudeModels,
            childCodexModels: effectiveChildModels.childCodexModels,
        })

        // Spawn with Brain-specific options
        const candidate = await engine.spawnSession(
            machine.id,
            brainDirectory,
            requestedAgent,
            true,  // yolo=true for Brain
            {
                source: 'brain',
                permissionMode: resolveBrainSpawnPermissionMode(requestedAgent),
                tokenSourceId: resolvedTokenSource?.tokenSource.id,
                // ...
                brainPreferences,
            }
        )

        if (candidate.type === 'success') {
            result = candidate
            break
        }
    }

    // 5. Store token source IDs in metadata
    if (brainTokenSourceIds.claude || brainTokenSourceIds.codex) {
        await engine.patchSessionMetadata(result.sessionId, { brainTokenSourceIds })
    }

    return c.json(result)
})
```

---

## 4. Projects 查询 - 关键代码片段

### postgres.ts: Projects CRUD (L1926-2054)

```typescript
// List projects
async listProjects(filters?: {
    name?: string
    machineId?: string
    orgId?: string
}): Promise<StoredProject[]> {
    let query = 'SELECT * FROM projects'
    const conditions = []
    const params = []

    if (filters?.name) {
        conditions.push(`name ILIKE $${params.length + 1}`)
        params.push(`%${filters.name}%`)
    }
    if (filters?.machineId) {
        conditions.push(`machine_id = $${params.length + 1}`)
        params.push(filters.machineId)
    }
    if (filters?.orgId) {
        conditions.push(`org_id = $${params.length + 1}`)
        params.push(filters.orgId)
    }

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

// Get single project
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

// Add project (with uniqueness check)
async addProject(
    name: string,
    path: string,
    description?: string,
    machineId?: string | null,
    orgId?: string | null
): Promise<StoredProject | null> {
    const id = randomUUID()
    const now = Date.now()
    const normalizedMachineId = machineId?.trim() || null

    // Check uniqueness: (path, machine_id, org_id) must be unique
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
        return null  // Conflict
    }

    await this.pool.query(
        'INSERT INTO projects (id, name, path, description, machine_id, org_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, name, path, description || null, normalizedMachineId, orgId || null, now, now]
    )

    return { id, name, path, description: description || null, machineId: normalizedMachineId, orgId: orgId || null, createdAt: now, updatedAt: now }
}

// Update project
async updateProject(
    id: string,
    fields: {
        name?: string
        path?: string
        description?: string | null
        machineId?: string | null
        orgId?: string | null
    }
): Promise<StoredProject | null> {
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

    // Check uniqueness after update
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
        return null  // Conflict
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
```

---

## 5. AI Task Schedules DDL - 完整定义

### ai-tasks-ddl.ts

```typescript
export const AI_TASK_SCHEDULES_DDL = `
    CREATE TABLE IF NOT EXISTS ai_task_schedules (
        id                    TEXT PRIMARY KEY,
        namespace             TEXT NOT NULL,
        machine_id            TEXT NOT NULL,
        label                 TEXT,
        cron_expr             TEXT NOT NULL,
        payload_prompt        TEXT NOT NULL,
        directory             TEXT NOT NULL,
        agent                 TEXT NOT NULL DEFAULT 'claude',
        mode                  TEXT,
        model                 TEXT,
        recurring             BOOLEAN NOT NULL DEFAULT TRUE,
        enabled               BOOLEAN NOT NULL DEFAULT TRUE,
        created_at            BIGINT NOT NULL,
        created_by_session_id TEXT,
        last_fire_at          BIGINT,
        next_fire_at          BIGINT,
        last_run_status       TEXT,
        consecutive_failures  INT NOT NULL DEFAULT 0
    );
`

export const AI_TASK_RUNS_DDL = `
    CREATE TABLE IF NOT EXISTS ai_task_runs (
        id            TEXT PRIMARY KEY,
        schedule_id   TEXT REFERENCES ai_task_schedules(id) ON DELETE SET NULL,
        session_id    TEXT,
        subsession_id TEXT,
        machine_id    TEXT NOT NULL,
        namespace     TEXT NOT NULL,
        status        TEXT NOT NULL,
        started_at    BIGINT NOT NULL,
        finished_at   BIGINT,
        error         TEXT,
        metadata      JSONB
    );
`

export const AI_TASK_INDEXES_DDL = `
    CREATE INDEX IF NOT EXISTS idx_ats_machine_enabled ON ai_task_schedules(machine_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_ats_namespace_enabled ON ai_task_schedules(namespace, enabled);
    CREATE INDEX IF NOT EXISTS idx_atr_schedule ON ai_task_runs(schedule_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_atr_namespace ON ai_task_runs(namespace, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_atr_status ON ai_task_runs(status)
        WHERE status NOT IN ('succeeded', 'failed', 'timeout');
`
```

---

## 6. 初始化 Prompt 发送

### machines.ts: sendInitPrompt (L41-64)

```typescript
async function sendInitPrompt(
    engine: SyncEngine,
    sessionId: string,
    role: UserRole,
    userName?: string | null,
    machineId?: string
): Promise<void> {
    try {
        const session = engine.getSession(sessionId)
        const worktree = session?.metadata?.worktree
        const projectRoot = session?.metadata?.path?.trim()
            || worktree?.basePath?.trim()
            || null

        console.log(`[machines/sendInitPrompt] sessionId=${sessionId}, role=${role}, projectRoot=${projectRoot}`)
        
        // Build context-specific prompt
        const prompt = await buildInitPrompt(role, { projectRoot, userName, worktree })
        if (!prompt.trim()) {
            console.warn(`[machines/sendInitPrompt] Empty prompt for session ${sessionId}, skipping`)
            return
        }

        // Send via SyncEngine
        console.log(`[machines/sendInitPrompt] Sending prompt to session ${sessionId}, length=${prompt.length}`)
        await engine.sendMessage(sessionId, {
            text: prompt,
            sentFrom: 'webapp'
        })
        console.log(`[machines/sendInitPrompt] Successfully sent init prompt to session ${sessionId}`)
    } catch (err) {
        console.error(`[machines/sendInitPrompt] Failed for session ${sessionId}:`, err)
    }
}
```

---

## 7. Session Online 等待

### machines.ts: waitForSessionOnline (L66-104)

```typescript
async function waitForSessionOnline(
    engine: SyncEngine,
    sessionId: string,
    timeoutMs: number
): Promise<boolean> {
    const existing = engine.getSession(sessionId)
    if (existing?.active) {
        return true  // Already online
    }

    return await new Promise((resolve) => {
        let resolved = false
        let unsubscribe = () => {}

        const finalize = (result: boolean) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            unsubscribe()
            resolve(result)
        }

        const timer = setTimeout(() => finalize(false), timeoutMs)

        // Subscribe to session updates
        unsubscribe = engine.subscribe((event) => {
            if (event.sessionId !== sessionId) {
                return
            }
            if (event.type !== 'session-added' && event.type !== 'session-updated') {
                return
            }
            const session = engine.getSession(sessionId)
            if (session?.active) {
                finalize(true)
            }
        })

        // Double-check (race condition guard)
        const current = engine.getSession(sessionId)
        if (current?.active) {
            finalize(true)
        }
    })
}
```

---

## 8. 完整调用示例

### 创建并初始化 Session 的完整流程

```typescript
// 1. POST request to /machines/:id/spawn
const spawnRequest = {
    directory: '/home/user/my-project',
    agent: 'claude',
    sessionType: 'worktree',
    worktreeName: 'feature-branch',
    claudeModel: 'opus-4-7',
    source: 'external-api'
}

// 2. Server-side handling
const result = await engine.spawnSession(
    machineId,
    spawnRequest.directory,
    spawnRequest.agent,
    false,
    {
        sessionType: spawnRequest.sessionType,
        worktreeName: spawnRequest.worktreeName,
        modelMode: spawnRequest.claudeModel,
        source: spawnRequest.source
    }
)

// 3. Async follow-up (fire-and-forget)
if (result.type === 'success') {
    void (async () => {
        // 3a. Wait for session to be online
        const isOnline = await waitForSessionOnline(engine, result.sessionId, 60_000)
        if (!isOnline) {
            console.warn(`Session ${result.sessionId} did not come online`)
            return
        }

        // 3b. Wait for Socket.IO connection
        const hasSocket = await engine.waitForSocketInRoom(result.sessionId, 5000)

        // 3c. Store metadata
        await store.setSessionCreatedBy(result.sessionId, userEmail, namespace)
        await store.setSessionOrgId(result.sessionId, orgId, namespace)

        // 3d. Send init prompt
        await sendInitPrompt(engine, result.sessionId, userRole, userName, machineId)
    })().catch(err => {
        console.error(`Post-spawn setup failed:`, err)
    })
}

// 4. Return to client immediately
return { type: 'success', sessionId: result.sessionId }
```

