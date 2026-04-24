#!/usr/bin/env bun
/**
 * 凭证迁移脚本
 *
 * 将现有的凭证从各个位置迁移到统一的 credentials 目录
 */

import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const YOHO_REMOTE_HOME = process.env.YOHO_REMOTE_HOME || join(homedir(), '.yoho-remote')
const CREDENTIALS_DIR = join(YOHO_REMOTE_HOME, 'credentials')

interface MigrationResult {
    source: string
    target: string
    success: boolean
    error?: string
}

async function ensureDir(dir: string): Promise<void> {
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true, mode: 0o700 })
    }
}

async function writeSecurely(filePath: string, data: object): Promise<void> {
    await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
    await chmod(filePath, 0o600).catch(() => {})
}

async function migrateJwtSecret(): Promise<MigrationResult> {
    const source = join(YOHO_REMOTE_HOME, 'jwt-secret.json')
    const target = join(CREDENTIALS_DIR, 'jwt-secret.json')

    if (existsSync(target)) {
        return { source, target, success: true, error: 'Already exists' }
    }

    if (!existsSync(source)) {
        return { source, target, success: false, error: 'Source not found' }
    }

    try {
        const content = await readFile(source, 'utf8')
        const data = JSON.parse(content)
        await writeSecurely(target, {
            secretBase64: data.secretBase64,
            createdAt: Date.now(),
            migratedFrom: source
        })
        return { source, target, success: true }
    } catch (e) {
        return { source, target, success: false, error: String(e) }
    }
}

async function migrateApiTokens(): Promise<MigrationResult> {
    const source = join(YOHO_REMOTE_HOME, 'settings.json')
    const target = join(CREDENTIALS_DIR, 'api-tokens.json')

    if (existsSync(target)) {
        return { source, target, success: true, error: 'Already exists' }
    }

    if (!existsSync(source)) {
        return { source, target, success: false, error: 'Source not found' }
    }

    try {
        const content = await readFile(source, 'utf8')
        const settings = JSON.parse(content)

        const tokens: Record<string, unknown> = {
            updatedAt: Date.now(),
            migratedFrom: source
        }

        // 迁移各类 token
        if (settings.cliApiToken) tokens.cliApiToken = settings.cliApiToken
        if (settings.appId) tokens.feishuAppId = settings.appId
        if (settings.appSecret) tokens.feishuAppSecret = settings.appSecret
        if (settings.geminiApiKey) tokens.geminiApiKey = settings.geminiApiKey

        await writeSecurely(target, tokens)
        return { source, target, success: true }
    } catch (e) {
        return { source, target, success: false, error: String(e) }
    }
}

async function migrateVapidKeys(): Promise<MigrationResult> {
    const source = join(YOHO_REMOTE_HOME, 'settings.json')
    const target = join(CREDENTIALS_DIR, 'vapid-keys.json')

    if (existsSync(target)) {
        return { source, target, success: true, error: 'Already exists' }
    }

    if (!existsSync(source)) {
        return { source, target, success: false, error: 'Source not found' }
    }

    try {
        const content = await readFile(source, 'utf8')
        const settings = JSON.parse(content)

        if (!settings.webPushVapidPublicKey || !settings.webPushVapidPrivateKey) {
            return { source, target, success: false, error: 'No VAPID keys in settings' }
        }

        await writeSecurely(target, {
            publicKey: settings.webPushVapidPublicKey,
            privateKey: settings.webPushVapidPrivateKey,
            subject: settings.webPushVapidSubject || '',
            createdAt: Date.now(),
            migratedFrom: source
        })
        return { source, target, success: true }
    } catch (e) {
        return { source, target, success: false, error: String(e) }
    }
}

async function main() {
    console.log('🔐 Yoho Remote Credentials Migration')
    console.log('=============================')
    console.log(`YOHO_REMOTE_HOME: ${YOHO_REMOTE_HOME}`)
    console.log(`Target: ${CREDENTIALS_DIR}`)
    console.log('')

    await ensureDir(CREDENTIALS_DIR)

    const results: MigrationResult[] = []

    console.log('Migrating JWT Secret...')
    results.push(await migrateJwtSecret())

    console.log('Migrating API Tokens...')
    results.push(await migrateApiTokens())

    console.log('Migrating VAPID Keys...')
    results.push(await migrateVapidKeys())

    console.log('')
    console.log('Results:')
    console.log('--------')

    for (const result of results) {
        const status = result.success ? '✅' : '❌'
        const target = result.target.replace(YOHO_REMOTE_HOME, '~/.yoho-remote')
        console.log(`${status} ${target}`)
        if (result.error) {
            console.log(`   ${result.error}`)
        }
    }

    console.log('')
    console.log('Files in credentials directory:')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(CREDENTIALS_DIR)
    for (const file of files) {
        console.log(`  - ${file}`)
    }
}

main().catch(console.error)
