/**
 * License 管理 API 路由（管理员专用）
 *
 * 仅 admin org 的 owner/admin 可操作。
 * 用于给其他 org 颁发、续期、暂停、撤销 license。
 */

import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore, LicenseStatus } from '../../store'
import { getLicenseService } from '../../license/licenseService'

const upsertLicenseSchema = z.object({
    orgId: z.string().min(1),
    startsAt: z.number(),
    expiresAt: z.number(),
    maxMembers: z.number().int().min(1).default(5),
    maxConcurrentSessions: z.number().int().min(1).nullable().optional(),
    status: z.enum(['active', 'expired', 'suspended']).optional(),
    note: z.string().nullable().optional(),
})

const updateStatusSchema = z.object({
    status: z.enum(['active', 'expired', 'suspended']),
})

export function createLicensesRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    /**
     * 校验当前用户是否是 admin org 的 owner/admin
     */
    async function requireAdminOrg(email: string): Promise<{ ok: true } | { error: string; status: number }> {
        try {
            const licenseService = getLicenseService()
            const adminOrgId = licenseService.adminOrgId
            if (!adminOrgId) {
                return { error: 'No admin organization configured', status: 503 }
            }
            const role = await store.getUserOrgRole(adminOrgId, email)
            if (!role || !['owner', 'admin'].includes(role)) {
                return { error: 'Only admin organization owners/admins can manage licenses', status: 403 }
            }
            return { ok: true }
        } catch {
            return { error: 'License service not available', status: 503 }
        }
    }

    // 获取所有 license
    app.get('/licenses', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const adminCheck = await requireAdminOrg(email)
        if ('error' in adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status as any)

        const licenses = await store.getAllOrgLicenses()
        return c.json({ licenses })
    })

    // 获取可管理的组织列表（用于 license 管理面板）
    app.get('/licenses/orgs', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const adminCheck = await requireAdminOrg(email)
        if ('error' in adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status as any)

        const orgs = await store.getAllOrganizations()
        return c.json({ orgs })
    })

    // 获取指定 org 的 license
    app.get('/licenses/:orgId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const adminCheck = await requireAdminOrg(email)
        if ('error' in adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status as any)

        const orgId = c.req.param('orgId')
        const license = await store.getOrgLicense(orgId)
        if (!license) return c.json({ error: 'License not found' }, 404)

        const org = await store.getOrganization(orgId)
        return c.json({ license, org })
    })

    // 颁发或更新 license
    app.post('/licenses', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const adminCheck = await requireAdminOrg(email)
        if ('error' in adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status as any)

        const json = await c.req.json().catch(() => null)
        const parsed = upsertLicenseSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        // 验证 org 存在
        const org = await store.getOrganization(parsed.data.orgId)
        if (!org) {
            return c.json({ error: 'Organization not found' }, 404)
        }

        // 验证时间合法
        if (parsed.data.expiresAt <= parsed.data.startsAt) {
            return c.json({ error: 'expiresAt must be after startsAt' }, 400)
        }

        const license = await store.upsertOrgLicense({
            orgId: parsed.data.orgId,
            startsAt: parsed.data.startsAt,
            expiresAt: parsed.data.expiresAt,
            maxMembers: parsed.data.maxMembers,
            maxConcurrentSessions: parsed.data.maxConcurrentSessions ?? null,
            status: parsed.data.status,
            issuedBy: email,
            note: parsed.data.note ?? null,
        })

        // 清除缓存，使新 license 立即生效
        getLicenseService().invalidateCache(parsed.data.orgId)

        console.log(`[License] License issued/updated for org ${org.slug} (${org.id}) by ${email}`)
        return c.json({ ok: true, license })
    })

    // 更新 license 状态
    app.patch('/licenses/:orgId/status', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const adminCheck = await requireAdminOrg(email)
        if ('error' in adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status as any)

        const orgId = c.req.param('orgId')
        const json = await c.req.json().catch(() => null)
        const parsed = updateStatusSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data' }, 400)
        }

        const success = await store.updateOrgLicenseStatus(orgId, parsed.data.status as LicenseStatus)
        if (!success) return c.json({ error: 'License not found' }, 404)

        // 清除缓存
        getLicenseService().invalidateCache(orgId)

        console.log(`[License] License status updated for org ${orgId}: ${parsed.data.status} by ${email}`)
        return c.json({ ok: true })
    })

    // 删除 license
    app.delete('/licenses/:orgId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const adminCheck = await requireAdminOrg(email)
        if ('error' in adminCheck) return c.json({ error: adminCheck.error }, adminCheck.status as any)

        const orgId = c.req.param('orgId')
        const success = await store.deleteOrgLicense(orgId)
        if (!success) return c.json({ error: 'License not found' }, 404)

        // 清除缓存
        getLicenseService().invalidateCache(orgId)

        console.log(`[License] License deleted for org ${orgId} by ${email}`)
        return c.json({ ok: true })
    })

    return app
}
