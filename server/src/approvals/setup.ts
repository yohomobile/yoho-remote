// Registry wiring for the Approvals Engine.
//
// Called once at server boot. Each domain plugin lives in
// `server/src/approvals/domains/*` and gets registered here in a deterministic
// order. Adding a new approval domain = adding one import + one register call.

import { ApprovalDomainRegistry } from './registry'
import { identityDomain } from './domains/identity'
import { skillDomain } from './domains/skill'

export function buildApprovalDomainRegistry(): ApprovalDomainRegistry {
    const registry = new ApprovalDomainRegistry()
    registry.register(identityDomain)
    registry.register(skillDomain)
    return registry
}
