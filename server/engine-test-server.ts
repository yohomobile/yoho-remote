import { Server as Engine } from "@socket.io/bun-engine"
import { Server } from "socket.io"

// Match production config
const io = new Server({
    cors: { origin: "*", methods: ["GET", "POST"], credentials: false }
})

const engine = new Engine({
    path: "/socket.io/",
    pingInterval: 10000,
    pingTimeout: 5000,
    maxHttpBufferSize: 150 * 1024 * 1024,
})
io.bind(engine)

io.of("/cli").on("connection", (socket) => {
    console.log("[io] /cli connected:", socket.id)
    socket.on("disconnect", () => console.log("[io] /cli disconnected:", socket.id))
})

const handler = engine.handler()

const server = Bun.serve({
    port: 19997,
    idleTimeout: Math.max(30, handler.idleTimeout),
    websocket: {
        ...handler.websocket,
        open(ws) {
            console.log("[bun] ws open")
            handler.websocket.open(ws)
        },
        message(ws, msg) {
            const preview = typeof msg === "string" ? msg.substring(0, 80) : `[binary ${(msg as any).byteLength}b]`
            console.log(`[bun] ws message: type=${typeof msg} val="${preview}"`)
            handler.websocket.message(ws, msg)
        },
        close(ws, code, reason) {
            console.log(`[bun] ws close: ${code}`)
            handler.websocket.close(ws, code, reason)
        },
    },
    fetch: handler.fetch,
})
console.log(`Test socket.io server on 19997 (idleTimeout=${Math.max(30, handler.idleTimeout)})`)
