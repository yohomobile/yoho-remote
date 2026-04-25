import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import {
    createSummarizeTurnQueuePublisher,
    SUMMARIZE_TURN_JOB_VERSION,
} from '../sync/summarizeTurnQueue'
import {
    HELP_TEXT,
    loadFakeDeepseekSmokeConfig,
    type SmokeConfig,
} from './fakeDeepseekSmokeConfig'

type SmokeVerification = {
    run: {
        status: string
        error: string | null
        tokensIn: number | null
        tokensOut: number | null
        metadata: Record<string, unknown> | null
    }
    summary: {
        summary: string
        seqStart: number
        seqEnd: number
        metadata: Record<string, unknown> | null
    }
}

function createAssistantText(mode: 'fake' | 'real'): string {
    return [
        `这是一条用于 ${mode === 'real' ? '真实' : 'fake'} DeepSeek smoke 的 assistant 输出。`,
        '它刻意包含足够多的正文，让 summarize-turn 不会落入 trivial turn 分支。',
        '目标是验证 publisher 发送、pg-boss 入队、worker 消费、DeepSeek 返回、以及 session_summaries / summarization_runs 持久化这条成功路径。',
        '如果这条记录最终能写入 level=1 摘要，就说明当前联调最小闭环仍然可用，DeepSeek、publisher、worker、session_summaries、summarization_runs 都应在摘要中体现。'
    ].join('')
}

async function seedSmokeTurn(
    pool: Pool,
    config: SmokeConfig
): Promise<{ userSeq: number; assistantSeq: number }> {
    const now = Date.now()
    const userSeq = 1
    const assistantSeq = 2

    await pool.query('DELETE FROM session_summaries WHERE session_id = $1', [config.sessionId])
    await pool.query('DELETE FROM summarization_runs WHERE session_id = $1', [config.sessionId])
    await pool.query('DELETE FROM messages WHERE session_id = $1', [config.sessionId])
    await pool.query('DELETE FROM sessions WHERE id = $1', [config.sessionId])

    await pool.query(
        `INSERT INTO sessions (
            id, namespace, created_at, updated_at, active, active_at,
            thinking, thinking_at, seq, metadata, metadata_version, agent_state_version
        )
        VALUES ($1, $2, $3, $4, FALSE, $5, FALSE, $6, $7, $8, 1, 1)`,
        [
            config.sessionId,
            config.namespace,
            now,
            now,
            now,
            now,
            assistantSeq,
            {
                path: `/tmp/${config.deepseekMode}-deepseek-smoke`,
                summary: {
                    text: `${config.deepseekMode === 'real' ? 'Real' : 'Fake'} DeepSeek Smoke`,
                    updatedAt: now,
                },
            },
        ]
    )

    await pool.query(
        `INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
         VALUES ($1, $2, $3, $4, $5, NULL), ($6, $2, $7, $8, $9, NULL)`,
        [
            randomUUID(),
            config.sessionId,
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `请验证 ${config.deepseekMode === 'real' ? '真实' : 'fake'} DeepSeek / worker / publisher 联调闭环是否正常，并确认 level=1 摘要保留 DeepSeek、publisher、worker、session_summaries、summarization_runs 这些关键信息。`,
                },
            },
            now + 1,
            userSeq,
            randomUUID(),
            {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: createAssistantText(config.deepseekMode),
                    },
                ],
            },
            now + 2,
            assistantSeq,
        ]
    )

    return { userSeq, assistantSeq }
}

