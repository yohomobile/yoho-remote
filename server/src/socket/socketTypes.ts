import type { DefaultEventsMap, Server, Socket } from 'socket.io'

export type SocketData = {
    orgId?: string
    userId?: string  // Keycloak user ID (sub claim is UUID string)
}

export type SocketServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
export type SocketWithData = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>
