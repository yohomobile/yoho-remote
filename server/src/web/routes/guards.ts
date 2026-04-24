import type { Context } from 'hono'
import type { Machine, Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import type { IStore } from '../../store'
import { isMachineBlocked } from './blocklist'

function getAuthorizedOrgIds(c: Context<WebAppEnv>): Set<string> {
    return new Set((c.get('orgs') ?? []).map((org) => org.id))
}

function hasOrgAccess(c: Context<WebAppEnv>, orgId: string | null | undefined): orgId is string {
    if (c.get('role') === 'operator' && typeof orgId === 'string' && orgId.length > 0) {
        return true
    }
    return typeof orgId === 'string' && orgId.length > 0 && getAuthorizedOrgIds(c).has(orgId)
}

function hasResourceOrgAccess(c: Context<WebAppEnv>, orgId: string | null | undefined): boolean {
    if (orgId === null || orgId === undefined) {
        return false
    }
    return hasOrgAccess(c, orgId)
}

export function requireRequestedOrgId(
    c: Context<WebAppEnv>,
    options?: { queryName?: string }
): string | Response {
    const queryName = options?.queryName ?? 'orgId'
    const orgId = c.req.query(queryName)?.trim()
    if (orgId) {
        if (!hasOrgAccess(c, orgId)) {
            return c.json({ error: 'Organization access denied' }, 403)
        }
        return orgId
    }
    // Auto-infer from the user's sole org so callers don't need to pass ?orgId=
    const userOrgs = c.get('orgs') ?? []
    if (userOrgs.length === 1) {
        return userOrgs[0].id
    }
    return c.json({ error: 'orgId is required' }, 400)
}

export function requireSyncEngine(
    c: Context<WebAppEnv>,
    getSyncEngine: () => SyncEngine | null
): SyncEngine | Response {
    const engine = getSyncEngine()
    if (!engine) {
        return c.json({ error: 'Not connected' }, 503)
    }
    return engine
}

export function requireSession(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    sessionId: string,
    options?: { requireActive?: boolean }
): Session | Response {
    const session = engine.getSession(sessionId)
    if (!session) {
        return c.json({ error: 'Session not found' }, 404)
    }
    if (!hasResourceOrgAccess(c, session.orgId)) {
        return c.json({ error: 'Session access denied' }, 403)
    }
    if (options?.requireActive && !session.active) {
        return c.json({ error: 'Session is inactive' }, 409)
    }
    return session
}

/**
 * 检查用户是否有权限访问指定 session（异步版本，支持 shareAllSessions 检查）
 * 对于 Keycloak 用户，还需要检查：
 * 1. 是否是自己创建的 session
 * 2. 是否被共享给自己
 * 3. session 创建者是否开启了 shareAllSessions
 */
export async function requireSessionWithShareCheck(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    store: IStore,
    sessionId: string,
    options?: { requireActive?: boolean }
): Promise<Session | Response> {
    const email = c.get('email')
    // Try memory first, then fallback to database (handles sessions not yet loaded into memory)
    const session = await engine.getOrRefreshSession(sessionId)

    if (!session) {
        return c.json({ error: 'Session not found' }, 404)
    }

    if (!hasResourceOrgAccess(c, session.orgId)) {
        return c.json({ error: 'Session access denied' }, 403)
    }

    // Web 用户还需要额外的共享权限检查
    if (email) {
        const createdBy = session.createdBy

        // 如果是自己创建的 session 或没有 createdBy，允许访问
        if (!createdBy || createdBy === email) {
            // 允许
        } else {
            // 检查是否被共享给自己
            const isShared = await store.isSessionSharedWith(sessionId, email)
            if (!isShared) {
                // 检查 session 创建者是否开启了 shareAllSessions
                const ownerShareAll = await store.getShareAllSessions(createdBy)
                if (!ownerShareAll) {
                    return c.json({ error: 'Session access denied' }, 403)
                }
            }
        }
    }

    if (options?.requireActive && !session.active) {
        return c.json({ error: 'Session is inactive' }, 409)
    }

    return session
}

export function requireSessionFromParam(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    options?: { paramName?: string; requireActive?: boolean }
): { sessionId: string; session: Session } | Response {
    const paramName = options?.paramName ?? 'id'
    const sessionId = c.req.param(paramName)
    const session = requireSession(c, engine, sessionId, { requireActive: options?.requireActive })
    if (session instanceof Response) {
        return session
    }
    return { sessionId, session }
}

/**
 * 异步版本的 requireSessionFromParam，支持 shareAllSessions 检查
 */
export async function requireSessionFromParamWithShareCheck(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    store: IStore,
    options?: { paramName?: string; requireActive?: boolean }
): Promise<{ sessionId: string; session: Session } | Response> {
    const paramName = options?.paramName ?? 'id'
    const sessionId = c.req.param(paramName)
    const session = await requireSessionWithShareCheck(c, engine, store, sessionId, { requireActive: options?.requireActive })
    if (session instanceof Response) {
        return session
    }
    return { sessionId, session }
}

export function requireMachine(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    machineId: string
): Machine | Response {
    const machine = engine.getMachine(machineId)
    if (!machine) {
        return c.json({ error: 'Machine not found' }, 404)
    }
    if (!hasResourceOrgAccess(c, machine.orgId)) {
        return c.json({ error: 'Machine access denied' }, 403)
    }
    if (isMachineBlocked(machine)) {
        return c.json({ error: 'Machine is temporarily unavailable' }, 403)
    }
    return machine
}

export function requireMachineInOrg(
    c: Context<WebAppEnv>,
    engine: SyncEngine,
    machineId: string,
    orgId: string
): Machine | Response {
    const machine = requireMachine(c, engine, machineId)
    if (machine instanceof Response) {
        return machine
    }
    if (machine.orgId !== orgId) {
        return c.json({ error: 'Machine access denied' }, 403)
    }
    return machine
}
