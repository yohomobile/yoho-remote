import type { MiddlewareHandler } from 'hono'
import { safeCompareStrings } from '../../utils/crypto'

export function internalAuthMiddleware(expectedToken: string): MiddlewareHandler {
    return async (c, next) => {
        const token = c.req.header('X-Worker-Token')
        if (!token || !safeCompareStrings(token, expectedToken)) {
            return c.json({ error: 'unauthorized' }, 401)
        }
        await next()
        return
    }
}
