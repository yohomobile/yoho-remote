import type { StoredAuditEvent } from '../store'
import type { IStore, WriteAuditEventInput } from './types'

export class AuditService {
    constructor(private readonly store: IStore) {}

    async writeEvent(input: WriteAuditEventInput): Promise<StoredAuditEvent> {
        return this.store.createAuditEvent(input)
    }

    async listEvents(filters?: {
        orgId?: string | null
        sessionId?: string
        subjectId?: string
        limit?: number
    }): Promise<StoredAuditEvent[]> {
        return this.store.listAuditEvents(filters)
    }
}
