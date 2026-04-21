import { Server as Engine } from '@socket.io/bun-engine'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Server } from 'socket.io'
import { getE2EEnv } from '../env'
import { FakeKeycloak } from './fakeKeycloak'
import {
    assertRenderableMockMessage,
    appendSseClient,
    broadcastSse,
    createMockState,
    removeSseClient,
    toFullSession,
    type MockMessage,
} from './mockState'

function parseAccessToken(raw: string | null): { baseToken: string; namespace: string } | null {
    if (!raw) return null
    const trimmed = raw.trim()
    if (!trimmed) return null
    const separatorIndex = trimmed.lastIndexOf(':')
    if (separatorIndex === -1) return { baseToken: trimmed, namespace: 'default' }
    const baseToken = trimmed.slice(0, separatorIndex)
    const namespace = trimmed.slice(separatorIndex + 1)
    if (!baseToken || !namespace) return null
    if (baseToken.trim() !== baseToken || namespace.trim() !== namespace) return null
    return { baseToken, namespace }
}

function json(data: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(data), {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...(init?.headers ?? {}),
        },
    })
}

function getBearerToken(req: Request): string | null {
    const header = req.headers.get('authorization')
    if (header?.startsWith('Bearer ')) {
        return header.slice('Bearer '.length)
    }
    return null
}

