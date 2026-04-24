/**
 * Download Files Routes
 *
 * CLI: POST /cli/files - upload a file (CLI token auth)
 * API: GET /api/sessions/:sessionId/downloads - list download files for a session
 * API: DELETE /api/sessions/:sessionId/downloads - clear download files for a session
 * API: GET /api/downloads/:id - download file content
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

type CliEnv = { Variables: { orgId: string } }

async function requireDownloadSessionAccess(
    c: { get: (key: string) => unknown; json: (data: unknown, status?: number) => Response },
    store: IStore,
    sessionId: string,
): Promise<Response | null> {
    const session = await store.getSession(sessionId)
    if (!session) {
        return c.json({ error: 'Session not found' }, 404)
    }

    const sessionOrgId = typeof session.orgId === 'string' && session.orgId.trim()
        ? session.orgId.trim()
        : null
    if (!sessionOrgId) {
        return c.json({ error: 'Session access denied' }, 403)
    }

    const requestedOrgId = c.get('orgId') as string | undefined
    if (requestedOrgId) {
        if (requestedOrgId !== sessionOrgId) {
            return c.json({ error: 'Session access denied' }, 403)
        }
    } else {
        const role = c.get('role') as string | undefined
        const orgs = (c.get('orgs') as Array<{ id: string }> | undefined) ?? []
        if (role !== 'operator' && !orgs.some((org) => org.id === sessionOrgId)) {
            return c.json({ error: 'Session access denied' }, 403)
        }
    }

    const email = c.get('email') as string | undefined
    if (!email) {
        return null
    }

    if (!session.createdBy || session.createdBy === email) {
        return null
    }

    const isShared = await store.isSessionSharedWith(sessionId, email)
    if (isShared) {
        return null
    }

    const ownerShareAll = await store.getShareAllSessions(session.createdBy)
    if (ownerShareAll) {
        return null
    }

    return c.json({ error: 'Session access denied' }, 403)
}

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
        const orgId = c.req.header('x-org-id')?.trim()
        if (!orgId) {
            return c.json({ error: 'Missing x-org-id header' }, 401)
        }
        c.set('orgId', orgId)
        return await next()
    })

    // POST /cli/files - CLI uploads a file
    app.post('/files', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = uploadSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid body' }, 400)

        const { sessionId, filename, content, mimeType } = parsed.data

        const access = await requireDownloadSessionAccess(c, store, sessionId)
        if (access) {
            return access
        }

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
            const orgId = c.get('orgId')
            sseManager.broadcast({
                type: 'file-ready',
                namespace: orgId,
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

    // GET /api/sessions/:sessionId/downloads - list download files for a session
    app.get('/sessions/:sessionId/downloads', async (c) => {
        const sessionId = c.req.param('sessionId')
        const access = await requireDownloadSessionAccess(c, store, sessionId)
        if (access) {
            return access
        }
        const files = await store.listDownloadFiles(sessionId)
        return c.json({ files })
    })

    // DELETE /api/sessions/:sessionId/downloads - clear download files for a session
    app.delete('/sessions/:sessionId/downloads', async (c) => {
        const sessionId = c.req.param('sessionId')
        const access = await requireDownloadSessionAccess(c, store, sessionId)
        if (access) {
            return access
        }
        const cleared = await store.clearDownloadFiles(sessionId)
        return c.json({ cleared })
    })

    // GET /api/downloads/:id - download file content
    app.get('/downloads/:id', async (c) => {
        const id = c.req.param('id')
        const result = await store.getDownloadFile(id)
        if (!result) return c.json({ error: 'File not found' }, 404)

        const access = await requireDownloadSessionAccess(c, store, result.meta.sessionId)
        if (access) {
            return access
        }

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
