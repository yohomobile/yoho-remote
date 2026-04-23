import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type WorkerHealthConfig = {
    host: string
    port: number
}

export type WorkerHealthSnapshot = {
    status: 'starting' | 'ready' | 'shutting_down'
    startedAtMs: number
    uptimeMs: number
    schema: string
    host: string
    version: string
    concurrency: number
    queues: string[]
    lastCatchupAtMs: number | null
    db: {
        ok: boolean
        latencyMs: number | null
        error?: string
    }
    stats?: {
        summarizationRuns: Record<string, number>
        aiTaskRuns: Record<string, number>
    }
}

export type WorkerHealthServer = {
    close(): Promise<void>
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
}

function notFound(res: ServerResponse): void {
    sendJson(res, 404, { error: 'not_found' })
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) {
                reject(error)
                return
            }
            resolve()
        })
    })
}

export async function startWorkerHealthServer(
    config: WorkerHealthConfig,
    getSnapshot: () => Promise<WorkerHealthSnapshot>,
): Promise<WorkerHealthServer | null> {
    if (config.port <= 0) {
        return null
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            const path = req.url?.split('?')[0] ?? '/'
            if (path !== '/healthz' && path !== '/readyz' && path !== '/stats') {
                notFound(res)
                return
            }

            const snapshot = await getSnapshot()
            if (path === '/healthz') {
                sendJson(res, snapshot.status === 'shutting_down' ? 503 : 200, {
                    status: snapshot.status,
                    uptimeMs: snapshot.uptimeMs,
                })
                return
            }

            if (path === '/readyz') {
                const ready = snapshot.status === 'ready' && snapshot.db.ok
                sendJson(res, ready ? 200 : 503, snapshot)
                return
            }

            sendJson(res, snapshot.db.ok ? 200 : 503, snapshot)
        })().catch(error => {
            sendJson(res, 500, {
                error: error instanceof Error ? error.message : String(error),
            })
        })
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.host, () => {
            server.off('error', reject)
            resolve()
        })
    })

    return {
        close: () => closeServer(server),
    }
}
