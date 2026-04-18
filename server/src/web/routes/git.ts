import { Hono } from 'hono'
import { z } from 'zod'
import { basename, join, resolve, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import type { SyncEngine } from '../../sync/syncEngine'
import type { IStore } from '../../store'
import type { WebAppEnv } from '../middleware/auth'
import { requireSession, requireSessionFromParam, requireSessionFromParamWithShareCheck, requireSyncEngine } from './guards'
import { getConfiguration } from '../../configuration'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

const imageUploadSchema = z.object({
    filename: z.string().min(1),
    content: z.string().min(1), // Base64 encoded image content
    mimeType: z.string().min(1)
})

const fileUploadSchema = z.object({
    filename: z.string().min(1),
    content: z.string().min(1), // Base64 encoded file content
    mimeType: z.string().min(1)
})

const MAX_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024

function logUploadInfo(kind: 'image' | 'file', phase: string, data: Record<string, unknown>): void {
    console.log(`[upload-${kind}] ${phase}`, data)
}

function logUploadWarn(kind: 'image' | 'file', phase: string, data: Record<string, unknown>): void {
    console.warn(`[upload-${kind}] ${phase}`, data)
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
}

function estimateBase64Size(content: string): number {
    if (!content) return 0
    let padding = 0
    if (content.endsWith('==')) {
        padding = 2
    } else if (content.endsWith('=')) {
        padding = 1
    }
    return Math.floor((content.length * 3) / 4) - padding
}

async function runRpc<T>(fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
    try {
        return await fn()
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

export function createGitRoutes(getSyncEngine: () => SyncEngine | null, store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/git-status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const result = await runRpc(() => engine.getGitStatus(sessionResult.sessionId, sessionPath))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-numstat', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffNumstat(sessionResult.sessionId, { cwd: sessionPath, staged }))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffFile(sessionResult.sessionId, {
            cwd: sessionPath,
            filePath: parsed.data.path,
            staged
        }))
        return c.json(result)
    })

    app.get('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = await requireSessionFromParamWithShareCheck(c, engine, store)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const raw = parseBooleanParam(c.req.query('raw'))
        const download = parseBooleanParam(c.req.query('download'))

        const result = await runRpc(() => engine.readSessionFile(sessionResult.sessionId, parsed.data.path))

        // If raw mode is requested and we have content, return the raw binary data
        if (raw && result.success && result.content) {
            const buffer = Buffer.from(result.content, 'base64')

            // Determine content type from file extension
            const ext = parsed.data.path.split('.').pop()?.toLowerCase() ?? ''
            const imageMimeTypes: Record<string, string> = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml',
                'bmp': 'image/bmp',
                'ico': 'image/x-icon',
                'heic': 'image/heic',
                'heif': 'image/heif'
            }
            const fileMimeTypes: Record<string, string> = {
                'pdf': 'application/pdf',
                'txt': 'text/plain',
                'md': 'text/markdown',
                'json': 'application/json',
                'csv': 'text/csv',
                'zip': 'application/zip',
                'gz': 'application/gzip',
                'tar': 'application/x-tar'
            }
            const contentType = imageMimeTypes[ext] ?? fileMimeTypes[ext] ?? 'application/octet-stream'
            const isImage = Boolean(imageMimeTypes[ext])
            const fileName = basename(parsed.data.path) || 'download'
            const safeFileName = fileName.replace(/"/g, '')

            const headers: Record<string, string> = {
                'Content-Type': contentType,
                'Content-Length': buffer.length.toString(),
                'Cache-Control': 'public, max-age=31536000, immutable'
            }

            if (download || !isImage) {
                headers['Content-Disposition'] = `attachment; filename="${safeFileName}"`
            }

            return new Response(buffer, {
                status: 200,
                headers
            })
        }

        return c.json(result)
    })

    app.get('/sessions/:id/files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = fileSearchSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const query = parsed.data.query?.trim() ?? ''
        const limit = parsed.data.limit ?? 200
        const args = ['--files']

        // Determine search path based on query
        // - If query starts with '/', treat as absolute path
        // - If query starts with '../', resolve relative to sessionPath
        // - Otherwise, search in sessionPath
        let searchPath = sessionPath
        let searchQuery = query

        if (query.startsWith('/')) {
            // Absolute path: extract directory and remaining query
            // e.g., "/opt/mattermost" -> searchPath="/opt/mattermost", searchQuery=""
            // e.g., "/opt/matter" -> searchPath="/opt", searchQuery="matter"
            const parts = query.split('/')
            // Find the longest existing directory prefix
            let pathParts: string[] = []
            let queryPart = ''
            for (let i = 1; i < parts.length; i++) {
                const testPath = '/' + parts.slice(1, i + 1).join('/')
                try {
                    const stat = await import('node:fs').then(fs => fs.promises.stat(testPath))
                    if (stat.isDirectory()) {
                        pathParts = parts.slice(1, i + 1)
                    } else {
                        // It's a file, use parent as searchPath
                        pathParts = parts.slice(1, i)
                        queryPart = parts.slice(i).join('/')
                        break
                    }
                } catch {
                    // Path doesn't exist, use what we have
                    queryPart = parts.slice(i).join('/')
                    break
                }
            }
            searchPath = pathParts.length > 0 ? '/' + pathParts.join('/') : '/'
            searchQuery = queryPart
        } else if (query.startsWith('../') || query.startsWith('..')) {
            // Relative path: resolve relative to sessionPath
            // e.g., "../other-project" -> resolve(sessionPath, "../other-project")
            const resolved = resolve(sessionPath, query)
            // Find the longest existing directory prefix
            let testPath = resolved
            let queryPart = ''
            while (testPath !== '/') {
                try {
                    const stat = await import('node:fs').then(fs => fs.promises.stat(testPath))
                    if (stat.isDirectory()) {
                        searchPath = testPath
                        break
                    } else {
                        // It's a file
                        searchPath = dirname(testPath)
                        queryPart = basename(testPath)
                        break
                    }
                } catch {
                    queryPart = queryPart ? basename(testPath) + '/' + queryPart : basename(testPath)
                    testPath = dirname(testPath)
                }
            }
            if (testPath === '/') {
                searchPath = '/'
            }
            searchQuery = queryPart
        }

        const result = await runRpc(() => engine.runRipgrep(sessionResult.sessionId, args, searchPath))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const searchQueryLower = searchQuery.toLowerCase()

        // Determine if we're searching outside the session directory
        const isExternalPath = query.startsWith('/') || query.startsWith('../') || query.startsWith('..')

        // Calculate path prefix for external paths
        // For absolute paths: use the searchPath directly
        // For relative paths (../): calculate relative path from sessionPath
        let pathPrefix = ''
        if (isExternalPath) {
            if (query.startsWith('/')) {
                pathPrefix = searchPath
            } else {
                // For ../ paths, we want to show relative path from sessionPath
                // e.g., if sessionPath=/home/guang/hapi and searchPath=/home/guang/happy
                // then prefix should be "../happy"
                const sessionParts = sessionPath.split('/').filter(Boolean)
                const searchParts = searchPath.split('/').filter(Boolean)

                // Find common prefix length
                let commonLen = 0
                for (let i = 0; i < Math.min(sessionParts.length, searchParts.length); i++) {
                    if (sessionParts[i] === searchParts[i]) {
                        commonLen++
                    } else {
                        break
                    }
                }

                // Build relative path
                const upCount = sessionParts.length - commonLen
                const downParts = searchParts.slice(commonLen)
                pathPrefix = '../'.repeat(upCount) + downParts.join('/')
            }
        }

        const filePaths = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => !searchQuery || line.toLowerCase().includes(searchQueryLower))

        // Extract unique directories from file paths
        const dirSet = new Set<string>()
        for (const fp of filePaths) {
            const parts = fp.split('/')
            // Add all parent directories
            for (let i = 1; i < parts.length; i++) {
                dirSet.add(parts.slice(0, i).join('/'))
            }
        }

        // Helper to build full path with prefix
        const buildFullPath = (relativePath: string): string => {
            if (!pathPrefix) return relativePath
            if (pathPrefix.endsWith('/')) return pathPrefix + relativePath
            return pathPrefix + '/' + relativePath
        }

        // Filter directories by query if provided
        const matchingDirs = Array.from(dirSet)
            .filter((dir) => !searchQuery || dir.toLowerCase().includes(searchQueryLower))
            .map((relativePath) => {
                const fullPath = buildFullPath(relativePath)
                const parts = fullPath.split('/')
                const fileName = parts[parts.length - 1] || fullPath
                const filePath = parts.slice(0, -1).join('/')
                return {
                    fileName,
                    filePath,
                    fullPath,
                    fileType: 'folder' as const
                }
            })

        // Map files
        const matchingFiles = filePaths.slice(0, limit).map((relativePath) => {
            const fullPath = buildFullPath(relativePath)
            const parts = fullPath.split('/')
            const fileName = parts[parts.length - 1] || fullPath
            const filePath = parts.slice(0, -1).join('/')
            return {
                fileName,
                filePath,
                fullPath,
                fileType: 'file' as const
            }
        })

        // Combine: folders first, then files, limited to total limit
        const combined = [...matchingDirs, ...matchingFiles].slice(0, limit)

        return c.json({ success: true, files: combined })
    })

    // Upload image endpoint
    app.post('/sessions/:id/upload-image', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionId = sessionResult.sessionId
        const namespace = c.get('namespace')
        const clientId = c.get('clientId')
        const userId = c.get('userId')
        const contentLength = c.req.header('content-length')

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            logUploadWarn('image', 'invalid-json', { sessionId, namespace, clientId, userId, contentLength })
            return c.json({ success: false, error: 'Invalid JSON body' }, 400)
        }

        const parsed = imageUploadSchema.safeParse(body)
        if (!parsed.success) {
            logUploadWarn('image', 'invalid-body', {
                sessionId,
                namespace,
                clientId,
                userId,
                error: parsed.error.message
            })
            return c.json({ success: false, error: 'Invalid request: ' + parsed.error.message }, 400)
        }

        const { filename, content, mimeType } = parsed.data
        const sizeBytes = estimateBase64Size(content)
        logUploadInfo('image', 'request', {
            sessionId,
            namespace,
            clientId,
            userId,
            filename: basename(filename),
            mimeType,
            sizeBytes,
            contentLength
        })
        if (sizeBytes > MAX_IMAGE_BYTES) {
            logUploadWarn('image', 'too-large', {
                sessionId,
                filename: basename(filename),
                sizeBytes,
                maxBytes: MAX_IMAGE_BYTES
            })
            return c.json({ success: false, error: 'Image too large (max 100MB)' }, 413)
        }

        // 存储到服务器端（不走 RPC）
        try {
            const config = getConfiguration()
            const uploadsDir = join(config.dataDir, 'uploads', sessionId)

            // 确保目录存在
            if (!existsSync(uploadsDir)) {
                mkdirSync(uploadsDir, { recursive: true })
            }

            // 生成唯一文件名
            const ext = filename.split('.').pop() || 'jpg'
            const uniqueFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
            const filePath = join(uploadsDir, uniqueFilename)

            // 解码并保存文件
            const buffer = Buffer.from(content, 'base64')
            writeFileSync(filePath, buffer)

            // 返回服务器端存储路径
            const serverPath = `server-uploads/${sessionId}/${uniqueFilename}`
            logUploadInfo('image', 'saved-to-server', { sessionId, path: serverPath, sizeBytes })

            return c.json({ success: true, path: serverPath })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            logUploadWarn('image', 'server-save-failed', { sessionId, error: errorMsg })
            return c.json({ success: false, error: errorMsg }, 500)
        }
    })

    // Upload file endpoint
    app.post('/sessions/:id/upload-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionId = sessionResult.sessionId
        const namespace = c.get('namespace')
        const clientId = c.get('clientId')
        const userId = c.get('userId')
        const contentLength = c.req.header('content-length')

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            logUploadWarn('file', 'invalid-json', { sessionId, namespace, clientId, userId, contentLength })
            return c.json({ success: false, error: 'Invalid JSON body' }, 400)
        }

        const parsed = fileUploadSchema.safeParse(body)
        if (!parsed.success) {
            logUploadWarn('file', 'invalid-body', {
                sessionId,
                namespace,
                clientId,
                userId,
                error: parsed.error.message
            })
            return c.json({ success: false, error: 'Invalid request: ' + parsed.error.message }, 400)
        }

        const { filename, content, mimeType } = parsed.data
        const sizeBytes = estimateBase64Size(content)
        logUploadInfo('file', 'request', {
            sessionId,
            namespace,
            clientId,
            userId,
            filename: basename(filename),
            mimeType,
            sizeBytes,
            contentLength
        })
        if (sizeBytes > MAX_FILE_BYTES) {
            logUploadWarn('file', 'too-large', {
                sessionId,
                filename: basename(filename),
                sizeBytes,
                maxBytes: MAX_FILE_BYTES
            })
            return c.json({ success: false, error: 'File too large (max 100MB)' }, 413)
        }

        const result = await runRpc(() => engine.uploadFile(
            sessionId,
            filename,
            content,
            mimeType
        ))
        const uploadResult = result as { success?: boolean; path?: string; error?: string }
        if (uploadResult && typeof uploadResult.success === 'boolean') {
            if (uploadResult.success) {
                logUploadInfo('file', 'saved', { sessionId, path: uploadResult.path, sizeBytes })
            } else {
                logUploadWarn('file', 'failed', { sessionId, error: uploadResult.error })
            }
        } else {
            logUploadWarn('file', 'unexpected-result', { sessionId })
        }
        return c.json(result)
    })

    // 复制绝对路径文件到服务器存储（通过 RPC 读取后存储到服务器）
    app.post('/sessions/:id/copy-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionId = sessionResult.sessionId

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json({ success: false, error: 'Invalid JSON body' }, 400)
        }

        const parsed = z.object({ path: z.string().min(1) }).safeParse(body)
        if (!parsed.success) {
            return c.json({ success: false, error: 'Invalid path' }, 400)
        }

        const absolutePath = parsed.data.path

        // 通过 RPC 读取文件内容（使用 readAbsoluteFile 支持任意绝对路径）
        const result = await runRpc(() => engine.readAbsoluteFile(sessionId, absolutePath))
        if (!result.success || !result.content) {
            return c.json({ success: false, error: result.error || 'Failed to read file' }, 404)
        }

        try {
            const config = getConfiguration()
            const uploadsDir = join(config.dataDir, 'downloads', sessionId)

            if (!existsSync(uploadsDir)) {
                mkdirSync(uploadsDir, { recursive: true })
            }

            // 生成唯一文件名，保留原始扩展名
            const originalFilename = basename(absolutePath)
            const ext = originalFilename.includes('.') ? originalFilename.split('.').pop() : ''
            const uniqueFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext ? '.' + ext : ''}`
            const filePath = join(uploadsDir, uniqueFilename)

            // 解码并保存文件
            const buffer = Buffer.from(result.content, 'base64')
            writeFileSync(filePath, buffer)

            // 返回下载路径
            const downloadPath = `server-downloads/${sessionId}/${uniqueFilename}`
            console.log('[copy-file] saved', { sessionId, originalPath: absolutePath, downloadPath, size: buffer.length })

            return c.json({
                success: true,
                path: downloadPath,
                filename: originalFilename,
                size: buffer.length
            })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error'
            console.error('[copy-file] save failed:', errorMsg)
            return c.json({ success: false, error: errorMsg }, 500)
        }
    })

    // 检查文件是否存在（支持相对路径）
    app.post('/sessions/:id/check-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const { sessionId, session } = sessionResult

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json({ exists: false, error: 'Invalid JSON body' }, 400)
        }

        const parsed = z.object({ path: z.string().min(1) }).safeParse(body)
        if (!parsed.success) {
            return c.json({ exists: false, error: 'Invalid path' }, 400)
        }

        const inputPath = parsed.data.path

        // 如果是相对路径，转换为绝对路径
        let absolutePath: string
        if (inputPath.startsWith('/')) {
            absolutePath = inputPath
        } else {
            const projectRoot = session.metadata?.path?.trim()
            if (!projectRoot) {
                return c.json({ exists: false, error: 'No project root' })
            }
            absolutePath = join(projectRoot, inputPath)
        }

        // 通过 RPC 检查文件是否存在（尝试读取）
        const result = await runRpc(() => engine.readAbsoluteFile(sessionId, absolutePath))

        // runRpc 失败时返回 { success: false, error: string }
        // 成功时返回 RpcReadFileResponse { success: boolean, content?: string, error?: string }
        const exists = 'content' in result && result.success && !!result.content

        return c.json({
            exists,
            absolutePath,
            error: !exists ? (result.error || 'File not found or session inactive') : undefined
        })
    })

    // 批量检查文件是否存在（支持相对路径）
    app.post('/sessions/:id/check-files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const { sessionId, session } = sessionResult

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json({}, 400)
        }

        const parsed = z.object({ paths: z.array(z.string().min(1)) }).safeParse(body)
        if (!parsed.success) {
            return c.json({}, 400)
        }

        const projectRoot = session.metadata?.path?.trim()
        const results: Record<string, { exists: boolean; absolutePath?: string }> = {}

        // 并行检查所有文件
        await Promise.all(parsed.data.paths.map(async (inputPath) => {
            let absolutePath: string
            if (inputPath.startsWith('/')) {
                absolutePath = inputPath
            } else {
                if (!projectRoot) {
                    results[inputPath] = { exists: false }
                    return
                }
                absolutePath = join(projectRoot, inputPath)
            }

            try {
                const result = await runRpc(() => engine.readAbsoluteFile(sessionId, absolutePath))
                const exists = 'content' in result && result.success && !!result.content
                results[inputPath] = { exists, absolutePath: exists ? absolutePath : undefined }
            } catch {
                results[inputPath] = { exists: false }
            }
        }))

        return c.json(results)
    })

    // 直接读取服务器端存储的下载文件
    app.get('/server-downloads/:sessionId/:filename', async (c) => {
        const sessionId = c.req.param('sessionId')
        const filename = c.req.param('filename')

        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const session = requireSession(c, engine, sessionId)
        if (session instanceof Response) {
            return session
        }

        try {
            const config = getConfiguration()
            const filePath = join(config.dataDir, 'downloads', sessionId, filename)

            if (!existsSync(filePath)) {
                return c.json({ error: 'File not found' }, 404)
            }

            const buffer = readFileSync(filePath)
            const ext = filename.split('.').pop()?.toLowerCase() ?? ''

            // 文本类型
            const textMimeTypes: Record<string, string> = {
                'ts': 'text/typescript',
                'tsx': 'text/typescript',
                'js': 'text/javascript',
                'jsx': 'text/javascript',
                'json': 'application/json',
                'md': 'text/markdown',
                'txt': 'text/plain',
                'css': 'text/css',
                'html': 'text/html',
                'xml': 'text/xml',
                'yaml': 'text/yaml',
                'yml': 'text/yaml',
                'sh': 'text/x-shellscript',
                'py': 'text/x-python',
                'rs': 'text/x-rust',
                'go': 'text/x-go',
            }
            const contentType = textMimeTypes[ext] ?? 'application/octet-stream'

            return new Response(buffer, {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length.toString(),
                    'Cache-Control': 'public, max-age=31536000, immutable'
                }
            })
        } catch (error) {
            console.error('[server-downloads] read error:', error)
            return c.json({ error: 'Failed to read file' }, 500)
        }
    })

    // 直接读取服务器端存储的上传文件（不走 RPC）
    app.get('/server-uploads/:sessionId/:filename', async (c) => {
        const sessionId = c.req.param('sessionId')
        const filename = c.req.param('filename')

        // Skip session validation for shared directories (e.g. feishu-images)
        if (!sessionId.startsWith('feishu-')) {
            const engine = requireSyncEngine(c, getSyncEngine)
            if (engine instanceof Response) {
                return engine
            }

            const session = requireSession(c, engine, sessionId)
            if (session instanceof Response) {
                return session
            }
        }

        try {
            const config = getConfiguration()
            const filePath = join(config.dataDir, 'uploads', sessionId, filename)

            if (!existsSync(filePath)) {
                return c.json({ error: 'File not found' }, 404)
            }

            const buffer = readFileSync(filePath)

            // 从文件名推断 MIME 类型
            const ext = filename.split('.').pop()?.toLowerCase() ?? ''
            const imageMimeTypes: Record<string, string> = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml',
                'bmp': 'image/bmp',
                'ico': 'image/x-icon',
                'heic': 'image/heic',
                'heif': 'image/heif'
            }
            const contentType = imageMimeTypes[ext] ?? 'application/octet-stream'

            return new Response(buffer, {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length.toString(),
                    'Cache-Control': 'public, max-age=31536000, immutable'
                }
            })
        } catch (error) {
            console.error('[server-uploads] read error:', error)
            return c.json({ error: 'Failed to read file' }, 500)
        }
    })

    return app
}
