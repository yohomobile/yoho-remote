/**
 * Claude Code 多账号管理 API 路由
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import {
    getAccounts,
    getActiveAccount,
    addAccount,
    updateAccount,
    removeAccount,
    setActiveAccount,
    updateAccountUsage,
    checkAndRotate,
    setAutoRotateEnabled,
    setDefaultThreshold,
    getAccountsConfig,
    migrateDefaultAccount,
    getAccountConfigDir,
    selectBestAccount,
    getAccountUsageCached,
    invalidateUsageCache,
} from '../../claude-accounts/accountsService'
import type { ClaudeAccountUsage } from '../../claude-accounts/types'

const addAccountSchema = z.object({
    name: z.string().min(1).max(100),
    configDir: z.string().optional(),
    autoRotate: z.boolean().optional(),
    usageThreshold: z.number().min(0).max(100).optional(),
    planType: z.enum(['pro', 'max']).optional(),
})

const updateAccountSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    autoRotate: z.boolean().optional(),
    usageThreshold: z.number().min(0).max(100).optional(),
    planType: z.enum(['pro', 'max']).optional(),
})

const updateUsageSchema = z.object({
    usedTokens: z.number(),
    totalTokens: z.number(),
    percentage: z.number().min(0).max(100),
})

const setConfigSchema = z.object({
    autoRotateEnabled: z.boolean().optional(),
    defaultThreshold: z.number().min(0).max(100).optional(),
})

export function createClaudeAccountsRoutes(): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // 获取完整配置（包括账号列表和全局设置）
    app.get('/claude-accounts', async (c) => {
        try {
            const config = await getAccountsConfig()
            return c.json(config)
        } catch (error) {
            console.error('[ClaudeAccounts API] Failed to get config:', error)
            return c.json({ error: 'Failed to get accounts config' }, 500)
        }
    })

    // 获取当前活跃账号
    app.get('/claude-accounts/active', async (c) => {
        try {
            const account = await getActiveAccount()
            if (!account) {
                // 尝试迁移默认账号
                const migrated = await migrateDefaultAccount()
                if (migrated) {
                    return c.json({ account: migrated })
                }
                return c.json({ account: null })
            }
            return c.json({ account })
        } catch (error) {
            console.error('[ClaudeAccounts API] Failed to get active account:', error)
            return c.json({ error: 'Failed to get active account' }, 500)
        }
    })

    // 智能选择最优账号（负载平衡，供 CLI session 启动时调用）
    app.get('/claude-accounts/select-best', async (c) => {
        try {
            const excludeConfigDir = c.req.query('excludeConfigDir')
            const selection = await selectBestAccount(excludeConfigDir)
            if (!selection) {
                // fallback: 尝试迁移默认账号
                const migrated = await migrateDefaultAccount()
                if (migrated) {
                    return c.json({ account: migrated, usage: null, reason: 'fallback_lowest', timestamp: Date.now() })
                }
                return c.json({ account: null, reason: 'no_accounts', timestamp: Date.now() })
            }

            return c.json({
                account: selection.account,
                usage: selection.usage ? {
                    fiveHour: selection.usage.fiveHour,
                    sevenDay: selection.usage.sevenDay,
                } : null,
                reason: selection.reason,
                timestamp: Date.now()
            })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to select best account:', error)
            return c.json({ error: error.message || 'Failed to select best account' }, 500)
        }
    })

    // 添加新账号
    app.post('/claude-accounts', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = addAccountSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid account data', details: parsed.error.issues }, 400)
        }

        try {
            // Generate configDir if not provided
            const accountId = parsed.data.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36)
            const configDir = parsed.data.configDir || getAccountConfigDir(accountId)
            const account = await addAccount({ ...parsed.data, configDir })
            const config = await getAccountsConfig()
            return c.json({ ok: true, account, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to add account:', error)
            return c.json({ error: error.message || 'Failed to add account' }, 400)
        }
    })

    // 更新账号配置
    app.put('/claude-accounts/:id', async (c) => {
        const id = c.req.param('id')
        const json = await c.req.json().catch(() => null)
        const parsed = updateAccountSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid account data', details: parsed.error.issues }, 400)
        }

        try {
            const account = await updateAccount(id, parsed.data)
            const config = await getAccountsConfig()
            return c.json({ ok: true, account, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to update account:', error)
            return c.json({ error: error.message || 'Failed to update account' }, 400)
        }
    })

    // 删除账号
    app.delete('/claude-accounts/:id', async (c) => {
        const id = c.req.param('id')

        try {
            await removeAccount(id)
            const config = await getAccountsConfig()
            return c.json({ ok: true, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to remove account:', error)
            return c.json({ error: error.message || 'Failed to remove account' }, 400)
        }
    })

    // 切换活跃账号
    app.post('/claude-accounts/:id/activate', async (c) => {
        const id = c.req.param('id')

        try {
            const event = await setActiveAccount(id, 'manual')
            const config = await getAccountsConfig()
            return c.json({ ok: true, event, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to activate account:', error)
            return c.json({ error: error.message || 'Failed to activate account' }, 400)
        }
    })

    // 更新账号使用量
    app.post('/claude-accounts/:id/usage', async (c) => {
        const id = c.req.param('id')
        const json = await c.req.json().catch(() => null)
        const parsed = updateUsageSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid usage data', details: parsed.error.issues }, 400)
        }

        try {
            const usage: ClaudeAccountUsage = {
                ...parsed.data,
                updatedAt: Date.now(),
            }
            await updateAccountUsage(id, usage)

            // 检查是否需要自动轮换
            const rotateEvent = await checkAndRotate()
            const config = await getAccountsConfig()

            return c.json({ ok: true, config, rotated: !!rotateEvent, rotateEvent })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to update usage:', error)
            return c.json({ error: error.message || 'Failed to update usage' }, 400)
        }
    })

    // 手动触发轮换检查
    app.post('/claude-accounts/check-rotate', async (c) => {
        try {
            const event = await checkAndRotate()
            const config = await getAccountsConfig()
            return c.json({ ok: true, rotated: !!event, event, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to check rotate:', error)
            return c.json({ error: error.message || 'Failed to check rotate' }, 400)
        }
    })

    // 更新全局配置
    app.put('/claude-accounts/config', async (c) => {
        const json = await c.req.json().catch(() => null)
        const parsed = setConfigSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid config data', details: parsed.error.issues }, 400)
        }

        try {
            if (parsed.data.autoRotateEnabled !== undefined) {
                await setAutoRotateEnabled(parsed.data.autoRotateEnabled)
            }
            if (parsed.data.defaultThreshold !== undefined) {
                await setDefaultThreshold(parsed.data.defaultThreshold)
            }

            const config = await getAccountsConfig()
            return c.json({ ok: true, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to update config:', error)
            return c.json({ error: error.message || 'Failed to update config' }, 400)
        }
    })

    // 获取添加账号的帮助信息
    app.get('/claude-accounts/setup-guide', async (c) => {
        const accountId = c.req.query('id') || `account-${Date.now().toString(36)}`
        const configDir = getAccountConfigDir(accountId)

        const guide = {
            steps: [
                {
                    step: 1,
                    title: '在终端执行登录命令',
                    command: `CLAUDE_CONFIG_DIR=${configDir} claude login`,
                    description: '使用新的 Claude Pro/Max 账号登录',
                },
                {
                    step: 2,
                    title: '完成登录',
                    description: '按提示完成浏览器中的登录流程',
                },
                {
                    step: 3,
                    title: '在此页面添加账号',
                    description: '登录成功后，填写账号名称并点击添加',
                },
            ],
            configDir,
            suggestedId: accountId,
        }

        return c.json(guide)
    })

    // 迁移默认账号
    app.post('/claude-accounts/migrate', async (c) => {
        try {
            const account = await migrateDefaultAccount()
            if (!account) {
                return c.json({ ok: false, message: 'No default account to migrate or already migrated' })
            }
            const config = await getAccountsConfig()
            return c.json({ ok: true, account, config })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to migrate:', error)
            return c.json({ error: error.message || 'Failed to migrate' }, 400)
        }
    })

    // 获取所有账号的 usage 数据（带缓存，支持 ?refresh=true 强制刷新）
    app.get('/claude-accounts/usage', async (c) => {
        try {
            const forceRefresh = c.req.query('refresh') === 'true'
            if (forceRefresh) {
                invalidateUsageCache()
            }

            const accounts = await getAccounts()
            // 串行获取，避免并发请求触发风控
            const usageResults = []
            for (const account of accounts) {
                const usage = await getAccountUsageCached(account.id, account.configDir)
                usageResults.push({
                    accountId: account.id,
                    accountName: account.name,
                    configDir: account.configDir,
                    isActive: account.isActive,
                    planType: account.planType,
                    fiveHour: usage.fiveHour,
                    sevenDay: usage.sevenDay,
                    error: usage.error,
                    cachedAt: usage.fetchedAt,
                })
            }

            return c.json({
                accounts: usageResults,
                timestamp: Date.now(),
            })
        } catch (error: any) {
            console.error('[ClaudeAccounts API] Failed to get usage:', error)
            return c.json({ error: error.message || 'Failed to get usage' }, 500)
        }
    })

    return app
}
