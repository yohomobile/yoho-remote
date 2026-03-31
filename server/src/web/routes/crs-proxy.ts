import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore } from '../../store'

/**
 * CRS (Claude Relay Service) 代理路由
 * 用于在组织设置中管理 API Keys 和查询 token 用量
 */
export function createCRSProxyRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const CRS_BASE_URL = process.env.CRS_BASE_URL || 'https://token.yohomobile.dev'
    const CRS_USERNAME = process.env.CRS_ADMIN_USERNAME
    const CRS_PASSWORD = process.env.CRS_ADMIN_PASSWORD

    // token 缓存：自动登录获取，过期后重新登录
    let cachedToken: string | null = process.env.CRS_ADMIN_TOKEN || null
    let tokenExpiresAt = 0 // 0 表示不知道过期时间，第一次 401 时会触发重新登录

    /**
     * 通过用户名密码登录 CRS 获取 session token
     */
    async function loginCRS(): Promise<string | null> {
        if (!CRS_USERNAME || !CRS_PASSWORD) {
            console.error('[CRS Proxy] Cannot auto-login: CRS_ADMIN_USERNAME or CRS_ADMIN_PASSWORD not configured')
            return null
        }

        try {
            const resp = await fetch(`${CRS_BASE_URL}/web/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: CRS_USERNAME, password: CRS_PASSWORD }),
            })

            if (!resp.ok) {
                console.error('[CRS Proxy] Login failed:', await resp.text())
                return null
            }

            const data = await resp.json() as { success: boolean; token: string; expiresIn: number }
            if (data.success && data.token) {
                cachedToken = data.token
                // 提前 5 分钟过期，避免边界情况
                tokenExpiresAt = Date.now() + data.expiresIn - 5 * 60 * 1000
                console.log('[CRS Proxy] Auto-login successful, token refreshed')
                return data.token
            }

            console.error('[CRS Proxy] Login response unexpected:', data)
            return null
        } catch (err) {
            console.error('[CRS Proxy] Login error:', err)
            return null
        }
    }

    /**
     * 获取有效的 admin token（自动刷新）
     */
    async function getToken(): Promise<string | null> {
        if (cachedToken && tokenExpiresAt > 0 && Date.now() < tokenExpiresAt) {
            return cachedToken
        }
        // token 过期或未知过期时间，尝试重新登录
        if (CRS_USERNAME && CRS_PASSWORD) {
            return loginCRS()
        }
        return cachedToken
    }

    /**
     * 权限守卫：检查当前用户是否为组织 owner
     */
    async function requireOrgOwner(
        store: IStore,
        orgId: string,
        email: string
    ): Promise<boolean | { error: string; status: number }> {
        const role = await store.getUserOrgRole(orgId, email)
        if (role !== 'owner') {
            return { error: 'Only organization owners can manage API keys', status: 403 }
        }
        return true
    }

    /**
     * 调用 CRS API（带 401 自动重试）
     */
    async function callCRS(
        method: string,
        path: string,
        body?: any
    ): Promise<Response> {
        const token = await getToken()

        const doFetch = (t: string | null) => {
            const url = `${CRS_BASE_URL}${path}`
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            }
            if (t) {
                headers['Authorization'] = `Bearer ${t}`
            }
            const options: RequestInit = { method, headers }
            if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
                options.body = JSON.stringify(body)
            }
            return fetch(url, options)
        }

        const resp = await doFetch(token)

        // 401 时尝试重新登录并重试一次
        if (resp.status === 401 && CRS_USERNAME && CRS_PASSWORD) {
            console.log('[CRS Proxy] Got 401, attempting token refresh...')
            const newToken = await loginCRS()
            if (newToken) {
                return doFetch(newToken)
            }
        }

        return resp
    }

    // ==================== API Keys 管理 ====================

    /**
     * 获取组织的 API Keys
     * GET /orgs/:orgId/crs/api-keys
     */
    app.get('/orgs/:orgId/crs/api-keys', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const permCheck = await requireOrgOwner(store, orgId, email)
        if (typeof permCheck === 'object') {
            return c.json({ error: permCheck.error }, permCheck.status)
        }

        // 获取组织信息
        const org = await store.getOrganization(orgId)
        if (!org) return c.json({ error: 'Organization not found' }, 404)

        // 使用 org slug 作为 tag 筛选
        const tag = `org:${org.slug}`
        const page = c.req.query('page') || '1'
        const pageSize = c.req.query('pageSize') || '20'

        try {
            const response = await callCRS(
                'GET',
                `/admin/api-keys?tag=${encodeURIComponent(tag)}&page=${page}&pageSize=${pageSize}`
            )

            if (!response.ok) {
                const error = await response.text()
                console.error('[CRS Proxy] Failed to fetch API keys:', error)
                return c.json({ error: 'Failed to fetch API keys from CRS' }, response.status)
            }

            const data = await response.json()
            return c.json(data)
        } catch (error) {
            console.error('[CRS Proxy] Error fetching API keys:', error)
            return c.json({ error: 'Internal server error' }, 500)
        }
    })

    /**
     * 创建 API Key
     * POST /orgs/:orgId/crs/api-keys
     */
    app.post('/orgs/:orgId/crs/api-keys', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const permCheck = await requireOrgOwner(store, orgId, email)
        if (typeof permCheck === 'object') {
            return c.json({ error: permCheck.error }, permCheck.status)
        }

        // 获取组织信息
        const org = await store.getOrganization(orgId)
        if (!org) return c.json({ error: 'Organization not found' }, 404)

        const body = await c.req.json()
        const tag = `org:${org.slug}`

        // 在 tags 中添加组织标识
        const tags = body.tags || []
        if (!tags.includes(tag)) {
            tags.push(tag)
        }

        try {
            const response = await callCRS('POST', '/admin/api-keys', {
                ...body,
                tags,
            })

            if (!response.ok) {
                const error = await response.text()
                console.error('[CRS Proxy] Failed to create API key:', error)
                return c.json({ error: 'Failed to create API key' }, response.status)
            }

            const data = await response.json()
            return c.json(data)
        } catch (error) {
            console.error('[CRS Proxy] Error creating API key:', error)
            return c.json({ error: 'Internal server error' }, 500)
        }
    })

    /**
     * 更新 API Key
     * PUT /orgs/:orgId/crs/api-keys/:keyId
     */
    app.put('/orgs/:orgId/crs/api-keys/:keyId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const permCheck = await requireOrgOwner(store, orgId, email)
        if (typeof permCheck === 'object') {
            return c.json({ error: permCheck.error }, permCheck.status)
        }

        const keyId = c.req.param('keyId')
        const body = await c.req.json()

        try {
            const response = await callCRS('PUT', `/admin/api-keys/${keyId}`, body)

            if (!response.ok) {
                const error = await response.text()
                console.error('[CRS Proxy] Failed to update API key:', error)
                return c.json({ error: 'Failed to update API key' }, response.status)
            }

            const data = await response.json()
            return c.json(data)
        } catch (error) {
            console.error('[CRS Proxy] Error updating API key:', error)
            return c.json({ error: 'Internal server error' }, 500)
        }
    })

    /**
     * 删除 API Key
     * DELETE /orgs/:orgId/crs/api-keys/:keyId
     */
    app.delete('/orgs/:orgId/crs/api-keys/:keyId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const permCheck = await requireOrgOwner(store, orgId, email)
        if (typeof permCheck === 'object') {
            return c.json({ error: permCheck.error }, permCheck.status)
        }

        const keyId = c.req.param('keyId')

        try {
            const response = await callCRS('DELETE', `/admin/api-keys/${keyId}`)

            if (!response.ok) {
                const error = await response.text()
                console.error('[CRS Proxy] Failed to delete API key:', error)
                return c.json({ error: 'Failed to delete API key' }, response.status)
            }

            const data = await response.json()
            return c.json(data)
        } catch (error) {
            console.error('[CRS Proxy] Error deleting API key:', error)
            return c.json({ error: 'Internal server error' }, 500)
        }
    })

    // ==================== 用量统计 ====================

    /**
     * 批量获取 API Keys 统计
     * POST /orgs/:orgId/crs/api-keys/batch-stats
     */
    app.post('/orgs/:orgId/crs/api-keys/batch-stats', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const permCheck = await requireOrgOwner(store, orgId, email)
        if (typeof permCheck === 'object') {
            return c.json({ error: permCheck.error }, permCheck.status)
        }

        const body = await c.req.json()

        try {
            const response = await callCRS('POST', '/admin/api-keys/batch-stats', body)

            if (!response.ok) {
                const error = await response.text()
                console.error('[CRS Proxy] Failed to fetch batch stats:', error)
                return c.json({ error: 'Failed to fetch batch stats' }, response.status)
            }

            const data = await response.json()
            return c.json(data)
        } catch (error) {
            console.error('[CRS Proxy] Error fetching batch stats:', error)
            return c.json({ error: 'Internal server error' }, 500)
        }
    })

    /**
     * 获取组织的总用量统计
     * GET /orgs/:orgId/crs/usage-summary
     */
    app.get('/orgs/:orgId/crs/usage-summary', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const permCheck = await requireOrgOwner(store, orgId, email)
        if (typeof permCheck === 'object') {
            return c.json({ error: permCheck.error }, permCheck.status)
        }

        // 获取组织信息
        const org = await store.getOrganization(orgId)
        if (!org) return c.json({ error: 'Organization not found' }, 404)

        const tag = `org:${org.slug}`
        const timeRange = c.req.query('timeRange') || '7days'

        try {
            // 先获取该组织的所有 API Keys
            const keysResponse = await callCRS(
                'GET',
                `/admin/api-keys?tag=${encodeURIComponent(tag)}&pageSize=100`
            )

            if (!keysResponse.ok) {
                const error = await keysResponse.text()
                console.error('[CRS Proxy] Failed to fetch API keys:', error)
                return c.json({ error: 'Failed to fetch API keys' }, keysResponse.status)
            }

            const keysData = await keysResponse.json()
            const keyIds = keysData.data?.items?.map((key: any) => key.id) || []

            if (keyIds.length === 0) {
                return c.json({
                    success: true,
                    data: {
                        totalKeys: 0,
                        totalRequests: 0,
                        totalTokens: 0,
                        totalCost: 0,
                        formattedCost: '$0.00',
                    },
                })
            }

            // 批量获取统计
            const statsResponse = await callCRS('POST', '/admin/api-keys/batch-stats', {
                keyIds,
                timeRange,
            })

            if (!statsResponse.ok) {
                const error = await statsResponse.text()
                console.error('[CRS Proxy] Failed to fetch batch stats:', error)
                return c.json({ error: 'Failed to fetch batch stats' }, statsResponse.status)
            }

            const statsData = await statsResponse.json()
            const stats = statsData.data || {}

            // 汇总统计
            let totalRequests = 0
            let totalTokens = 0
            let totalCost = 0

            Object.values(stats).forEach((stat: any) => {
                totalRequests += stat.requests || 0
                totalTokens += stat.tokens || 0
                totalCost += stat.cost || 0
            })

            return c.json({
                success: true,
                data: {
                    totalKeys: keyIds.length,
                    totalRequests,
                    totalTokens,
                    totalCost,
                    formattedCost: `$${totalCost.toFixed(2)}`,
                    timeRange,
                },
            })
        } catch (error) {
            console.error('[CRS Proxy] Error fetching usage summary:', error)
            return c.json({ error: 'Internal server error' }, 500)
        }
    })

    return app
}
