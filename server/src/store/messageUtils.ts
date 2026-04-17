export function isRealActivityMessage(content: unknown): boolean {
    if (!content || typeof content !== 'object') return false
    const c = content as Record<string, unknown>
    const role = c.role
    if (role === 'user' || role === 'assistant') return true
    if (role === 'agent') {
        const inner = c.content
        if (inner && typeof inner === 'object') {
            const innerObj = inner as Record<string, unknown>
            if (innerObj.type === 'event') return false
            if (innerObj.type === 'output' && innerObj.data && typeof innerObj.data === 'object') {
                const dataType = (innerObj.data as Record<string, unknown>).type
                return dataType === 'assistant' || dataType === 'user'
            }
        }
        return true
    }
    return false
}
