import type { SyncEvent, OnlineUser } from '../sync/syncEngine'

export type SSESubscription = {
    id: string
    orgId: string
    all: boolean
    sessionId: string | null
    machineId: string | null
    email?: string
    clientId?: string
    deviceType?: string
    groupId?: string  // 订阅的群组 ID
}

type SSEConnection = SSESubscription & {
    send: (event: SyncEvent) => void | Promise<void>
    sendHeartbeat: () => void | Promise<void>
}

export class SSEManager {
    private readonly connections: Map<string, SSEConnection> = new Map()
    private heartbeatTimer: NodeJS.Timeout | null = null
    private readonly heartbeatMs: number
    // Debounce online-users broadcasts per org. Reconnect storms (server restart,
    // Wi-Fi flap, PWA resume) would otherwise fan out N subscribe/unsubscribe
    // events into N broadcasts to every connection in the org.
    private readonly onlineUsersBroadcastTimers: Map<string, NodeJS.Timeout> = new Map()
    private readonly onlineUsersBroadcastDebounceMs: number
    // viewer-changed:per (orgId, sessionId) debounce,语义同 onlineUsers
    private readonly viewerBroadcastTimers: Map<string, NodeJS.Timeout> = new Map()

    constructor(heartbeatMs = 30_000, onlineUsersBroadcastDebounceMs = 500) {
        this.heartbeatMs = heartbeatMs
        this.onlineUsersBroadcastDebounceMs = onlineUsersBroadcastDebounceMs
    }

    subscribe(options: {
        id: string
        orgId: string
        all?: boolean
        sessionId?: string | null
        machineId?: string | null
        email?: string
        clientId?: string
        deviceType?: string
        groupId?: string
        send: (event: SyncEvent) => void | Promise<void>
        sendHeartbeat: () => void | Promise<void>
    }): SSESubscription {
        const subscription: SSEConnection = {
            id: options.id,
            orgId: options.orgId,
            all: Boolean(options.all),
            sessionId: options.sessionId ?? null,
            machineId: options.machineId ?? null,
            email: options.email,
            clientId: options.clientId,
            deviceType: options.deviceType,
            groupId: options.groupId,
            send: options.send,
            sendHeartbeat: options.sendHeartbeat
        }

        this.connections.set(subscription.id, subscription)
        this.ensureHeartbeat()

        // 广播在线用户更新（debounced）
        this.scheduleOnlineUsersBroadcast(options.orgId)

        // 如果订阅了具体 session,该 session 的 viewers 改变需要广播
        if (subscription.sessionId) {
            this.scheduleViewerBroadcast(options.orgId, subscription.sessionId)
        }

        return {
            id: subscription.id,
            orgId: subscription.orgId,
            all: subscription.all,
            sessionId: subscription.sessionId,
            machineId: subscription.machineId,
            email: subscription.email,
            clientId: subscription.clientId,
            deviceType: subscription.deviceType,
            groupId: subscription.groupId
        }
    }

    unsubscribe(id: string): void {
        const connection = this.connections.get(id)
        const orgId = connection?.orgId
        const sessionId = connection?.sessionId
        this.connections.delete(id)
        if (this.connections.size === 0) {
            this.stopHeartbeat()
        }
        // 广播在线用户更新（debounced）
        if (orgId) {
            this.scheduleOnlineUsersBroadcast(orgId)
            if (sessionId) {
                this.scheduleViewerBroadcast(orgId, sessionId)
            }
        }
    }

    broadcast(event: SyncEvent): void {
        for (const connection of this.connections.values()) {
            if (!this.shouldSend(connection, event)) {
                continue
            }

            try {
                void Promise.resolve(connection.send(event)).catch(() => {
                    this.unsubscribe(connection.id)
                })
            } catch {
                this.unsubscribe(connection.id)
            }
        }
    }

    stop(): void {
        this.stopHeartbeat()
        for (const timer of this.onlineUsersBroadcastTimers.values()) {
            clearTimeout(timer)
        }
        this.onlineUsersBroadcastTimers.clear()
        for (const timer of this.viewerBroadcastTimers.values()) {
            clearTimeout(timer)
        }
        this.viewerBroadcastTimers.clear()
        this.connections.clear()
    }

    private scheduleOnlineUsersBroadcast(orgId: string): void {
        const existing = this.onlineUsersBroadcastTimers.get(orgId)
        if (existing) {
            clearTimeout(existing)
        }

        if (this.onlineUsersBroadcastDebounceMs <= 0) {
            this.onlineUsersBroadcastTimers.delete(orgId)
            this.broadcastOnlineUsers(orgId)
            return
        }

        const timer = setTimeout(() => {
            this.onlineUsersBroadcastTimers.delete(orgId)
            this.broadcastOnlineUsers(orgId)
        }, this.onlineUsersBroadcastDebounceMs)
        this.onlineUsersBroadcastTimers.set(orgId, timer)
    }

    private scheduleViewerBroadcast(orgId: string, sessionId: string): void {
        const key = `${orgId}::${sessionId}`
        const existing = this.viewerBroadcastTimers.get(key)
        if (existing) {
            clearTimeout(existing)
        }

        if (this.onlineUsersBroadcastDebounceMs <= 0) {
            this.viewerBroadcastTimers.delete(key)
            this.broadcastSessionViewers(orgId, sessionId)
            return
        }

        const timer = setTimeout(() => {
            this.viewerBroadcastTimers.delete(key)
            this.broadcastSessionViewers(orgId, sessionId)
        }, this.onlineUsersBroadcastDebounceMs)
        this.viewerBroadcastTimers.set(key, timer)
    }

