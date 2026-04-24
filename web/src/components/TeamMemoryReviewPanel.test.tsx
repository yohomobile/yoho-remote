import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StoredTeamMemoryCandidate } from '@/types/api'
import { TeamMemoryReviewContent } from './TeamMemoryReviewPanel'

function createCandidate(overrides: Partial<StoredTeamMemoryCandidate> = {}): StoredTeamMemoryCandidate {
    return {
        id: 'tm-1',
        namespace: 'org-1',
        orgId: 'org-1',
        proposedByPersonId: null,
        proposedByEmail: 'guang@example.com',
        scope: 'team',
        content: 'sgprod 主库端口 5432',
        source: 'chat',
        sessionId: 'sess-1',
        status: 'pending',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        memoryRef: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...overrides,
    }
}

describe('TeamMemoryReviewPanel', () => {
    test('renders pending candidate with all action buttons', () => {
        const candidate = createCandidate()
        const html = renderToStaticMarkup(
            <TeamMemoryReviewContent
                statusFilter="pending"
                onStatusFilterChange={() => {}}
                candidates={[candidate]}
                selectedCandidate={candidate}
                onSelectCandidate={() => {}}
                memoryRef=""
                onMemoryRefChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onApprove={() => {}}
                onSupersede={() => {}}
                onReject={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('sgprod 主库端口 5432')
        expect(html).toContain('批准')
        expect(html).toContain('替换旧版')
        expect(html).toContain('驳回')
        expect(html).toContain('过期')
        expect(html).toContain('guang@example.com')
    })

    test('hides action buttons for non-pending candidate', () => {
        const candidate = createCandidate({ status: 'approved', memoryRef: 'team/domain/db-port' })
        const html = renderToStaticMarkup(
            <TeamMemoryReviewContent
                statusFilter="approved"
                onStatusFilterChange={() => {}}
                candidates={[candidate]}
                selectedCandidate={candidate}
                onSelectCandidate={() => {}}
                memoryRef=""
                onMemoryRefChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onApprove={() => {}}
                onSupersede={() => {}}
                onReject={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('已批准')
        expect(html).toContain('team/domain/db-port')
        expect(html).not.toContain('批准</button>')
    })

    test('renders empty state when no candidates', () => {
        const html = renderToStaticMarkup(
            <TeamMemoryReviewContent
                statusFilter="pending"
                onStatusFilterChange={() => {}}
                candidates={[]}
                selectedCandidate={null}
                onSelectCandidate={() => {}}
                memoryRef=""
                onMemoryRefChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error={null}
                onApprove={() => {}}
                onSupersede={() => {}}
                onReject={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('暂无待审批候选')
    })

    test('shows error banner when error present', () => {
        const html = renderToStaticMarkup(
            <TeamMemoryReviewContent
                statusFilter="pending"
                onStatusFilterChange={() => {}}
                candidates={[]}
                selectedCandidate={null}
                onSelectCandidate={() => {}}
                memoryRef=""
                onMemoryRefChange={() => {}}
                reason=""
                onReasonChange={() => {}}
                isLoading={false}
                isDeciding={false}
                error="network down"
                onApprove={() => {}}
                onSupersede={() => {}}
                onReject={() => {}}
                onExpire={() => {}}
            />
        )
        expect(html).toContain('network down')
    })
})
