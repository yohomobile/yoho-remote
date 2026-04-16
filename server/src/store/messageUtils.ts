export function isRealActivityMessage(content: unknown): boolean {
    if (!content || typeof content !== 'object') return false
    const role = (content as Record<string, unknown>).role
    return role === 'user' || role === 'agent' || role === 'assistant'
}
