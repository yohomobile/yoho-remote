/**
 * 统一凭证管理模块
 *
 * 集中管理所有凭证和 API Token，包括：
 * - CLI API Token (Web 认证)
 * - JWT Secret (会话签名)
 * - Feishu/Lark App Credentials
 * - Gemini API Key
 * - Web Push VAPID Keys
 * - MiniMax API Key
 *
 * 凭证目录结构：
 * ~/.yoho-remote/credentials/
 *   ├── jwt-secret.json      # JWT 签名密钥
 *   ├── api-tokens.json      # 各类 API Token
 *   └── vapid-keys.json      # Web Push VAPID 密钥对
 */

import { existsSync, mkdirSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// ==================== Types ====================

export interface JwtSecretData {
    secretBase64: string
    createdAt: number
}

export interface ApiTokensData {
    cliApiToken?: string
    feishuAppId?: string
    feishuAppSecret?: string
    geminiApiKey?: string
    minimaxApiKey?: string
    minimaxGroupId?: string
    updatedAt: number
}

export interface VapidKeysData {
    publicKey: string
    privateKey: string
    subject: string
    createdAt: number
}

export interface AllCredentials {
    jwtSecret: Uint8Array
    cliApiToken: string
    feishuAppId: string | null
    feishuAppSecret: string | null
    geminiApiKey: string | null
    minimaxApiKey: string | null
    minimaxGroupId: string | null
    vapidPublicKey: string | null
    vapidPrivateKey: string | null
    vapidSubject: string | null
}

// ==================== Credential Manager ====================

export class CredentialManager {
    private readonly credentialsDir: string
    private readonly jwtSecretFile: string
    private readonly apiTokensFile: string
    private readonly vapidKeysFile: string

    private jwtSecret: Uint8Array | null = null
    private apiTokens: ApiTokensData | null = null
    private vapidKeys: VapidKeysData | null = null

    constructor(dataDir: string) {
        this.credentialsDir = join(dataDir, 'credentials')
        this.jwtSecretFile = join(this.credentialsDir, 'jwt-secret.json')
        this.apiTokensFile = join(this.credentialsDir, 'api-tokens.json')
        this.vapidKeysFile = join(this.credentialsDir, 'vapid-keys.json')
    }

    /**
     * 确保凭证目录存在
     */
    private async ensureCredentialsDir(): Promise<void> {
        if (!existsSync(this.credentialsDir)) {
            await mkdir(this.credentialsDir, { recursive: true, mode: 0o700 })
        }
    }

    /**
     * 安全写入文件（原子操作）
     */
    private async writeSecurely(filePath: string, data: object): Promise<void> {
        await this.ensureCredentialsDir()
        const tmpFile = filePath + '.tmp'
        await writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 })
        await rename(tmpFile, filePath)
        await chmod(filePath, 0o600).catch(() => {})
    }

    /**
     * 安全读取文件
     */
    private async readSecurely<T>(filePath: string): Promise<T | null> {
        if (!existsSync(filePath)) {
            return null
        }
        try {
            await chmod(filePath, 0o600).catch(() => {})
            const content = await readFile(filePath, 'utf8')
            return JSON.parse(content) as T
        } catch (error) {
            console.error(`[CredentialManager] Failed to read ${filePath}:`, error)
            return null
        }
    }

    // ==================== JWT Secret ====================

    /**
     * 获取或创建 JWT Secret
     */
    async getJwtSecret(): Promise<Uint8Array> {
        if (this.jwtSecret) {
            return this.jwtSecret
        }

        // 尝试读取现有文件
        const data = await this.readSecurely<JwtSecretData>(this.jwtSecretFile)
        if (data?.secretBase64) {
            const bytes = new Uint8Array(Buffer.from(data.secretBase64, 'base64'))
            if (bytes.length === 32) {
                this.jwtSecret = bytes
                return bytes
            }
        }

        // 生成新的 secret
        const newSecret = new Uint8Array(randomBytes(32))
        await this.writeSecurely(this.jwtSecretFile, {
            secretBase64: Buffer.from(newSecret).toString('base64'),
            createdAt: Date.now()
        } as JwtSecretData)

        this.jwtSecret = newSecret
        console.log('[CredentialManager] Generated new JWT secret')
        return newSecret
    }

    // ==================== API Tokens ====================

    /**
     * 获取 API Tokens
     */
    async getApiTokens(): Promise<ApiTokensData> {
        if (this.apiTokens) {
            return this.apiTokens
        }

        const data = await this.readSecurely<ApiTokensData>(this.apiTokensFile)
        this.apiTokens = data || { updatedAt: 0 }
        return this.apiTokens
    }

    /**
     * 更新 API Tokens
     */
    async updateApiTokens(updates: Partial<Omit<ApiTokensData, 'updatedAt'>>): Promise<void> {
        const current = await this.getApiTokens()
        const updated = { ...current, ...updates, updatedAt: Date.now() }
        await this.writeSecurely(this.apiTokensFile, updated)
        this.apiTokens = updated
    }

    /**
     * 获取或生成 CLI API Token
     */
    async getCliApiToken(): Promise<string> {
        // 1. 环境变量优先
        const envToken = process.env.CLI_API_TOKEN
        if (envToken) {
            return this.normalizeToken(envToken)
        }

        // 2. 从文件读取
        const tokens = await this.getApiTokens()
        if (tokens.cliApiToken) {
            return tokens.cliApiToken
        }

        // 3. 生成新 token
        const newToken = randomBytes(32).toString('base64url')
        await this.updateApiTokens({ cliApiToken: newToken })
        console.log('[CredentialManager] Generated new CLI API token')
        return newToken
    }

    /**
     * 获取 Feishu 凭证
     */
    async getFeishuCredentials(): Promise<{ appId: string | null; appSecret: string | null }> {
        const tokens = await this.getApiTokens()
        return {
            appId: process.env.FEISHU_APP_ID || tokens.feishuAppId || null,
            appSecret: process.env.FEISHU_APP_SECRET || tokens.feishuAppSecret || null
        }
    }

    /**
     * 获取 Gemini API Key
     */
    async getGeminiApiKey(): Promise<string | null> {
        const envKey = process.env.GEMINI_API_KEY
        if (envKey) return envKey

        const tokens = await this.getApiTokens()
        return tokens.geminiApiKey || null
    }

    /**
     * 获取 MiniMax 凭证
     */
    async getMinimaxCredentials(): Promise<{ apiKey: string | null; groupId: string | null }> {
        const tokens = await this.getApiTokens()
        return {
            apiKey: process.env.MINIMAX_API_KEY || tokens.minimaxApiKey || null,
            groupId: process.env.MINIMAX_GROUP_ID || tokens.minimaxGroupId || null
        }
    }

    // ==================== VAPID Keys ====================

    /**
     * 获取 VAPID Keys
     */
    async getVapidKeys(): Promise<VapidKeysData | null> {
        if (this.vapidKeys) {
            return this.vapidKeys
        }

        // 环境变量优先
        const envPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY
        const envPrivate = process.env.WEB_PUSH_VAPID_PRIVATE_KEY
        const envSubject = process.env.WEB_PUSH_VAPID_SUBJECT

        if (envPublic && envPrivate && envSubject) {
            this.vapidKeys = {
                publicKey: envPublic,
                privateKey: envPrivate,
                subject: envSubject,
                createdAt: 0
            }
            return this.vapidKeys
        }

        const data = await this.readSecurely<VapidKeysData>(this.vapidKeysFile)
        this.vapidKeys = data
        return data
    }

    /**
     * 设置 VAPID Keys
     */
    async setVapidKeys(publicKey: string, privateKey: string, subject: string): Promise<void> {
        const data: VapidKeysData = {
            publicKey,
            privateKey,
            subject,
            createdAt: Date.now()
        }
        await this.writeSecurely(this.vapidKeysFile, data)
        this.vapidKeys = data
    }

    // ==================== Utility ====================

    /**
     * 规范化 token（去除可能的 namespace 后缀）
     */
    private normalizeToken(token: string): string {
        const colonIndex = token.indexOf(':')
        if (colonIndex > 0) {
            console.warn('[CredentialManager] Token contains namespace suffix, stripping it')
            return token.slice(0, colonIndex)
        }
        return token
    }

    /**
     * 从旧的存储位置迁移凭证
     */
    async migrateFromLegacy(dataDir: string): Promise<{ migrated: string[] }> {
        const migrated: string[] = []

        // 1. 迁移 jwt-secret.json
        const oldJwtFile = join(dataDir, 'jwt-secret.json')
        if (existsSync(oldJwtFile) && !existsSync(this.jwtSecretFile)) {
            try {
                const content = await readFile(oldJwtFile, 'utf8')
                const data = JSON.parse(content)
                await this.writeSecurely(this.jwtSecretFile, {
                    secretBase64: data.secretBase64,
                    createdAt: Date.now()
                })
                migrated.push('jwt-secret')
                console.log('[CredentialManager] Migrated JWT secret')
            } catch (e) {
                console.error('[CredentialManager] Failed to migrate JWT secret:', e)
            }
        }

        // 2. 迁移 settings.json 中的 tokens
        const settingsFile = join(dataDir, 'settings.json')
        if (existsSync(settingsFile)) {
            try {
                const content = await readFile(settingsFile, 'utf8')
                const settings = JSON.parse(content)
                const updates: Partial<ApiTokensData> = {}

                if (settings.cliApiToken) updates.cliApiToken = settings.cliApiToken
                if (settings.appId) updates.feishuAppId = settings.appId
                if (settings.appSecret) updates.feishuAppSecret = settings.appSecret
                if (settings.geminiApiKey) updates.geminiApiKey = settings.geminiApiKey

                if (Object.keys(updates).length > 0) {
                    await this.updateApiTokens(updates)
                    migrated.push('api-tokens')
                    console.log('[CredentialManager] Migrated API tokens from settings.json')
                }

                // 迁移 VAPID keys
                if (settings.webPushVapidPublicKey && settings.webPushVapidPrivateKey) {
                    await this.setVapidKeys(
                        settings.webPushVapidPublicKey,
                        settings.webPushVapidPrivateKey,
                        settings.webPushVapidSubject || ''
                    )
                    migrated.push('vapid-keys')
                    console.log('[CredentialManager] Migrated VAPID keys from settings.json')
                }
            } catch (e) {
                console.error('[CredentialManager] Failed to migrate from settings.json:', e)
            }
        }

        return { migrated }
    }

    /**
     * 获取所有凭证（用于一次性加载）
     */
    async getAllCredentials(): Promise<AllCredentials> {
        const [jwtSecret, cliApiToken, feishu, geminiKey, minimax, vapid] = await Promise.all([
            this.getJwtSecret(),
            this.getCliApiToken(),
            this.getFeishuCredentials(),
            this.getGeminiApiKey(),
            this.getMinimaxCredentials(),
            this.getVapidKeys()
        ])

        return {
            jwtSecret,
            cliApiToken,
            feishuAppId: feishu.appId,
            feishuAppSecret: feishu.appSecret,
            geminiApiKey: geminiKey,
            minimaxApiKey: minimax.apiKey,
            minimaxGroupId: minimax.groupId,
            vapidPublicKey: vapid?.publicKey || null,
            vapidPrivateKey: vapid?.privateKey || null,
            vapidSubject: vapid?.subject || null
        }
    }

    /**
     * 打印凭证状态（不显示敏感信息）
     */
    printStatus(): void {
        console.log('[CredentialManager] Credentials directory:', this.credentialsDir)
        console.log('[CredentialManager] JWT Secret:', existsSync(this.jwtSecretFile) ? '✓' : '✗')
        console.log('[CredentialManager] API Tokens:', existsSync(this.apiTokensFile) ? '✓' : '✗')
        console.log('[CredentialManager] VAPID Keys:', existsSync(this.vapidKeysFile) ? '✓' : '✗')
    }
}

