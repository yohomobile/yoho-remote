import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StoredObservationCandidate } from '@/types/api'
import { ObservationReviewContent } from './ObservationReviewPanel'

function createCandidate(overrides: Partial<StoredObservationCandidate> = {}): StoredObservationCandidate {
    return {
        id: 'obs-1',
        namespace: 'org-1',
        orgId: 'org-1',
        subjectPersonId: 'person-1',
        subjectEmail: 'guang@example.com',
        hypothesisKey: 'reply.conciseness.preference',
        summary: 'Guang 最近多次要求更短回复',
        detail: '近 5 次会话中明确说"简短点"',
        detectorVersion: 'obs-v1',
        confidence: 0.72,
        signals: [
            { kind: 'user_said_shorter', summary: '"简短点" x3', occurredAt: 1, weight: 1 },
            { kind: 'reply_length_complaint', summary: '投诉过长回复 x2', occurredAt: 2, weight: 0.8 },
        ],
        suggestedPatch: { length: 'concise' },
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        promotedCommunicationPlanId: null,
        expiresAt: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...overrides,
    }
}

describe('ObservationReviewPanel', () => {
    test('renders pending candidate with all details and actions', () => {
        const candidate = createCandidate()
        const html = renderToStaticMarkup(
            <ObservationReviewContent
                statusFilter="pending"
                onStatusFilterChange={() => {}}
                candidates={[candidate]}
                selectedCandidate={candidate}
                onSelectCandidate={() => {}}
                planId=""
                onPlanIdChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onConfirm={() => {}}
                onReject={() => {}}
                onDismiss={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('reply.conciseness.preference')
        expect(html).toContain('Guang 最近多次要求更短回复')
        expect(html).toContain('72%')
        expect(html).toContain('user_said_shorter')
        expect(html).toContain('确认')
        expect(html).toContain('驳回')
        expect(html).toContain('忽略')
        expect(html).toContain('obs-v1')
    })

    test('hides decision form for confirmed candidate', () => {
        const candidate = createCandidate({
            status: 'confirmed',
            promotedCommunicationPlanId: 'plan-42',
        })
        const html = renderToStaticMarkup(
            <ObservationReviewContent
                statusFilter="confirmed"
                onStatusFilterChange={() => {}}
                candidates={[candidate]}
                selectedCandidate={candidate}
                onSelectCandidate={() => {}}
                planId=""
                onPlanIdChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onConfirm={() => {}}
                onReject={() => {}}
                onDismiss={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('已确认')
        expect(html).toContain('plan-42')
        expect(html).not.toContain('确认</button>')
    })

    test('renders empty state', () => {
        const html = renderToStaticMarkup(
            <ObservationReviewContent
                statusFilter="pending"
                onStatusFilterChange={() => {}}
                candidates={[]}
                selectedCandidate={null}
                onSelectCandidate={() => {}}
                planId=""
                onPlanIdChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onConfirm={() => {}}
                onReject={() => {}}
                onDismiss={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('暂无待确认假设')
    })

    test('renders suggested patch as JSON', () => {
        const candidate = createCandidate({
            suggestedPatch: { length: 'concise', explanationDepth: 'minimal' },
        })
        const html = renderToStaticMarkup(
            <ObservationReviewContent
                statusFilter="pending"
                onStatusFilterChange={() => {}}
                candidates={[candidate]}
                selectedCandidate={candidate}
                onSelectCandidate={() => {}}
                planId=""
                onPlanIdChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onConfirm={() => {}}
                onReject={() => {}}
                onDismiss={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('explanationDepth')
        expect(html).toContain('minimal')
    })
})
