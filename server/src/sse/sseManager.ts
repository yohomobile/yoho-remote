import type { SyncEvent, OnlineUser } from '../sync/syncEngine'

export type SSESubscription = {
    id: string
    namespace: string
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

    constructor(heartbeatMs = 30_000) {
        this.heartbeatMs = heartbeatMs
    }

    subscribe(options: {
        id: string
        namespace: string
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
            namespace: options.namespace,
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

        // 广播在线用户更新
        this.broadcastOnlineUsers(options.namespace)

        return {
            id: subscription.id,
            namespace: subscription.namespace,
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
        const namespace = connection?.namespace
        this.connections.delete(id)
        if (this.connections.size === 0) {
            this.stopHeartbeat()
        }
        // 广播在线用户更新
        if (namespace) {
            this.broadcastOnlineUsers(namespace)
        }
    }

    broadcast(event: SyncEvent): void {
        for (const connection of this.connections.values()) {
            if (!this.shouldSend(connection, event)) {
                continue
            }

            void Promise.resolve(connection.send(event)).catch(() => {
                this.unsubscribe(connection.id)
            })
        }
    }

    stop(): void {
        this.stopHeartbeat()
        this.connections.clear()
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
            const eventNamespace = event.namespace
            if (!eventNamespace || eventNamespace !== connection.namespace) {
                return false
            }
        }

        if (event.type === 'message-received') {
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
            const data = event.data as { wasThinking?: boolean } | undefined
            if (data?.wasThinking) {
                // 如果连接正在查看这个 session，允许发送（用于更新 UI 状态）
                if (event.sessionId && connection.sessionId === event.sessionId) {
                    return true
                }
                // 如果有 notifyRecipientClientIds，只发给列表中的 clientId
                if (event.notifyRecipientClientIds) {
                    if (!connection.clientId) {
                        return false
                    }
                    return event.notifyRecipientClientIds.includes(connection.clientId)
                }
                // 没有 notifyRecipientClientIds 时（如获取订阅者失败），不广播给 all:true 订阅
                // 只发给正在查看该 session 的用户（上面已处理）
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
     * 获取指定 namespace 的所有在线用户
     */
    getOnlineUsers(namespace: string): OnlineUser[] {
        const usersMap = new Map<string, OnlineUser>()  // 用 clientId 去重

        for (const conn of this.connections.values()) {
            if (conn.namespace !== namespace) continue
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
    getSessionViewers(namespace: string, sessionId: string): OnlineUser[] {
        const usersMap = new Map<string, OnlineUser>()

        for (const conn of this.connections.values()) {
            if (conn.namespace !== namespace) continue
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
    private broadcastOnlineUsers(namespace: string): void {
        const onlineUsers = this.getOnlineUsers(namespace)
        const event: SyncEvent = {
            type: 'online-users-changed',
            namespace,
            users: onlineUsers
        }

        for (const connection of this.connections.values()) {
            if (connection.namespace !== namespace) continue
            if (!connection.all) continue  // 只给订阅 all 的连接发送

            void Promise.resolve(connection.send(event)).catch(() => {
                this.unsubscribe(connection.id)
            })
        }
    }

    /**
     * 向订阅了指定群组的所有连接广播群组消息
     */
    broadcastToGroup(groupId: string, event: SyncEvent): void {
        for (const connection of this.connections.values()) {
            if (connection.groupId !== groupId) continue

            void Promise.resolve(connection.send(event)).catch(() => {
                this.unsubscribe(connection.id)
            })
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
