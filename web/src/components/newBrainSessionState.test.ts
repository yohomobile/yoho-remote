import { describe, expect, test } from 'bun:test'

import { LOCAL_TOKEN_SOURCE_ID } from '@/lib/tokenSources'
import {
    filterBrainChildModelsByRuntimeAvailability,
    normalizeChildClaudeModels,
    normalizeChildCodexModels,
    pickDefaultTokenSourceId,
    resolveBrainChildRuntimeAvailability,
} from './newBrainSessionState'

describe('newBrainSessionState', () => {
    test('preserves explicit empty Claude child model selections', () => {
        expect(normalizeChildClaudeModels({
            childClaudeModels: [],
        })).toEqual([])
    })

    test('preserves explicit empty Codex child model selections', () => {
        expect(normalizeChildCodexModels({
            childCodexModels: [],
        })).toEqual([])
    })

    test('falls back to full child model defaults only when config is absent', () => {
        expect(normalizeChildClaudeModels(undefined)).toEqual(['sonnet', 'opus', 'opus-4-7'])
        expect(normalizeChildCodexModels(undefined)).toContain('openai/gpt-5.5')
        expect(normalizeChildCodexModels(undefined)).toContain('openai/gpt-5.4')
    })

    test('prefers the newest non-local token source when multiple are compatible', () => {
        expect(pickDefaultTokenSourceId([
            {
                id: LOCAL_TOKEN_SOURCE_ID,
                name: 'Local',
                baseUrl: 'http://localhost:3000',
                supportedAgents: ['claude', 'codex'],
                createdAt: 1,
                updatedAt: 1,
                hasApiKey: false,
            },
            {
                id: 'ts-older',
                name: 'Older',
                baseUrl: 'https://older.example.com',
                supportedAgents: ['claude'],
                createdAt: 10,
                updatedAt: 10,
                hasApiKey: true,
            },
            {
                id: 'ts-newer',
                name: 'Newer',
                baseUrl: 'https://newer.example.com',
                supportedAgents: ['claude'],
                createdAt: 20,
                updatedAt: 20,
                hasApiKey: true,
            },
        ])).toBe('ts-newer')
    })

    test('matches backend runtime availability when Local stays enabled', () => {
        expect(resolveBrainChildRuntimeAvailability({
            machineSupportedAgents: ['codex'],
            localTokenSourceEnabled: true,
            tokenSourceIds: {},
        })).toEqual({
            claude: false,
            codex: true,
        })
    })

    test('keeps cross-machine child capability when Local stays enabled', () => {
        expect(resolveBrainChildRuntimeAvailability({
            machineSupportedAgents: null,
            localTokenSourceEnabled: true,
            tokenSourceIds: {},
        })).toEqual({
            claude: true,
            codex: true,
        })
    })

    test('drops child model families that are not actually runnable', () => {
        expect(filterBrainChildModelsByRuntimeAvailability({
            availability: {
                claude: false,
                codex: true,
            },
            childClaudeModels: ['sonnet', 'opus'],
            childCodexModels: ['openai/gpt-5.4', 'openai/gpt-5.4-mini'],
        })).toEqual({
            childClaudeModels: [],
            childCodexModels: ['openai/gpt-5.4', 'openai/gpt-5.4-mini'],
        })
    })
})