async function main(): Promise<void> {
    const env = getE2EEnv()
    const state = createMockState(env.runId)
    const keycloak = new FakeKeycloak({
        publicUrl: env.mockApiUrl,
        realm: env.keycloakRealm,
        clientId: env.keycloakClientId,
        clientSecret: env.keycloakClientSecret,
        defaultUser: state.user,
    })
    await keycloak.init()

    const app = new Hono()
    app.use('*', cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['authorization', 'content-type', 'x-client-id'],
    }))

    app.get('/__health', (c) => c.json({
        ok: true,
        runId: env.runId,
        dbSchema: env.dbSchema,
        keycloak: `${env.mockApiUrl}/realms/${env.keycloakRealm}`,
    }))

    app.get('/__state', (c) => c.json({
        runId: env.runId,
        sessions: state.sessions,
        messages: Object.fromEntries(state.messages),
        downloads: Object.fromEntries(state.downloads),
        sseClients: state.sseClients.size,
    }))

    app.get('/realms/:realm/.well-known/openid-configuration', (c) => {
        const realm = c.req.param('realm')
        return c.json({
            issuer: `${env.mockApiUrl}/realms/${realm}`,
            authorization_endpoint: `${env.mockApiUrl}/realms/${realm}/protocol/openid-connect/auth`,
            token_endpoint: `${env.mockApiUrl}/realms/${realm}/protocol/openid-connect/token`,
            jwks_uri: `${env.mockApiUrl}/realms/${realm}/protocol/openid-connect/certs`,
        })
    })

    app.get('/realms/:realm/protocol/openid-connect/certs', (c) => c.json(keycloak.jwks))

    app.get('/realms/:realm/protocol/openid-connect/auth', (c) => {
        const query = c.req.query()
        const redirectUri = query.redirect_uri
        if (!redirectUri) {
            return c.text('missing redirect_uri', 400)
        }
        const url = new URL(redirectUri)
        url.searchParams.set('code', keycloak.createAuthorizationCode())
        if (query.state) {
            url.searchParams.set('state', query.state)
        }
        return c.redirect(url.toString(), 302)
    })

    app.post('/realms/:realm/protocol/openid-connect/token', async (c) => {
        const body = await c.req.parseBody()
        const grantType = String(body.grant_type ?? '')
        const clientSecret = String(body.client_secret ?? '')
        if (clientSecret !== env.keycloakClientSecret) {
            return c.json({ error: 'invalid_client' }, 401)
        }

        try {
            const tokens = grantType === 'refresh_token'
                ? await keycloak.refresh(String(body.refresh_token ?? ''))
                : await keycloak.exchangeCode(String(body.code ?? ''))
            return c.json({
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                id_token: tokens.idToken,
                expires_in: tokens.expiresIn,
                token_type: tokens.tokenType,
            })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'invalid_grant' }, 400)
        }
    })

    app.post('/api/auth/keycloak', async (c) => {
        const body = await c.req.json().catch(() => ({})) as { redirectUri?: string; state?: string }
        if (!body.redirectUri) {
            return c.json({ error: 'redirectUri is required' }, 400)
        }
        const params = new URLSearchParams({
            client_id: env.keycloakClientId,
            redirect_uri: body.redirectUri,
            response_type: 'code',
            scope: 'openid profile email',
        })
        if (body.state) params.set('state', body.state)
        return c.json({
            loginUrl: `${env.mockApiUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/auth?${params.toString()}`,
        })
    })

    app.post('/api/auth/keycloak/callback', async (c) => {
        const body = await c.req.json().catch(() => ({})) as { code?: string }
        try {
            const tokens = await keycloak.exchangeCode(body.code ?? '')
            return c.json({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresIn: tokens.expiresIn,
                user: {
                    email: tokens.user.email,
                    name: tokens.user.name,
                    sub: tokens.user.sub,
                },
            })
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Token exchange failed' }, 400)
        }
    })

    app.post('/api/auth/keycloak/refresh', async (c) => {
        const body = await c.req.json().catch(() => ({})) as { refreshToken?: string }
        try {
            const tokens = await keycloak.refresh(body.refreshToken ?? '')
            return c.json({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresIn: tokens.expiresIn,
                user: {
                    email: tokens.user.email,
                    name: tokens.user.name,
                    sub: tokens.user.sub,
                },
            })
        } catch {
            return c.json({ error: 'Invalid refresh token' }, 401)
        }
    })

    app.post('/api/auth/keycloak/logout', (c) => {
        const bodyPromise = c.req.json().catch(() => ({}))
        return bodyPromise.then((body: { redirectUri?: string }) => {
            return c.json({ logoutUrl: body.redirectUri || env.webBaseUrl })
        })
    })

    app.use('/api/*', async (c, next) => {
        if (c.req.path.startsWith('/api/auth/keycloak') || c.req.path === '/api/version') {
            await next()
            return
        }

        const token = getBearerToken(c.req.raw) ?? c.req.query('token') ?? null
        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        try {
            await keycloak.verifyAccessToken(token)
            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    })

    app.get('/api/version', (c) => c.json({ version: 'e2e-smoke' }))
    app.get('/api/orgs', (c) => c.json({ orgs: [state.org] }))
    app.get('/api/orgs/:orgId', (c) => c.json({
        org: state.org,
        members: [{
            orgId: state.org.id,
            userEmail: state.user.email,
            userId: state.user.sub,
            role: state.org.myRole,
            joinedAt: state.org.createdAt,
            invitedBy: null,
        }],
        myRole: state.org.myRole,
        licenseExempt: true,
        license: null,
    }))
    app.get('/api/settings/me', (c) => c.json({
        email: state.user.email,
        name: state.user.name,
        role: 'operator',
        orgs: [{ id: state.org.id, name: state.org.name, role: state.org.myRole }],
    }))
    app.get('/api/settings/user-preferences', (c) => c.json({
        shareAllSessions: true,
        viewOthersSessions: true,
    }))
    app.get('/api/settings/projects', (c) => c.json({
        projects: [{
            id: 'project-e2e',
            name: 'yoho-e2e',
            path: '/tmp/yoho-e2e',
            description: 'E2E smoke project',
            machineId: state.sessions[0]?.metadata.machineId ?? null,
            createdAt: Date.now() - 120_000,
            updatedAt: Date.now() - 120_000,
        }],
    }))
    app.get('/api/machines', (c) => c.json({
        machines: [{
            id: state.sessions[0]?.metadata.machineId ?? 'machine-e2e',
            active: true,
            activeAt: Date.now(),
            createdAt: Date.now() - 120_000,
            updatedAt: Date.now(),
            metadata: {
                host: 'e2e-host',
                platform: 'linux',
                yohoRemoteCliVersion: 'e2e',
                displayName: 'E2E Machine',
            },
            daemonState: null,
            supportedAgents: ['claude', 'codex'],
        }],
    }))
    app.get('/api/online-users', (c) => c.json({ users: [] }))

    app.get('/api/sessions', (c) => c.json({ sessions: state.sessions }))
    app.get('/api/sessions/:sessionId', (c) => {
        const session = state.sessions.find(s => s.id === c.req.param('sessionId'))
        if (!session) return c.json({ error: 'Session not found' }, 404)
        return c.json({ session: toFullSession(session) })
    })
    app.get('/api/sessions/:sessionId/messages', (c) => {
        const sessionId = c.req.param('sessionId')
        const messages = state.messages.get(sessionId) ?? []
        return c.json({
            messages,
            page: {
                limit: Number(c.req.query('limit') ?? 200),
                beforeSeq: null,
                nextBeforeSeq: null,
                hasMore: false,
            },
        })
    })
    app.get('/api/sessions/:sessionId/messages/count', (c) => {
        const messages = state.messages.get(c.req.param('sessionId')) ?? []
        return c.json({ count: messages.length })
    })
    app.get('/api/sessions/:sessionId/slash-commands', (c) => c.json({
        success: true,
        commands: [{ name: '/compact', description: 'Fake compact command', source: 'builtin' }],
    }))
    app.post('/api/sessions/:sessionId/typing', (c) => c.json({ ok: true }))
    app.post('/api/sessions/:sessionId/messages', async (c) => {
        const sessionId = c.req.param('sessionId')
        const body = await c.req.json().catch(() => ({})) as { text?: string; localId?: string }
        const messages = state.messages.get(sessionId)
        const session = state.sessions.find(s => s.id === sessionId)
        if (!messages || !session) return c.json({ error: 'Session not found' }, 404)

        const seq = messages.length + 1
        const createdAt = Date.now()
        const text = body.text?.trim() || 'empty e2e message'
        const userMessage: MockMessage = {
            id: `${sessionId}-m${seq}`,
            seq,
            localId: body.localId ?? null,
            createdAt,
            content: { role: 'user', content: { type: 'text', text } },
            status: 'sent',
            originalText: text,
        }
        assertRenderableMockMessage(userMessage)
        messages.push(userMessage)
        session.thinking = true
        session.updatedAt = createdAt
        session.lastMessageAt = createdAt
        broadcastSse(state, {
            type: 'message-received',
            namespace: state.namespace,
            sessionId,
            message: userMessage,
        })
        broadcastSse(state, {
            type: 'session-updated',
            namespace: state.namespace,
            sessionId,
            data: toFullSession(session),
        })

        setTimeout(() => {
            const assistantMessage: MockMessage = {
                id: `${sessionId}-m${seq + 1}`,
                seq: seq + 1,
                localId: null,
                createdAt: Date.now(),
                content: {
                    role: 'assistant',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            message: {
                                role: 'assistant',
                                content: [{ type: 'text', text: `Fake agent acknowledged: ${text}` }],
                            },
                        },
                    },
                },
            }
            assertRenderableMockMessage(assistantMessage)
            messages.push(assistantMessage)
            session.thinking = false
            session.updatedAt = assistantMessage.createdAt
            session.lastMessageAt = assistantMessage.createdAt
            const files = state.downloads.get(sessionId) ?? []
            if (!files.some(file => file.filename === 'e2e-result.txt')) {
                files.push({
                    id: `download-result-${env.runId}`,
                    sessionId,
                    orgId: state.org.id,
                    filename: 'e2e-result.txt',
                    mimeType: 'text/plain',
                    size: 64,
                    createdAt: Date.now(),
                    content: `Fake task result for ${env.runId}\n`,
                })
                state.downloads.set(sessionId, files)
                broadcastSse(state, {
                    type: 'file-ready',
                    namespace: state.namespace,
                    sessionId,
                    fileInfo: {
                        id: `download-result-${env.runId}`,
                        filename: 'e2e-result.txt',
                        size: 64,
                        mimeType: 'text/plain',
                    },
                })
            }
            broadcastSse(state, {
                type: 'message-received',
                namespace: state.namespace,
                sessionId,
                message: assistantMessage,
            })
            broadcastSse(state, {
                type: 'session-updated',
                namespace: state.namespace,
                sessionId,
                data: toFullSession(session),
            })
        }, 250)

        return c.json({ ok: true, sessionId, status: 'delivered' })
    })

    app.get('/api/sessions/:sessionId/downloads', (c) => {
        const files = state.downloads.get(c.req.param('sessionId')) ?? []
        return c.json({
            files: files.map(({ content: _content, ...file }) => file),
        })
    })
    app.delete('/api/sessions/:sessionId/downloads', (c) => {
        const sessionId = c.req.param('sessionId')
        const count = state.downloads.get(sessionId)?.length ?? 0
        state.downloads.set(sessionId, [])
        return c.json({ cleared: count })
    })
    app.get('/api/downloads/:downloadId', (c) => {
        const downloadId = c.req.param('downloadId')
        for (const files of state.downloads.values()) {
            const file = files.find(candidate => candidate.id === downloadId)
            if (file) {
                return c.body(file.content, 200, {
                    'content-type': file.mimeType,
                    'content-disposition': `attachment; filename="${file.filename}"`,
                })
            }
        }
        return c.json({ error: 'Download not found' }, 404)
    })

    app.get('/api/events', (c) => {
        const token = c.req.query('token')
        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const client = {
                    id: c.req.query('clientId') || crypto.randomUUID(),
                    namespace: state.namespace,
                    controller,
                }
                appendSseClient(state, client)
                c.req.raw.signal.addEventListener('abort', () => {
                    removeSseClient(state, client)
                    controller.close()
                }, { once: true })
            },
        })
        return new Response(stream, {
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
                'access-control-allow-origin': '*',
            },
        })
    })

    const io = new Server({
        cors: { origin: '*', methods: ['GET', 'POST'] },
    })
    const engine = new Engine({ path: '/socket.io/' })
    io.bind(engine)

    const cliNamespace = io.of('/cli')
    cliNamespace.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        const parsed = parseAccessToken(token)
        if (!parsed || parsed.baseToken !== env.cliApiToken) {
            return next(new Error('Invalid token'))
        }
        socket.data.namespace = parsed.namespace
        next()
    })
    cliNamespace.on('connection', (socket) => {
        socket.emit('e2e:ready', {
            namespace: socket.data.namespace,
            runId: env.runId,
        })
    })

    const socketHandler = engine.handler()
    const server = Bun.serve({
        port: env.mockApiPort,
        idleTimeout: Math.max(30, socketHandler.idleTimeout),
        websocket: socketHandler.websocket,
        fetch: (req, bunServer) => {
            const url = new URL(req.url)
            if (url.pathname.startsWith('/socket.io/')) {
                return socketHandler.fetch(req, bunServer)
            }
            return app.fetch(req)
        },
    })

    const shutdown = () => {
        io.close()
        server.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    console.log(`[e2e] mock API listening on ${env.mockApiUrl}`)
    await new Promise(() => {})
}

main().catch((error) => {
    console.error('[e2e] mock API failed:', error)
    process.exit(1)
})
