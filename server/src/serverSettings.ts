/**
 * Server Settings Management
 *
 * Handles loading and persistence of server configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use.
 */

import { join } from 'node:path'
import { readSettings, writeSettings, type Settings } from './web/cliApiToken'

export interface ServerSettings {
    webappPort: number
    webappUrl: string
    corsOrigins: string[]
    feishuAppId: string | null
    feishuAppSecret: string | null
    feishuBaseUrl: string
    geminiApiKey: string | null
    webPushVapidPublicKey: string | null
    webPushVapidPrivateKey: string | null
    webPushVapidSubject: string | null
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        webappPort: 'env' | 'file' | 'default'
        webappUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
        feishuAppId: 'env' | 'file' | 'default'
        feishuAppSecret: 'env' | 'file' | 'default'
        feishuBaseUrl: 'env' | 'file' | 'default'
        geminiApiKey: 'env' | 'file' | 'default'
        webPushVapidPublicKey: 'env' | 'file' | 'default'
        webPushVapidPrivateKey: 'env' | 'file' | 'default'
        webPushVapidSubject: 'env' | 'file' | 'default'
    }
    savedToFile: boolean
}

/**
 * Parse and normalize CORS origins
 */
function parseCorsOrigins(str: string): string[] {
    const entries = str
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)

    if (entries.includes('*')) {
        return ['*']
    }

    const normalized: string[] = []
    for (const entry of entries) {
        try {
            normalized.push(new URL(entry).origin)
        } catch {
            // Keep raw value if it's already an origin-like string
            normalized.push(entry)
        }
    }
    return normalized
}

/**
 * Derive CORS origins from webapp URL
 */
function deriveCorsOrigins(webappUrl: string): string[] {
    try {
        return [new URL(webappUrl).origin]
    } catch {
        return []
    }
}

