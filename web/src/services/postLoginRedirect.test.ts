import { describe, expect, test } from 'bun:test'
import { consumePostLoginRedirect, peekPostLoginRedirect, setPostLoginRedirect, type StorageLike } from './postLoginRedirect'

function createStorage(): StorageLike {
    const values = new Map<string, string>()
    return {
        getItem(key) {
            return values.get(key) ?? null
        },
        setItem(key, value) {
            values.set(key, value)
        },
        removeItem(key) {
            values.delete(key)
        },
    }
}

describe('postLoginRedirect', () => {
    test('stores and consumes safe relative paths', () => {
        const storage = createStorage()

        setPostLoginRedirect('/invitations/accept/invite-123', storage)

        expect(peekPostLoginRedirect(storage)).toBe('/invitations/accept/invite-123')
        expect(consumePostLoginRedirect(storage)).toBe('/invitations/accept/invite-123')
        expect(peekPostLoginRedirect(storage)).toBeNull()
    })

    test('ignores unsafe absolute or protocol-relative redirects', () => {
        const storage = createStorage()

        setPostLoginRedirect('https://evil.example', storage)
        expect(peekPostLoginRedirect(storage)).toBeNull()

        setPostLoginRedirect('//evil.example', storage)
        expect(peekPostLoginRedirect(storage)).toBeNull()
    })
})
