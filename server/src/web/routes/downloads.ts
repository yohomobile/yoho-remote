/**
 * Download Files Routes
 *
 * CLI: POST /cli/files - upload a file (CLI token auth)
 * API: GET /api/sessions/:sessionId/files - list files for a session
 * API: GET /api/files/:id - download file content
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { configuration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { SSEManager } from '../../sse/sseManager'
import type { IStore } from '../../store/interface'
import type { WebAppEnv } from '../middleware/auth'

const uploadSchema = z.object({
    sessionId: z.string().min(1),
    filename: z.string().min(1),
    content: z.string().min(1),  // base64
    mimeType: z.string().optional(),
})

type CliEnv = { Variables: { namespace: string } }

export function createDownloadCliRoutes(
    getSseManager: () => SSEManager | null,
    store: IStore,
): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    // CLI token auth middleware
    app.use('*', async (c, next) => {
        const raw = c.req.header('authorization')
        if (!raw) return c.json({ error: 'Missing Authorization header' }, 401)
        const token = raw.replace(/^Bearer\s+/i, '')
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !safeCompareStrings(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }
        c.set('namespace', parsedToken.namespace)
        return await next()
    })

    // POST /cli/files - CLI uploads a file
    app.post('/files', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = uploadSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const { sessionId, filename, content, mimeType } = parsed.data

        let buf: Buffer
        try {
            buf = Buffer.from(content, 'base64')
        } catch {
            return c.json({ error: 'Invalid base64 content' }, 400)
        }

        const resolvedMimeType = mimeType || guessMimeType(filename)

        // Resolve orgId from session
        const session = await store.getSession(sessionId)
        const orgId = session?.orgId ?? null

        const meta = await store.addDownloadFile({
            sessionId,
            orgId,
            filename,
            mimeType: resolvedMimeType,
            content: buf,
        })

        // Broadcast SSE event so frontend knows there's a new file
        const sseManager = getSseManager()
        if (sseManager) {
            const namespace = c.get('namespace')
            sseManager.broadcast({
                type: 'file-ready',
                namespace,
                sessionId,
                fileInfo: { id: meta.id, filename: meta.filename, size: meta.size, mimeType: meta.mimeType },
            })
        }

        return c.json({ id: meta.id, filename: meta.filename, size: meta.size })
    })

    return app
}

export function createDownloadApiRoutes(
    store: IStore,
): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // GET /api/sessions/:sessionId/files - list files
    app.get('/sessions/:sessionId/files', async (c) => {
        const sessionId = c.req.param('sessionId')
        const files = await store.listDownloadFiles(sessionId)
        return c.json({ files })
    })

    // GET /api/files/:id - download file
    app.get('/files/:id', async (c) => {
        const id = c.req.param('id')
        const result = await store.getDownloadFile(id)
        if (!result) return c.json({ error: 'File not found' }, 404)

        const { meta, content } = result
        return new Response(content, {
            headers: {
                'Content-Type': meta.mimeType,
                'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.filename)}"`,
                'Content-Length': String(meta.size),
            },
        })
    })

    return app
}

function guessMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = {
        'txt': 'text/plain',
        'md': 'text/markdown',
        'json': 'application/json',
        'csv': 'text/csv',
        'html': 'text/html',
        'xml': 'application/xml',
        'pdf': 'application/pdf',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'zip': 'application/zip',
        'gz': 'application/gzip',
        'js': 'text/javascript',
        'ts': 'text/typescript',
        'py': 'text/x-python',
        'sh': 'text/x-sh',
        'yaml': 'text/yaml',
        'yml': 'text/yaml',
        'toml': 'text/toml',
        'sql': 'text/x-sql',
        'log': 'text/plain',
    }
    return map[ext ?? ''] ?? 'application/octet-stream'
}
