import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { serveStatic } from 'hono/bun'
import { configuration } from '../configuration'
import type { SyncEngine } from '../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from './middleware/auth'
import { createKeycloakAuthRoutes } from './routes/keycloak-auth'
import { createEventsRoutes } from './routes/events'
import { createSessionsRoutes } from './routes/sessions'
import { createMessagesRoutes } from './routes/messages'
import { createPermissionsRoutes } from './routes/permissions'
import { createMachinesRoutes } from './routes/machines'
import { createGitRoutes } from './routes/git'
import { createCliRoutes } from './routes/cli'
import { createSpeechRoutes } from './routes/speech'
import { createOptimizeRoutes } from './routes/optimize'
import { createVersionRoutes } from './routes/version'
import { createSettingsRoutes } from './routes/settings'
import { createPushRoutes } from './routes/push'
import { createYohoCredentialsRoutes } from './routes/yoho-credentials'
import { createOrgsRoutes } from './routes/orgs'
import { createLicensesRoutes } from './routes/licenses'
import { createCodexOpenAIRoutes } from './routes/codex-openai'
import { createDownloadCliRoutes, createDownloadApiRoutes } from './routes/downloads'
import type { SSEManager } from '../sse/sseManager'
import type { Server as BunServer } from 'bun'
import type { Server as SocketEngine } from '@socket.io/bun-engine'
import type { WebSocketData } from '@socket.io/bun-engine'
import { loadEmbeddedAssetMap, type EmbeddedWebAsset } from './embeddedAssets'
import { isBunCompiled } from '../utils/bunCompiled'
import type { IStore } from '../store'

function findWebappDistDir(): { distDir: string; indexHtmlPath: string } {
    const candidates = [
        join(process.cwd(), '..', 'web', 'dist'),
        join(import.meta.dir, '..', '..', '..', 'web', 'dist'),
        join(process.cwd(), 'web', 'dist')
    ]

    for (const distDir of candidates) {
        const indexHtmlPath = join(distDir, 'index.html')
        if (existsSync(indexHtmlPath)) {
            return { distDir, indexHtmlPath }
        }
    }

    const distDir = candidates[0]
    return { distDir, indexHtmlPath: join(distDir, 'index.html') }
}

function serveEmbeddedAsset(asset: EmbeddedWebAsset, isHtml: boolean = false): Response {
    const headers: Record<string, string> = {
        'Content-Type': asset.mimeType
    }

    if (isHtml) {
        // HTML 文件不缓存，确保 iOS Safari PWA 能获取最新版本
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        headers['Pragma'] = 'no-cache'
        headers['Expires'] = '0'
    } else if (asset.mimeType === 'application/javascript' && asset.sourcePath.includes('sw.js')) {
        // Service Worker 文件也不应该被缓存
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    } else {
        // 静态资源（带 hash 的）可以长期缓存
        headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    }

    return new Response(Bun.file(asset.sourcePath), { headers })
}

