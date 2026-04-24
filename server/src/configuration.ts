/**
 * Configuration for yoho-remote-server (Direct Connect)
 *
 * Configuration is loaded with priority: environment variable > settings.json > default
 * When values are read from environment variables and not present in settings.json,
 * they are automatically saved for future use.
 *
 * Optional environment variables:
 * - CLI_API_TOKEN: Shared secret for CLI authentication (auto-generated if not set)
 * - WEBAPP_PORT: Port for Mini App HTTP server (default: 3006)
 * - WEBAPP_URL: Public URL for the web app
 * - CORS_ORIGINS: Comma-separated CORS origins
 * - FEISHU_APP_ID: Feishu/Lark app ID for speech-to-text
 * - FEISHU_APP_SECRET: Feishu/Lark app secret for speech-to-text
 * - FEISHU_BASE_URL: Feishu/Lark OpenAPI base URL (default: https://open.feishu.cn)
 * - YOHO_REMOTE_HOME: Data directory (default: ~/.yoho-remote)
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings, type ServerSettings, type ServerSettingsResult } from './serverSettings'
import { getOrCreateCliApiToken } from './web/cliApiToken'

export type ConfigSource = 'env' | 'file' | 'default'

export interface ConfigSources {
    webappPort: ConfigSource
    webappUrl: ConfigSource
    corsOrigins: ConfigSource
    feishuAppId: ConfigSource
    feishuAppSecret: ConfigSource
    feishuBaseUrl: ConfigSource
    geminiApiKey: ConfigSource
    webPushVapidPublicKey?: ConfigSource
    webPushVapidPrivateKey?: ConfigSource
    webPushVapidSubject?: ConfigSource
    cliApiToken: 'env' | 'file' | 'generated'
}

class Configuration {
    /** CLI auth token (shared secret) */
    public cliApiToken: string

    /** Source of CLI API token */
    public cliApiTokenSource: 'env' | 'file' | 'generated' | ''

    /** Whether CLI API token was newly generated (for first-run display) */
    public cliApiTokenIsNew: boolean

    /** Path to settings.json file */
    public readonly settingsFile: string

    /** Data directory for credentials and state */
    public readonly dataDir: string

    /** Port for the Mini App HTTP server */
    public readonly webappPort: number

    /** Public HTTPS URL for the web app */
    public readonly miniAppUrl: string

    /** Allowed CORS origins for Mini App + Socket.IO (comma-separated env override) */
    public readonly corsOrigins: string[]

    /** Feishu/Lark app ID (speech-to-text) */
    public readonly feishuAppId: string | null

    /** Feishu/Lark app secret (speech-to-text) */
    public readonly feishuAppSecret: string | null

    /** Feishu/Lark OpenAPI base URL */
    public readonly feishuBaseUrl: string

    /** Gemini API key (text optimization) */
    public readonly geminiApiKey: string | null

    /** Web Push VAPID public key */
    public readonly webPushVapidPublicKey: string | null

    /** Web Push VAPID private key */
    public readonly webPushVapidPrivateKey: string | null

    /** Web Push VAPID subject (mailto: or https: URL) */
    public readonly webPushVapidSubject: string | null

    /** Sources of each configuration value */
    public readonly sources: ConfigSources

    /** Private constructor - use createConfiguration() instead */
    private constructor(
        dataDir: string,
        serverSettings: ServerSettings,
        sources: ServerSettingsResult['sources']
    ) {
        this.dataDir = dataDir
        this.settingsFile = join(dataDir, 'settings.json')

        // Apply server settings
        this.webappPort = serverSettings.webappPort
        this.miniAppUrl = serverSettings.webappUrl
        this.corsOrigins = serverSettings.corsOrigins
        this.feishuAppId = serverSettings.feishuAppId
        this.feishuAppSecret = serverSettings.feishuAppSecret
        this.feishuBaseUrl = serverSettings.feishuBaseUrl
        this.geminiApiKey = serverSettings.geminiApiKey
        this.webPushVapidPublicKey = serverSettings.webPushVapidPublicKey
        this.webPushVapidPrivateKey = serverSettings.webPushVapidPrivateKey
        this.webPushVapidSubject = serverSettings.webPushVapidSubject

        // CLI API token - will be set by _setCliApiToken() before create() returns
        this.cliApiToken = ''
        this.cliApiTokenSource = ''
        this.cliApiTokenIsNew = false

        // Store sources for logging (cliApiToken will be set by _setCliApiToken)
        this.sources = {
            ...sources,
        } as ConfigSources

        // Ensure data directory exists
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }
    }

    /** Create configuration asynchronously */
    static async create(): Promise<Configuration> {
        // 1. Determine data directory (env only - not persisted)
        const dataDir = process.env.YOHO_REMOTE_HOME
            ? process.env.YOHO_REMOTE_HOME.replace(/^~/, homedir())
            : join(homedir(), '.yoho-remote')

        // Ensure data directory exists before loading settings
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true })
        }

        // 2. Load server settings (with persistence)
        const settingsResult = await loadServerSettings(dataDir)

        if (settingsResult.savedToFile) {
            console.log(`[Server] Configuration saved to ${join(dataDir, 'settings.json')}`)
        }

        // 3. Create configuration instance
        const config = new Configuration(
            dataDir,
            settingsResult.settings,
            settingsResult.sources
        )

        // 4. Load CLI API token
        const tokenResult = await getOrCreateCliApiToken(dataDir)
        config._setCliApiToken(tokenResult.token, tokenResult.source, tokenResult.isNew)

        return config
    }

    /** Set CLI API token (called during async initialization) */
    _setCliApiToken(token: string, source: 'env' | 'file' | 'generated', isNew: boolean): void {
        this.cliApiToken = token
        this.cliApiTokenSource = source
        this.cliApiTokenIsNew = isNew
        ;(this.sources as { cliApiToken: string }).cliApiToken = source
    }
}

// Singleton instance (set by createConfiguration)
let _configuration: Configuration | null = null

/**
 * Create and initialize configuration asynchronously.
 * Must be called once at startup before getConfiguration() can be used.
 */
export async function createConfiguration(): Promise<Configuration> {
    if (_configuration) {
        return _configuration
    }
    _configuration = await Configuration.create()
    return _configuration
}

/**
 * Get the initialized configuration.
 * Throws if createConfiguration() has not been called yet.
 */
export function getConfiguration(): Configuration {
    if (!_configuration) {
        throw new Error('Configuration not initialized. Call createConfiguration() first.')
    }
    return _configuration
}

// For compatibility - throws on access if not configured
export const configuration = new Proxy({} as Configuration, {
    get(_, prop) {
        return getConfiguration()[prop as keyof Configuration]
    }
})