/**
 * Load server settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = join(dataDir, 'settings.json')
    const settings = await readSettings(settingsFile)

    // If settings file exists but couldn't be parsed, fail fast
    if (settings === null) {
        throw new Error(
            `Cannot read ${settingsFile}. Please fix or remove the file and restart.`
        )
    }

    let needsSave = false
    const sources: ServerSettingsResult['sources'] = {
        webappPort: 'default',
        webappUrl: 'default',
        corsOrigins: 'default',
        feishuAppId: 'default',
        feishuAppSecret: 'default',
        feishuBaseUrl: 'default',
        geminiApiKey: 'default',
        webPushVapidPublicKey: 'default',
        webPushVapidPrivateKey: 'default',
        webPushVapidSubject: 'default',
    }

    // webappPort: env > file > 3006
    let webappPort = 3006
    if (process.env.WEBAPP_PORT) {
        const parsed = parseInt(process.env.WEBAPP_PORT, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('WEBAPP_PORT must be a valid port number')
        }
        webappPort = parsed
        sources.webappPort = 'env'
        if (settings.webappPort === undefined) {
            settings.webappPort = webappPort
            needsSave = true
        }
    } else if (settings.webappPort !== undefined) {
        webappPort = settings.webappPort
        sources.webappPort = 'file'
    }

    // webappUrl: env > file > http://localhost:{port}
    let webappUrl = `http://localhost:${webappPort}`
    if (process.env.WEBAPP_URL) {
        webappUrl = process.env.WEBAPP_URL
        sources.webappUrl = 'env'
        if (settings.webappUrl === undefined) {
            settings.webappUrl = webappUrl
            needsSave = true
        }
    } else if (settings.webappUrl !== undefined) {
        webappUrl = settings.webappUrl
        sources.webappUrl = 'file'
    }

    // corsOrigins: env > file > derived from webappUrl
    let corsOrigins: string[]
    if (process.env.CORS_ORIGINS) {
        corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS)
        sources.corsOrigins = 'env'
        if (settings.corsOrigins === undefined) {
            settings.corsOrigins = corsOrigins
            needsSave = true
        }
    } else if (settings.corsOrigins !== undefined) {
        corsOrigins = settings.corsOrigins
        sources.corsOrigins = 'file'
    } else {
        corsOrigins = deriveCorsOrigins(webappUrl)
    }

    // feishuAppId: env > file > null
    let feishuAppId: string | null = null
    if (process.env.FEISHU_APP_ID) {
        feishuAppId = process.env.FEISHU_APP_ID
        sources.feishuAppId = 'env'
        if (settings.feishuAppId === undefined) {
            settings.feishuAppId = feishuAppId
            needsSave = true
        }
    } else if (settings.feishuAppId !== undefined) {
        feishuAppId = settings.feishuAppId ?? null
        sources.feishuAppId = 'file'
    } else if (settings.appId !== undefined) {
        feishuAppId = settings.appId ?? null
        sources.feishuAppId = 'file'
    }

    // feishuAppSecret: env > file > null
    let feishuAppSecret: string | null = null
    if (process.env.FEISHU_APP_SECRET) {
        feishuAppSecret = process.env.FEISHU_APP_SECRET
        sources.feishuAppSecret = 'env'
        if (settings.feishuAppSecret === undefined) {
            settings.feishuAppSecret = feishuAppSecret
            needsSave = true
        }
    } else if (settings.feishuAppSecret !== undefined) {
        feishuAppSecret = settings.feishuAppSecret ?? null
        sources.feishuAppSecret = 'file'
    } else if (settings.appSecret !== undefined) {
        feishuAppSecret = settings.appSecret ?? null
        sources.feishuAppSecret = 'file'
    }

    // feishuBaseUrl: env > file > https://open.feishu.cn
    let feishuBaseUrl = 'https://open.feishu.cn'
    if (process.env.FEISHU_BASE_URL) {
        feishuBaseUrl = process.env.FEISHU_BASE_URL
        sources.feishuBaseUrl = 'env'
        if (settings.feishuBaseUrl === undefined) {
            settings.feishuBaseUrl = feishuBaseUrl
            needsSave = true
        }
    } else if (settings.feishuBaseUrl !== undefined) {
        feishuBaseUrl = settings.feishuBaseUrl || feishuBaseUrl
        sources.feishuBaseUrl = 'file'
    }

    // geminiApiKey: env > file > null
    let geminiApiKey: string | null = null
    if (process.env.GEMINI_API_KEY) {
        geminiApiKey = process.env.GEMINI_API_KEY
        sources.geminiApiKey = 'env'
        if (settings.geminiApiKey === undefined) {
            settings.geminiApiKey = geminiApiKey
            needsSave = true
        }
    } else if (settings.geminiApiKey !== undefined) {
        geminiApiKey = settings.geminiApiKey ?? null
        sources.geminiApiKey = 'file'
    }

    // webPushVapidPublicKey: env > file > null
    let webPushVapidPublicKey: string | null = null
    if (process.env.WEB_PUSH_VAPID_PUBLIC_KEY) {
        webPushVapidPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
        sources.webPushVapidPublicKey = 'env'
        if (settings.webPushVapidPublicKey === undefined) {
            settings.webPushVapidPublicKey = webPushVapidPublicKey
            needsSave = true
        }
    } else if (settings.webPushVapidPublicKey !== undefined) {
        webPushVapidPublicKey = settings.webPushVapidPublicKey ?? null
        sources.webPushVapidPublicKey = 'file'
    }

    // webPushVapidPrivateKey: env > file > null
    let webPushVapidPrivateKey: string | null = null
    if (process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
        webPushVapidPrivateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
        sources.webPushVapidPrivateKey = 'env'
        if (settings.webPushVapidPrivateKey === undefined) {
            settings.webPushVapidPrivateKey = webPushVapidPrivateKey
            needsSave = true
        }
    } else if (settings.webPushVapidPrivateKey !== undefined) {
        webPushVapidPrivateKey = settings.webPushVapidPrivateKey ?? null
        sources.webPushVapidPrivateKey = 'file'
    }

    // webPushVapidSubject: env > file > null (should be a mailto: or https: URL)
    let webPushVapidSubject: string | null = null
    if (process.env.WEB_PUSH_VAPID_SUBJECT) {
        webPushVapidSubject = process.env.WEB_PUSH_VAPID_SUBJECT
        sources.webPushVapidSubject = 'env'
        if (settings.webPushVapidSubject === undefined) {
            settings.webPushVapidSubject = webPushVapidSubject
            needsSave = true
        }
    } else if (settings.webPushVapidSubject !== undefined) {
        webPushVapidSubject = settings.webPushVapidSubject ?? null
        sources.webPushVapidSubject = 'file'
    }

    // Save settings if any new values were added
    if (needsSave) {
        await writeSettings(settingsFile, settings)
    }

    return {
        settings: {
            webappPort,
            webappUrl,
            corsOrigins,
            feishuAppId,
            feishuAppSecret,
            feishuBaseUrl,
            geminiApiKey,
            webPushVapidPublicKey,
            webPushVapidPrivateKey,
            webPushVapidSubject,
        },
        sources,
        savedToFile: needsSave,
    }
}
