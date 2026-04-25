// Registry wiring for the Approvals Engine.
//
// Called once at server boot. Each domain plugin lives in
// `server/src/approvals/domains/*` and gets registered here in a deterministic
// order. Adding a new approval domain = adding one import + one register call.

import { ApprovalDomainRegistry } from './registry'
import { teamMemoryDomain } from './domains/team-memory'
import { memoryConflictDomain } from './domains/memory-conflict'
import { observationDomain } from './domains/observation'
import { identityDomain } from './domains/identity'

export function buildApprovalDomainRegistry(): ApprovalDomainRegistry {
    const registry = new ApprovalDomainRegistry()
    registry.register(teamMemoryDomain)
    registry.register(memoryConflictDomain)
    registry.register(observationDomain)
    registry.register(identityDomain)
    return registry
}
