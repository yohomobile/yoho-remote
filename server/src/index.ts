/**
 * HAPI Server - Main Entry Point
 *
 * Provides:
 * - Web app + HTTP API
 * - Socket.IO for CLI connections
 * - SSE updates for the web UI
 * - Optional Telegram bot for notifications and Mini App entrypoint
 */

import { createConfiguration, type ConfigSource } from './configuration'
import { PostgresStore } from './store/postgres'
import type { IStore } from './store/interface'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import { initWebPushService } from './services/webPush'
import { startTokenRefreshTimer, stopTokenRefreshTimer } from './claude-accounts/accountsService'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'

/** Format config source for logging */
function formatSource(source: ConfigSource | 'generated'): string {
    switch (source) {
        case 'env':
            return 'environment'
        case 'file':
            return 'settings.json'
        case 'default':
            return 'default'
        case 'generated':
            return 'generated'
    }
}

let syncEngine: SyncEngine | null = null
let happyBot: HappyBot | null = null
let webServer: BunServer<WebSocketData> | null = null
let sseManager: SSEManager | null = null

async function main() {
    console.log('HAPI Server starting...')

    // Load configuration (async - loads from env/file with persistence)
    const config = await createConfiguration()

    // Display CLI API token information
    if (config.cliApiTokenIsNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log('')
        console.log(`  Token: ${config.cliApiToken}`)
        console.log('')
        console.log(`  Saved to: ${config.settingsFile}`)
        console.log('')
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Server] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`)
    }

    // Display other configuration sources
    console.log(`[Server] WEBAPP_PORT: ${config.webappPort} (${formatSource(config.sources.webappPort)})`)
    console.log(`[Server] WEBAPP_URL: ${config.miniAppUrl} (${formatSource(config.sources.webappUrl)})`)

    if (!config.telegramEnabled) {
        console.log('[Server] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        console.log(`[Server] Telegram: enabled (${tokenSource})`)
    }

    if (!config.feishuAppId || !config.feishuAppSecret) {
        console.log('[Server] Feishu STT: disabled (missing FEISHU_APP_ID/FEISHU_APP_SECRET)')
    } else {
        const appIdSource = formatSource(config.sources.feishuAppId)
        const appSecretSource = formatSource(config.sources.feishuAppSecret)
        console.log(`[Server] Feishu STT: enabled (${appIdSource}/${appSecretSource})`)
    }

    // Initialize PostgreSQL store
    const pgConfig = {
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432', 10),
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
        database: process.env.PG_DATABASE || 'hapi',
        ssl: process.env.PG_SSL === 'true'
    }
    console.log(`[Server] Store: PostgreSQL (${pgConfig.host}/${pgConfig.database})`)
    const store = await PostgresStore.create(pgConfig)

    // Initialize Web Push service
    const webPushConfig = config.webPushVapidPublicKey && config.webPushVapidPrivateKey && config.webPushVapidSubject
        ? {
            vapidPublicKey: config.webPushVapidPublicKey,
            vapidPrivateKey: config.webPushVapidPrivateKey,
            vapidSubject: config.webPushVapidSubject
        }
        : null
    initWebPushService(store, webPushConfig)
    if (webPushConfig) {
        console.log('[Server] Web Push: enabled')
    } else {
        console.log('[Server] Web Push: disabled (missing VAPID keys)')
    }

    console.log('[Server] Auth: Keycloak SSO')

    sseManager = new SSEManager(30_000)

    const socketServer = createSocketServer({
        store,
        getSession: (sessionId) => syncEngine?.getSession(sessionId) ?? store.getSession(sessionId),
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry, sseManager)

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            miniAppUrl: config.miniAppUrl,
            store
        })
    }

    // Start HTTP server
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        store,
        socketEngine: socketServer.engine
    })

    // Start background token refresh timer for Claude accounts
    startTokenRefreshTimer()

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    console.log('\nHAPI Server is ready!')

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...')
        stopTokenRefreshTimer()
        await happyBot?.stop()
        syncEngine?.stop()
        sseManager?.stop()
        webServer?.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep process running
    await new Promise(() => {})
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