async function waitForVerification(
    pool: Pool,
    sessionId: string,
    userSeq: number,
    timeoutMs: number = 20_000
): Promise<SmokeVerification> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
        const runResult = await pool.query(
            `SELECT status, error, tokens_in, tokens_out, metadata
             FROM summarization_runs
             WHERE session_id = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [sessionId]
        )
        const summaryResult = await pool.query(
            `SELECT summary, seq_start, seq_end, metadata
             FROM session_summaries
             WHERE session_id = $1 AND level = 1
             ORDER BY created_at DESC
             LIMIT 1`,
            [sessionId]
        )

        const runRow = runResult.rows[0] as Record<string, unknown> | undefined
        const summaryRow = summaryResult.rows[0] as Record<string, unknown> | undefined

        if (runRow?.status === 'success' && summaryRow && Number(summaryRow.seq_start) === userSeq) {
            return {
                run: {
                    status: String(runRow.status),
                    error: typeof runRow.error === 'string' ? runRow.error : null,
                    tokensIn: typeof runRow.tokens_in === 'number' ? runRow.tokens_in : null,
                    tokensOut: typeof runRow.tokens_out === 'number' ? runRow.tokens_out : null,
                    metadata: (runRow.metadata as Record<string, unknown> | null) ?? null,
                },
                summary: {
                    summary: String(summaryRow.summary),
                    seqStart: Number(summaryRow.seq_start),
                    seqEnd: Number(summaryRow.seq_end),
                    metadata: (summaryRow.metadata as Record<string, unknown> | null) ?? null,
                },
            }
        }

        if (runRow && typeof runRow.status === 'string' && runRow.status !== 'success') {
            throw new Error(
                `Smoke failed before success: status=${runRow.status} error=${String(runRow.error ?? '')}`
            )
        }

        await Bun.sleep(250)
    }

    throw new Error(`Timed out waiting for summarize-turn success for session ${sessionId}`)
}

async function pumpLines(
    stream: ReadableStream<Uint8Array> | null,
    prefix: string,
    onLine?: (line: string) => void
): Promise<void> {
    if (!stream) {
        return
    }

    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
        const { value, done } = await reader.read()
        if (done) {
            break
        }

        buffer += decoder.decode(value, { stream: true })
        let newlineIndex = buffer.indexOf('\n')
        while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
            buffer = buffer.slice(newlineIndex + 1)
            if (line.length > 0) {
                console.log(`${prefix}${line}`)
                onLine?.(line)
            }
            newlineIndex = buffer.indexOf('\n')
        }
    }

    const tail = `${buffer}${decoder.decode()}`.trim()
    if (tail.length > 0) {
        console.log(`${prefix}${tail}`)
        onLine?.(tail)
    }
}

async function startWorker(
    config: SmokeConfig,
    deepseekBaseUrl: string
): Promise<ReturnType<typeof Bun.spawn>> {
    const workerDir = resolve(import.meta.dir, '../../../worker')
    const child = Bun.spawn(['bun', 'run', 'src/index.ts'], {
        cwd: workerDir,
        env: {
            ...process.env,
            PG_HOST: config.pg.host,
            PG_PORT: String(config.pg.port),
            PG_USER: config.pg.user,
            PG_PASSWORD: config.pg.password,
            PG_DATABASE: config.pg.database,
            PG_SSL: config.pg.ssl ? 'true' : 'false',
            PG_BOSS_SCHEMA: config.pg.bossSchema,
            DEEPSEEK_API_KEY: config.deepseekApiKey,
            DEEPSEEK_BASE_URL: deepseekBaseUrl,
            DEEPSEEK_MODEL: 'deepseek-v4-flash',
            DEEPSEEK_TIMEOUT_MS: String(config.deepseekTimeoutMs),
            WORKER_CONCURRENCY: String(config.workerConcurrency),
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })

    let ready = false
    let readyResolve: (() => void) | null = null
    let readyReject: ((error: Error) => void) | null = null
    const readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
    })

    void pumpLines(child.stdout, '[smoke:worker:out] ', (line) => {
        if (!ready && line.includes('[Worker] Started.')) {
            ready = true
            readyResolve?.()
        }
    })
    void pumpLines(child.stderr, '[smoke:worker:err] ', (line) => {
        if (!ready && line.includes('Fatal startup error')) {
            readyReject?.(new Error(line))
        }
    })
    void child.exited.then((code) => {
        if (!ready && code !== 0) {
            readyReject?.(new Error(`Worker exited before ready (code=${code})`))
        }
    })

    await Promise.race([
        readyPromise,
        Bun.sleep(15_000).then(() => {
            throw new Error('Timed out waiting for worker readiness')
        }),
    ])

    return child
}

async function main(): Promise<void> {
    if (process.argv.includes('--help')) {
        console.log(HELP_TEXT)
        return
    }

    const config = loadFakeDeepseekSmokeConfig()
    const fakeRequests: unknown[] = []
    const pool = new Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
        ssl: config.pg.ssl === false ? false : config.pg.ssl,
        max: 4,
        idleTimeoutMillis: 5_000,
        connectionTimeoutMillis: 5_000,
    })

    const fakeServer = config.deepseekMode === 'fake'
        ? Bun.serve({
            hostname: '127.0.0.1',
            port: config.fakePort,
            async fetch(request) {
                const url = new URL(request.url)
                if (url.pathname !== '/chat/completions') {
                    return new Response('Not Found', { status: 404 })
                }

                const body = await request.json().catch(() => null)
                fakeRequests.push(body)

                return Response.json({
                    id: 'fake-chatcmpl-1',
                    choices: [{
                        finish_reason: 'stop',
                        message: {
                            content: JSON.stringify({
                                summary: 'Fake DeepSeek smoke summary: summarize-turn publisher and worker path succeeded.',
                                topic: 'Smoke summarize-turn',
                                tools: ['pg-boss', 'worker'],
                                entities: ['summarize-turn', 'fake-deepseek', 'session_summaries'],
                            }),
                        },
                    }],
                    usage: {
                        prompt_tokens: 321,
                        completion_tokens: 45,
                    },
                })
            },
        })
        : null

    const deepseekBaseUrl = fakeServer
        ? `http://127.0.0.1:${fakeServer.port}`
        : config.deepseekBaseUrl

    if (fakeServer) {
        console.log(`[smoke] fake DeepSeek listening on ${deepseekBaseUrl}`)
    } else {
        console.log(`[smoke] real DeepSeek mode baseUrl=${deepseekBaseUrl}`)
    }

    let worker: ReturnType<typeof Bun.spawn> | null = null
    let publisher: Awaited<ReturnType<typeof createSummarizeTurnQueuePublisher>> = null

    try {
        await pool.query('SELECT 1')
        worker = await startWorker(config, deepseekBaseUrl)
        const { userSeq } = await seedSmokeTurn(pool, config)

        publisher = await createSummarizeTurnQueuePublisher(config.pg)
        if (!publisher) {
            throw new Error('Failed to create summarize-turn publisher')
        }

        const scheduledAtMs = Date.now()
        const idempotencyKey = `turn:${config.namespace}:${config.sessionId}:${userSeq}`
        await publisher.send('summarize-turn', {
            version: SUMMARIZE_TURN_JOB_VERSION,
            idempotencyKey,
            payload: {
                sessionId: config.sessionId,
                orgId: config.namespace,
                namespace: config.namespace,
                userSeq,
                scheduledAtMs,
            },
        }, {
            singletonKey: idempotencyKey
        })

        const verification = await waitForVerification(pool, config.sessionId, userSeq)
        if (config.deepseekMode === 'fake' && fakeRequests.length === 0) {
            throw new Error('Fake DeepSeek received no requests')
        }

        const summaryMetadata = verification.summary.metadata ?? {}
        const topic = typeof summaryMetadata.topic === 'string' ? summaryMetadata.topic : null
        const tools = Array.isArray(summaryMetadata.tools) ? summaryMetadata.tools : []
        const entities = Array.isArray(summaryMetadata.entities) ? summaryMetadata.entities : []

        console.log('[smoke] success')
        console.log(`[smoke] mode=${config.deepseekMode} model=deepseek-v4-flash`)
        console.log(`[smoke] sessionId=${config.sessionId} namespace=${config.namespace} schema=${config.pg.bossSchema}`)
        console.log(`[smoke] run.status=${verification.run.status}`)
        console.log(`[smoke] run.tokens=${verification.run.tokensIn ?? 'null'}/${verification.run.tokensOut ?? 'null'}`)
        console.log(`[smoke] summary.seq=${verification.summary.seqStart}-${verification.summary.seqEnd}`)
        console.log(`[smoke] summary.text=${verification.summary.summary}`)
        console.log(`[smoke] summary.topic=${topic ?? 'null'}`)
        console.log(`[smoke] summary.tools=${JSON.stringify(tools)}`)
        console.log(`[smoke] summary.entities=${JSON.stringify(entities)}`)
        if (config.deepseekMode === 'fake') {
            console.log(`[smoke] fakeRequests=${fakeRequests.length}`)
        }
        console.log('[smoke] verification points:')
        console.log('  - summarization_runs latest row is success')
        console.log('  - session_summaries latest L1 row exists for the user seq')
        if (config.deepseekMode === 'fake') {
            console.log('  - fake DeepSeek handled at least one completion request')
        } else {
            console.log('  - worker completed a fresh real DeepSeek request (no cache retained for this session)')
        }
    } finally {
        await publisher?.stop().catch((error: unknown) => {
            console.error('[smoke] failed to stop publisher:', error)
        })
        if (worker) {
            worker.kill()
            await worker.exited.catch(() => {})
        }
        fakeServer?.stop(true)
        await pool.end().catch((error: unknown) => {
            console.error('[smoke] failed to close postgres pool:', error)
        })
    }
}

main().catch((error: unknown) => {
    console.error('[smoke] failed:', error)
    process.exit(1)
})
