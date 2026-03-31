import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore } from '../../store'

/**
 * CRS (Claude Relay Service) 代理路由
 * 用于在组织设置中管理 API Keys 和查询 token 用量
 */
export function createCRSProxyRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    const CRS_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://token.yohomobile.dev/api'
    const CRS_ADMIN_TOKEN = process.env.CRS_ADMIN_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN

    if (!CRS_ADMIN_TOKEN) {
        console.warn('[CRS Proxy] Warning: No CRS admin token configured')
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
     * 调用 CRS API
     */
    async function callCRS(
        method: string,
        path: string,
        body?: any
    ): Promise<Response> {
        const url = `${CRS_BASE_URL}${path}`
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        }

        if (CRS_ADMIN_TOKEN) {
            headers['Authorization'] = `Bearer ${CRS_ADMIN_TOKEN}`
        }

        const options: RequestInit = {
            method,
            headers,
        }

        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            options.body = JSON.stringify(body)
        }

        return fetch(url, options)
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