    private broadcastSessionViewers(orgId: string, sessionId: string): void {
        const viewers = this.getSessionViewers(orgId, sessionId)
        const event: SyncEvent = {
            type: 'viewer-changed',
            orgId,
            sessionId,
            viewers,
        }
        this.broadcast(event)
    }

    private ensureHeartbeat(): void {
        if (this.heartbeatTimer || this.heartbeatMs <= 0) {
            return
        }

        this.heartbeatTimer = setInterval(() => {
            for (const connection of this.connections.values()) {
                void Promise.resolve(connection.sendHeartbeat()).catch(() => {
                    this.unsubscribe(connection.id)
                })
            }
        }, this.heartbeatMs)
    }

    private stopHeartbeat(): void {
        if (!this.heartbeatTimer) {
            return
        }

        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
    }

    private shouldSend(connection: SSEConnection, event: SyncEvent): boolean {
        if (event.type !== 'connection-changed') {
            const eventOrgId =
                event.orgId
                ?? (typeof event.namespace === 'string' ? event.namespace : undefined)
            if (!eventOrgId || eventOrgId !== connection.orgId) {
                return false
            }
        }

        if (event.type === 'message-received' || event.type === 'messages-cleared') {
            if (connection.all && !connection.sessionId) {
                return true
            }
            return Boolean(event.sessionId && connection.sessionId === event.sessionId)
        }

        // typing-changed 事件：发送给同一 session 的其他用户（排除发送者自己）
        if (event.type === 'typing-changed') {
            if (!event.sessionId || connection.sessionId !== event.sessionId) {
                return false
            }
            // 排除发送者自己
            const typing = event.typing as { clientId?: string } | undefined
            if (typing?.clientId && connection.clientId === typing.clientId) {
                return false
            }
            return true
        }

        if (event.type === 'connection-changed') {
            return true
        }

        // 任务完成通知（wasThinking: true）：需要严格过滤
        if (event.type === 'session-updated') {
            if (event.notifyRecipientClientIds !== undefined) {
                if (event.sessionId && connection.sessionId === event.sessionId) {
                    return true
                }
                if (!connection.clientId) {
                    return false
                }
                return event.notifyRecipientClientIds.includes(connection.clientId)
            }
            const data = event.data as { wasThinking?: boolean } | undefined
            if (data?.wasThinking) {
                // 如果连接正在查看这个 session，允许发送（用于更新 UI 状态）
                if (event.sessionId && connection.sessionId === event.sessionId) {
                    return true
                }
                // 没有 notifyRecipientClientIds 时（如获取订阅者失败），不广播给 all:true 订阅。
                // 只发给正在查看该 session 的用户（上面已处理）。
                return false
            }
        }

        if (connection.all) {
            return true
        }

        if (event.sessionId && connection.sessionId === event.sessionId) {
            return true
        }

        if (event.machineId && connection.machineId === event.machineId) {
            return true
        }

        return false
    }

    /**
     * 获取指定 org 的所有在线用户
     */
    getOnlineUsers(orgId: string): OnlineUser[] {
        const usersMap = new Map<string, OnlineUser>()  // 用 clientId 去重

        for (const conn of this.connections.values()) {
            if (conn.orgId !== orgId) continue
            if (!conn.email || !conn.clientId) continue

            // 用 clientId 作为 key，如果有多个连接（如多个 tab），取最新的
            usersMap.set(conn.clientId, {
                email: conn.email,
                clientId: conn.clientId,
                deviceType: conn.deviceType,
                sessionId: conn.sessionId
            })
        }

        return Array.from(usersMap.values())
    }

    /**
     * 获取指定 session 的所有查看者
     */
    getSessionViewers(orgId: string, sessionId: string): OnlineUser[] {
        const usersMap = new Map<string, OnlineUser>()

        for (const conn of this.connections.values()) {
            if (conn.orgId !== orgId) continue
            if (conn.sessionId !== sessionId) continue
            if (!conn.email || !conn.clientId) continue

            usersMap.set(conn.clientId, {
                email: conn.email,
                clientId: conn.clientId,
                deviceType: conn.deviceType,
                sessionId: conn.sessionId
            })
        }

        return Array.from(usersMap.values())
    }

    /**
     * 广播在线用户更新事件
     */
    private broadcastOnlineUsers(orgId: string): void {
        const onlineUsers = this.getOnlineUsers(orgId)
        const event: SyncEvent = {
            type: 'online-users-changed',
            orgId,
            users: onlineUsers
        }

        for (const connection of this.connections.values()) {
            if (connection.orgId !== orgId) continue
            if (!connection.all) continue

            try {
                void Promise.resolve(connection.send(event)).catch(() => {
                    this.unsubscribe(connection.id)
                })
            } catch {
                this.unsubscribe(connection.id)
            }
        }
    }

    /**
     * 向订阅了指定群组的所有连接广播群组消息
     */
    broadcastToGroup(groupId: string, event: SyncEvent): void {
        for (const connection of this.connections.values()) {
            if (connection.groupId !== groupId) continue

            try {
                void Promise.resolve(connection.send(event)).catch(() => {
                    this.unsubscribe(connection.id)
                })
            } catch {
                this.unsubscribe(connection.id)
            }
        }
    }

    /**
     * 获取订阅了指定群组的连接数量
     */
    getGroupSubscriberCount(groupId: string): number {
        let count = 0
        for (const connection of this.connections.values()) {
            if (connection.groupId === groupId) {
                count++
            }
        }
        return count
    }
}