// ==================== Singleton ====================

let _credentialManager: CredentialManager | null = null

/**
 * 初始化凭证管理器
 */
export async function initCredentialManager(dataDir: string): Promise<CredentialManager> {
    if (_credentialManager) {
        return _credentialManager
    }

    _credentialManager = new CredentialManager(dataDir)

    // 自动从旧位置迁移
    const { migrated } = await _credentialManager.migrateFromLegacy(dataDir)
    if (migrated.length > 0) {
        console.log(`[CredentialManager] Migrated ${migrated.length} credential(s): ${migrated.join(', ')}`)
    }

    return _credentialManager
}

/**
 * 获取凭证管理器实例
 */
export function getCredentialManager(): CredentialManager {
    if (!_credentialManager) {
        throw new Error('CredentialManager not initialized. Call initCredentialManager() first.')
    }
    return _credentialManager
}

// ==================== Helper Functions ====================

/**
 * 快捷方式：获取 JWT Secret
 */
export async function getJwtSecret(): Promise<Uint8Array> {
    return getCredentialManager().getJwtSecret()
}

/**
 * 快捷方式：获取 CLI API Token
 */
export async function getCliApiToken(): Promise<string> {
    return getCredentialManager().getCliApiToken()
}

/**
 * 快捷方式：获取 MiniMax 凭证
 */
export async function getMinimaxCredentials(): Promise<{ apiKey: string | null; groupId: string | null }> {
    return getCredentialManager().getMinimaxCredentials()
}
