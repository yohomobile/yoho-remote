import { describe, expect, it } from 'bun:test'
import { parseAccessToken } from './accessToken'

describe('parseAccessToken', () => {
    it('parses a plain token', () => {
        const parsed = parseAccessToken('token')
        expect(parsed).toEqual({ baseToken: 'token' })
    })

    it('rejects namespace suffixes', () => {
        expect(parseAccessToken('token:alice')).toBeNull()
    })

    it('rejects empty suffix', () => {
        expect(parseAccessToken('token:')).toBeNull()
    })

    it('rejects missing base token before suffix', () => {
        expect(parseAccessToken(':alice')).toBeNull()
    })

    it('rejects whitespace after suffix separator', () => {
        expect(parseAccessToken('token: alice')).toBeNull()
    })
})
