import { Hono } from 'hono'
import { z } from 'zod'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore, OrgRole } from '../../store'
import { emailService } from '../../services/emailService'
import { getLicenseService } from '../../license/licenseService'

const createOrgSchema = z.object({
    name: z.string().min(1).max(100),
    slug: z.string().min(2).max(50).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens'),
})

const updateOrgSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
})

const inviteMemberSchema = z.object({
    email: z.string().email(),
    role: z.enum(['admin', 'member']).default('member'),
})

const updateMemberRoleSchema = z.object({
    role: z.enum(['owner', 'admin', 'member']),
})

const validOrgRoles: OrgRole[] = ['owner', 'admin', 'member']

/**
 * 权限守卫：检查当前用户在指定 org 中的角色
 */
async function requireOrgRole(
    store: IStore,
    orgId: string,
    email: string,
    minimumRoles: OrgRole[]
): Promise<{ role: OrgRole } | { error: string; status: 403 | 404 }> {
    const role = await store.getUserOrgRole(orgId, email)
    if (!role) {
        return { error: 'Not a member of this organization', status: 403 }
    }
    if (!minimumRoles.includes(role)) {
        return { error: 'Insufficient permissions', status: 403 }
    }
    return { role }
}

export function createOrgsRoutes(store: IStore): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    // ==================== 组织 CRUD ====================

    // 创建组织
    app.post('/orgs', async (c) => {
        const email = c.get('email')
        const userId = c.get('userId')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const json = await c.req.json().catch(() => null)
        const parsed = createOrgSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data', details: parsed.error.flatten() }, 400)
        }

        // 检查 slug 是否已存在
        const existing = await store.getOrganizationBySlug(parsed.data.slug)
        if (existing) {
            return c.json({ error: 'Organization slug already exists' }, 409)
        }

        const org = await store.createOrganization({
            name: parsed.data.name,
            slug: parsed.data.slug,
            createdBy: email,
        })
        if (!org) {
            return c.json({ error: 'Failed to create organization' }, 500)
        }

        // 创建者自动成为 owner
        await store.addOrgMember({
            orgId: org.id,
            userEmail: email,
            userId,
            role: 'owner',
        })

        return c.json({ ok: true, org })
    })

    // 获取我的组织列表
    app.get('/orgs', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgs = await store.getOrganizationsForUser(email)
        return c.json({ orgs })
    })

    // 获取组织详情
    app.get('/orgs/:orgId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const org = await store.getOrganization(orgId)
        if (!org) return c.json({ error: 'Organization not found' }, 404)

        const roleCheck = await requireOrgRole(store, orgId, email, validOrgRoles)
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const members = await store.getOrgMembers(orgId)
        const licenseService = getLicenseService()
        const licenseExempt = licenseService.isAdminOrg(orgId)
        const license = await store.getOrgLicense(orgId)
        return c.json({ org, members, myRole: roleCheck.role, license, licenseExempt })
    })

    // 更新组织
    app.patch('/orgs/:orgId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const roleCheck = await requireOrgRole(store, orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const json = await c.req.json().catch(() => null)
        const parsed = updateOrgSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data' }, 400)
        }

        const org = await store.updateOrganization(orgId, parsed.data)
        if (!org) return c.json({ error: 'Organization not found' }, 404)

        return c.json({ ok: true, org })
    })

    // 删除组织
    app.delete('/orgs/:orgId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const roleCheck = await requireOrgRole(store, orgId, email, ['owner'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        await store.deleteOrganization(orgId)
        return c.json({ ok: true })
    })

    // ==================== 成员管理 ====================

    // 获取成员列表
    app.get('/orgs/:orgId/members', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const roleCheck = await requireOrgRole(store, orgId, email, validOrgRoles)
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const members = await store.getOrgMembers(orgId)
        return c.json({ members })
    })

    // 添加成员（直接添加，无需邀请流程）
    app.post('/orgs/:orgId/members', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const roleCheck = await requireOrgRole(store, orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const json = await c.req.json().catch(() => null)
        const parsed = inviteMemberSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data' }, 400)
        }

        // admin 不能添加 owner 或 admin
        if (roleCheck.role === 'admin' && parsed.data.role === 'admin') {
            return c.json({ error: 'Only owner can add admins' }, 403)
        }

        // 检查是否已经是成员
        const existing = await store.getOrgMember(orgId, parsed.data.email)
        if (existing) {
            return c.json({ error: 'User is already a member' }, 409)
        }

        // License: 检查成员数上限
        try {
            const licenseService = getLicenseService()
            const memberCheck = await licenseService.canAddMember(orgId)
            if (!memberCheck.valid) {
                return c.json({ error: memberCheck.message, code: memberCheck.code }, 403)
            }
        } catch { /* LicenseService not initialized */ }

        // 发送邀请（7 天有效期）
        const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
        const invitation = await store.createOrgInvitation({
            orgId,
            email: parsed.data.email,
            role: parsed.data.role as OrgRole,
            invitedBy: email,
            expiresAt,
        })

        if (!invitation) {
            return c.json({ error: 'Failed to create invitation' }, 500)
        }

        // 获取组织详情用于邮件
        const org = await store.getOrganization(orgId)
        if (!org) {
            return c.json({ error: 'Organization not found' }, 404)
        }

        // 发送邀请邮件
        try {
            await emailService.sendOrgInvitation({
                to: parsed.data.email,
                orgName: org.name,
                orgSlug: org.slug,
                inviterEmail: email,
                invitationId: invitation.id,
                role: parsed.data.role,
                expiresAt,
            })
            console.log('[Email] Invitation email sent successfully:', {
                to: parsed.data.email,
                orgName: org.name,
                invitationId: invitation.id,
            })
        } catch (error) {
            console.error('[Email] Failed to send invitation email:', {
                to: parsed.data.email,
                orgName: org.name,
                orgSlug: org.slug,
                invitationId: invitation.id,
                role: parsed.data.role,
                error: error instanceof Error ? {
                    message: error.message,
                    stack: error.stack,
                } : error,
            })
            // 邮件发送失败不影响邀请创建，继续返回成功
        }

        return c.json({ ok: true, invitation })
    })

    // 修改成员角色
    app.patch('/orgs/:orgId/members/:email', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const targetEmail = decodeURIComponent(c.req.param('email'))

        const roleCheck = await requireOrgRole(store, orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const json = await c.req.json().catch(() => null)
        const parsed = updateMemberRoleSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid data' }, 400)
        }

        // 不能修改自己的角色
        if (targetEmail === email) {
            return c.json({ error: 'Cannot change your own role' }, 400)
        }

        // 只有 owner 才能设置 owner 或 admin 角色
        if (roleCheck.role !== 'owner' && (parsed.data.role === 'owner' || parsed.data.role === 'admin')) {
            return c.json({ error: 'Only owner can set owner/admin roles' }, 403)
        }

        // 不能修改其他 owner 的角色（除非自己也是 owner）
        const targetRole = await store.getUserOrgRole(orgId, targetEmail)
        if (targetRole === 'owner' && roleCheck.role !== 'owner') {
            return c.json({ error: 'Cannot modify owner role' }, 403)
        }

        const success = await store.updateOrgMemberRole(orgId, targetEmail, parsed.data.role)
        if (!success) return c.json({ error: 'Member not found' }, 404)

        return c.json({ ok: true })
    })

    // 移除成员
    app.delete('/orgs/:orgId/members/:email', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const targetEmail = decodeURIComponent(c.req.param('email'))

        // 允许成员自行退出
        if (targetEmail === email) {
            const myRole = await store.getUserOrgRole(orgId, email)
            if (myRole === 'owner') {
                // owner 不能退出，需要先转让
                const members = await store.getOrgMembers(orgId)
                const owners = members.filter(m => m.role === 'owner')
                if (owners.length <= 1) {
                    return c.json({ error: 'Cannot leave: you are the only owner. Transfer ownership first.' }, 400)
                }
            }
            await store.removeOrgMember(orgId, email)
            return c.json({ ok: true })
        }

        // 非自行退出，需要 owner/admin 权限
        const roleCheck = await requireOrgRole(store, orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        // admin 不能移除 owner 或其他 admin
        const targetRole = await store.getUserOrgRole(orgId, targetEmail)
        if (roleCheck.role === 'admin' && (targetRole === 'owner' || targetRole === 'admin')) {
            return c.json({ error: 'Insufficient permissions to remove this member' }, 403)
        }

        const success = await store.removeOrgMember(orgId, targetEmail)
        if (!success) return c.json({ error: 'Member not found' }, 404)

        return c.json({ ok: true })
    })

    // ==================== 邀请管理 ====================

    // 获取组织的邀请列表
    app.get('/orgs/:orgId/invitations', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const roleCheck = await requireOrgRole(store, orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const invitations = await store.getOrgInvitations(orgId)
        return c.json({ invitations })
    })

    // 撤销邀请
    app.delete('/orgs/:orgId/invitations/:invitationId', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const orgId = c.req.param('orgId')
        const roleCheck = await requireOrgRole(store, orgId, email, ['owner', 'admin'])
        if ('error' in roleCheck) return c.json({ error: roleCheck.error }, roleCheck.status)

        const invitationId = c.req.param('invitationId')
        const success = await store.deleteOrgInvitation(invitationId, orgId)
        if (!success) return c.json({ error: 'Invitation not found' }, 404)

        return c.json({ ok: true })
    })

    // 获取我的待处理邀请
    app.get('/invitations/pending', async (c) => {
        const email = c.get('email')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const invitations = await store.getPendingInvitationsForUser(email)
        return c.json({ invitations })
    })

    // 接受邀请
    app.post('/invitations/:invitationId/accept', async (c) => {
        const email = c.get('email')
        const userId = c.get('userId')
        if (!email) return c.json({ error: 'Unauthorized' }, 401)

        const invitationId = c.req.param('invitationId')

        // License: 通过 pending invitations 获取 orgId，检查成员数上限
        try {
            const licenseService = getLicenseService()
            const pendingInvitations = await store.getPendingInvitationsForUser(email)
            const invitation = pendingInvitations.find(inv => inv.id === invitationId)
            if (invitation) {
                const memberCheck = await licenseService.canAddMember(invitation.orgId)
                if (!memberCheck.valid) {
                    return c.json({ error: memberCheck.message, code: memberCheck.code }, 403)
                }
            }
        } catch { /* LicenseService not initialized */ }

        const success = await store.acceptOrgInvitation(invitationId, userId, email)
        if (!success) {
            return c.json({ error: 'Invitation not found, expired, or already accepted' }, 404)
        }

        return c.json({ ok: true })
    })

    return app
}
