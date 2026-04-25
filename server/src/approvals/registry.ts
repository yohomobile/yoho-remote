// Domain registry for the Approvals Engine.
//
// A domain registers once at process boot (server/im/worker side) and is
// looked up by name during every decide call. Keep the registry intentionally
// tiny: no lazy-loading, no auto-discovery, no per-org overrides — when those
// become needed, replace this file rather than bolting features on.

import type { ApprovalDomain } from './types'

export class ApprovalDomainRegistry {
    private readonly domains = new Map<string, ApprovalDomain<unknown, { action: string }>>()

    register<TPayload, TAction extends { action: string }>(
        domain: ApprovalDomain<TPayload, TAction>,
    ): void {
        if (this.domains.has(domain.name)) {
            throw new Error(`Approval domain "${domain.name}" already registered`)
        }
        this.domains.set(
            domain.name,
            domain as unknown as ApprovalDomain<unknown, { action: string }>,
        )
    }

    get(name: string): ApprovalDomain<unknown, { action: string }> | null {
        return this.domains.get(name) ?? null
    }

    require(name: string): ApprovalDomain<unknown, { action: string }> {
        const domain = this.domains.get(name)
        if (!domain) {
            throw new Error(`Approval domain "${name}" is not registered`)
        }
        return domain
    }

    list(): ApprovalDomain<unknown, { action: string }>[] {
        return Array.from(this.domains.values())
    }
}