function createWebApp(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    store: IStore
    embeddedAssetMap: Map<string, EmbeddedWebAsset> | null
}): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.use('*', logger())

    const corsOrigins = configuration.corsOrigins
    const corsOriginOption = corsOrigins.includes('*') ? '*' : corsOrigins
    const corsMiddleware = cors({
        origin: corsOriginOption,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type']
    })
    app.use('/api/*', corsMiddleware)
    app.use('/cli/*', corsMiddleware)
    app.use('/v1/*', corsMiddleware)

    app.route('/cli', createCliRoutes(options.getSyncEngine, options.getSseManager, options.store))
    app.route('/cli', createDownloadCliRoutes(options.getSseManager, options.store))

    // OpenAI Compatible API for Codex CLI (public, no auth required)
    app.route('/v1', createCodexOpenAIRoutes())

    // Keycloak SSO authentication routes (public)
    app.route('/api', createKeycloakAuthRoutes())
    app.route('/api', createVersionRoutes(options.embeddedAssetMap))  // Public, no auth required

    // Auth middleware - verifies Keycloak JWT tokens and loads org info
    app.use('/api/*', createAuthMiddleware(options.store))
    app.route('/api', createEventsRoutes(options.getSseManager, options.getSyncEngine))
    app.route('/api', createSessionsRoutes(options.getSyncEngine, options.getSseManager, options.store))
    app.route('/api', createMessagesRoutes(options.getSyncEngine, options.store))
    app.route('/api', createPermissionsRoutes(options.getSyncEngine))
    app.route('/api', createMachinesRoutes(options.getSyncEngine, options.store, options.getSseManager))
    app.route('/api', createGitRoutes(options.getSyncEngine))
    app.route('/api', createSpeechRoutes())
    app.route('/api', createOptimizeRoutes())
    app.route('/api', createSettingsRoutes(options.store))
    app.route('/api', createPushRoutes())
    app.route('/api', createYohoCredentialsRoutes())
    app.route('/api', createOrgsRoutes(options.store))
    app.route('/api', createLicensesRoutes(options.store))
    app.route('/api', createDownloadApiRoutes(options.store))

    if (options.embeddedAssetMap) {
        const embeddedAssetMap = options.embeddedAssetMap
        const indexHtmlAsset = embeddedAssetMap.get('/index.html')

        if (!indexHtmlAsset) {
            app.get('*', (c) => {
                return c.text(
                    'Embedded Mini App is missing index.html. Rebuild the executable after running bun run build:web.',
                    503
                )
            })
            return app
        }

        app.use('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                return await next()
            }

            if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
                return await next()
            }

            const asset = embeddedAssetMap.get(c.req.path)
            if (asset) {
                const isHtml = c.req.path.endsWith('.html') || c.req.path === '/'
                return serveEmbeddedAsset(asset, isHtml)
            }

            return await next()
        })

        app.get('*', async (c, next) => {
            if (c.req.path.startsWith('/api')) {
                await next()
                return
            }

            // index.html 作为 SPA fallback，不缓存
            return serveEmbeddedAsset(indexHtmlAsset, true)
        })

        return app
    }

    const { distDir, indexHtmlPath } = findWebappDistDir()

    if (!existsSync(indexHtmlPath)) {
        app.get('/', (c) => {
            return c.text(
                'Mini App is not built.\n\nRun:\n  cd web\n  bun install\n  bun run build\n',
                503
            )
        })
        return app
    }

    // assets 目录下的文件带 hash，可以长期缓存
    app.use('/assets/*', async (c, next) => {
        await next()
        if (c.res) {
            c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        }
    })
    app.use('/assets/*', serveStatic({ root: distDir }))

    // Service Worker 和 manifest 不应该被缓存
    app.get('/sw.js', async (c) => {
        const response = await serveStatic({ root: distDir })(c, async () => {})
        if (response) {
            const newResponse = new Response(response.body, response)
            newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
            return newResponse
        }
        return c.notFound()
    })

    app.get('/manifest.webmanifest', async (c) => {
        const response = await serveStatic({ root: distDir })(c, async () => {})
        if (response) {
            const newResponse = new Response(response.body, response)
            newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
            return newResponse
        }
        return c.notFound()
    })

    app.use('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        return await serveStatic({ root: distDir })(c, next)
    })

    app.get('*', async (c, next) => {
        if (c.req.path.startsWith('/api')) {
            await next()
            return
        }

        // HTML fallback 不缓存，确保 iOS Safari PWA 能获取最新版本
        const response = await serveStatic({ root: distDir, path: 'index.html' })(c, next)
        if (response) {
            const newResponse = new Response(response.body, response)
            newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
            newResponse.headers.set('Pragma', 'no-cache')
            newResponse.headers.set('Expires', '0')
            return newResponse
        }
        return response
    })

    return app
}

export async function startWebServer(options: {
    getSyncEngine: () => SyncEngine | null
    getSseManager: () => SSEManager | null
    store: IStore
    socketEngine: SocketEngine
}): Promise<BunServer<WebSocketData>> {
    const isCompiled = isBunCompiled()
    const embeddedAssetMap = isCompiled ? await loadEmbeddedAssetMap() : null
    const app = createWebApp({
        getSyncEngine: options.getSyncEngine,
        getSseManager: options.getSseManager,
        store: options.store,
        embeddedAssetMap
    })

    const socketHandler = options.socketEngine.handler()
    const socketBodySize = Number.isFinite(socketHandler.maxRequestBodySize)
        ? socketHandler.maxRequestBodySize
        : 0
    const maxHttpBodySize = Math.max(socketBodySize, 150 * 1024 * 1024)  // 150MB to support 100MB file uploads with base64 overhead

    let wsCounter = 0
    const origWs = socketHandler.websocket
    const debugWs = {
        ...origWs,
        open(ws: any) {
            const id = ++wsCounter
            ws.data._dbgId = id
            console.log(`[ws-debug] #${id} open`)
            return origWs.open(ws)
        },
        message(ws: any, message: any) {
            const id = ws.data?._dbgId ?? '?'
            const preview = typeof message === 'string' ? message.substring(0, 50) : `[binary ${(message as any).byteLength}b]`
            // Only log Engine.IO control packets (type 0-6) not Socket.IO data
            if (typeof message === 'string' && message.length <= 1) {
                console.log(`[ws-debug] #${id} ctrl: "${preview}" transport=${!!ws.data?.transport}`)
            }
            return origWs.message(ws, message)
        },
        close(ws: any, code: number, message: string) {
            const id = ws.data?._dbgId ?? '?'
            console.log(`[ws-debug] #${id} close: code=${code}`)
            return origWs.close(ws, code, message)
        },
    }

    const server = Bun.serve({
        port: configuration.webappPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        maxRequestBodySize: maxHttpBodySize,
        websocket: debugWs,
        fetch: (req, server) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, server)
            }
            return app.fetch(req)
        }
    })

    console.log(`[Web] Mini App server listening on :${configuration.webappPort}`)
    console.log(`[Web] Mini App public URL: ${configuration.miniAppUrl}`)

    return server
}
