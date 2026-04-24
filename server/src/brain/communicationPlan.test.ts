import { describe, expect, it } from 'bun:test'
import {
    appendCommunicationPlanPrompt,
    resolveSessionCommunicationPlanContext,
} from './communicationPlan'
import type { StoredCommunicationPlan } from '../store'

function makePlan(overrides: Partial<StoredCommunicationPlan> = {}): StoredCommunicationPlan {
    return {
        id: 'plan-1',
        namespace: 'org-1',
        orgId: 'org-1',
        personId: 'person-1',
        preferences: {
            tone: '直接，少铺垫',
            length: 'concise',
            explanationDepth: 'minimal',
            formality: 'neutral',
            customInstructions: null,
        },
        enabled: true,
        version: 2,
        createdAt: 1,
        updatedAt: 10,
        updatedBy: 'admin@example.com',
        ...overrides,
    }
}

describe('communicationPlan', () => {
    it('returns disabled-no-person when personId is missing', async () => {
        const ctx = await resolveSessionCommunicationPlanContext({
            store: { getCommunicationPlanByPerson: async () => null } as any,
            personId: null,
        })
        expect(ctx.prompt).toBeNull()
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('disabled-no-person')
        expect(ctx.metadataPatch.communicationPlanAttached).toBe(false)
    })

    it('returns disabled-store-unsupported when store lacks method', async () => {
        const ctx = await resolveSessionCommunicationPlanContext({
            store: {} as any,
            personId: 'person-1',
        })
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('disabled-store-unsupported')
    })

    it('returns missing when no plan exists for person', async () => {
        const ctx = await resolveSessionCommunicationPlanContext({
            store: { getCommunicationPlanByPerson: async () => null } as any,
            orgId: 'org-1',
            personId: 'person-1',
        })
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('missing')
        expect(ctx.metadataPatch.communicationPlanPersonId).toBe('person-1')
        expect(ctx.prompt).toBeNull()
    })

    it('skips prompt when plan is disabled but reports status', async () => {
        const plan = makePlan({ enabled: false })
        const ctx = await resolveSessionCommunicationPlanContext({
            store: { getCommunicationPlanByPerson: async () => plan } as any,
            orgId: 'org-1',
            personId: 'person-1',
        })
        expect(ctx.prompt).toBeNull()
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('disabled')
        expect(ctx.metadataPatch.communicationPlanId).toBe('plan-1')
        expect(ctx.metadataPatch.communicationPlanVersion).toBe(2)
    })

    it('returns empty status when plan enabled but preferences all null', async () => {
        const plan = makePlan({
            preferences: {
                tone: null,
                length: null,
                explanationDepth: null,
                formality: null,
                customInstructions: null,
            },
        })
        const ctx = await resolveSessionCommunicationPlanContext({
            store: { getCommunicationPlanByPerson: async () => plan } as any,
            orgId: 'org-1',
            personId: 'person-1',
        })
        expect(ctx.prompt).toBeNull()
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('empty')
    })

    it('builds prompt with length, depth, formality, tone, customInstructions', async () => {
        const plan = makePlan({
            preferences: {
                tone: '直接，先结论',
                length: 'concise',
                explanationDepth: 'minimal',
                formality: 'casual',
                customInstructions: '禁止任何 emoji\n避免主观情绪化表达',
            },
        })
        const ctx = await resolveSessionCommunicationPlanContext({
            store: { getCommunicationPlanByPerson: async () => plan } as any,
            orgId: 'org-1',
            personId: 'person-1',
        })
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('attached')
        expect(ctx.metadataPatch.communicationPlanAttached).toBe(true)
        expect(ctx.prompt).not.toBeNull()
        const text = ctx.prompt!
        expect(text).toContain('用户表达偏好')
        expect(text).toContain('简洁')
        expect(text).toContain('只给结论')
        expect(text).toContain('口语、随意')
        expect(text).toContain('直接，先结论')
        expect(text).toContain('禁止任何 emoji')
        expect(text).toContain('避免主观情绪化表达')
    })

    it('passes orgId to store lookup and falls back to "default" namespace when absent', async () => {
        let capturedNamespace = ''
        let capturedOrgId: string | null | undefined
        const store = {
            getCommunicationPlanByPerson: async (input: { namespace: string; orgId?: string | null }) => {
                capturedNamespace = input.namespace
                capturedOrgId = input.orgId
                return null
            },
        }
        await resolveSessionCommunicationPlanContext({
            store: store as any,
            orgId: null,
            personId: 'person-1',
        })
        expect(capturedNamespace).toBe('default')
        expect(capturedOrgId).toBeNull()

        await resolveSessionCommunicationPlanContext({
            store: store as any,
            orgId: 'org-42',
            personId: 'person-1',
        })
        expect(capturedNamespace).toBe('org-42')
        expect(capturedOrgId).toBe('org-42')
    })

    it('returns error status when store throws', async () => {
        const ctx = await resolveSessionCommunicationPlanContext({
            store: {
                getCommunicationPlanByPerson: async () => {
                    throw new Error('db exploded')
                },
            } as any,
            orgId: 'org-1',
            personId: 'person-1',
        })
        expect(ctx.plan).toBeNull()
        expect(ctx.metadataPatch.communicationPlanStatus).toBe('error')
        expect(ctx.metadataPatch.communicationPlanPersonId).toBe('person-1')
    })

    it('appendCommunicationPlanPrompt is a no-op when prompt is null/empty', () => {
        expect(appendCommunicationPlanPrompt('base', null)).toBe('base')
        expect(appendCommunicationPlanPrompt('base', '   ')).toBe('base')
    })

    it('appendCommunicationPlanPrompt joins with blank line', () => {
        const merged = appendCommunicationPlanPrompt('base prompt', 'plan body')
        expect(merged).toBe('base prompt\n\nplan body')
    })
})
