import { describe, expect, test } from 'bun:test'
import {
    applyArchiveProtectionOnPatch,
    applyArchiveProtectionOnReplace,
    getBrainChildMainSessionId,
    getSessionMetadataInvariantError,
    getSessionMetadataPersistenceError,
    getUnsupportedSessionSourceError,
    getSessionSourceFromMetadata,
    isProtectedArchivedSession,
    isSupportedSessionSource,
    normalizeSessionMetadataInvariants,
} from './sessionSourcePolicy'

describe('sessionSourcePolicy', () => {
    test('accepts supported sources only', () => {
        expect(isSupportedSessionSource('brain')).toBe(true)
        expect(isSupportedSessionSource('brain-child')).toBe(true)
        expect(isSupportedSessionSource('external-api')).toBe(true)
        expect(isSupportedSessionSource('automation:repair')).toBe(true)
        expect(isSupportedSessionSource('worker-ai-task')).toBe(true)
        expect(isSupportedSessionSource('legacy-source')).toBe(false)
        expect(isSupportedSessionSource(undefined)).toBe(true)
    })

    test('extracts source from metadata objects only', () => {
        expect(getSessionSourceFromMetadata({ source: 'brain' })).toBe('brain')
        expect(getSessionSourceFromMetadata({ source: ' BRAIN-CHILD ' })).toBe('brain-child')
        expect(getSessionSourceFromMetadata({ source: 1 })).toBe(null)
        expect(getSessionSourceFromMetadata(null)).toBe(null)
    })

    test('formats a readable error message', () => {
        expect(getUnsupportedSessionSourceError('legacy-source')).toContain('legacy-source')
    })

    test('rejects brain-child metadata without mainSessionId', () => {
        expect(getSessionMetadataInvariantError({
            source: 'brain-child',
            caller: 'feishu',
        })).toBe('brain-child sessions require mainSessionId')
    })

    test('rejects brain-linked metadata when source is missing', () => {
        expect(getSessionMetadataInvariantError({
            mainSessionId: 'brain-1',
        })).toBe('brain-linked metadata requires source=brain or source=brain-child')
        expect(getSessionMetadataInvariantError({
            brainPreferences: {
                childModels: {},
            },
        })).toBe('brain-linked metadata requires source=brain or source=brain-child')
    })

    test('normalizes stray brain linkage fields off non-brain sessions', () => {
        expect(normalizeSessionMetadataInvariants({
            source: 'MANUAL',
            mainSessionId: 'brain-1',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
            caller: 'webapp',
        })).toEqual({
            source: 'manual',
            caller: 'webapp',
        })
    })

    test('normalizes brain metadata by clearing mainSessionId from brain main sessions only', () => {
        expect(normalizeSessionMetadataInvariants({
            source: 'BRAIN',
            mainSessionId: 'stale-child-link',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })).toEqual({
            source: 'brain',
            brainPreferences: {
                machineSelection: { mode: 'manual', machineId: 'machine-1' },
            },
        })
    })

    test('only exposes mainSessionId for brain-child metadata on read paths', () => {
        expect(getBrainChildMainSessionId({
            source: 'brain-child',
            mainSessionId: 'brain-1',
        })).toBe('brain-1')
        expect(getBrainChildMainSessionId({
            source: 'manual',
            mainSessionId: 'brain-1',
        })).toBeUndefined()
    })

    test('rejects invalid brainPreferences at write time for brain-linked sessions', () => {
        expect(getSessionMetadataPersistenceError({
            source: 'BRAIN-CHILD',
            mainSessionId: 'brain-1',
            brainPreferences: {
                machineSelection: { mode: 'manual' },
            },
        })).toBe('Invalid brainPreferences in session metadata')
    })

    describe('archive protection', () => {
        const archivedByUser = {
            source: 'brain-child',
            mainSessionId: 'brain-1',
            lifecycleState: 'archived',
            lifecycleStateSince: 100,
            archivedBy: 'user',
            archiveReason: 'User archived session',
        }

        test('isProtectedArchivedSession flags user / brain archives but not cli', () => {
            expect(isProtectedArchivedSession(archivedByUser)).toBe(true)
            expect(isProtectedArchivedSession({ ...archivedByUser, archivedBy: 'brain' })).toBe(true)
            expect(isProtectedArchivedSession({ ...archivedByUser, archivedBy: 'cli' })).toBe(false)
            expect(isProtectedArchivedSession({ ...archivedByUser, lifecycleState: 'running' })).toBe(false)
            expect(isProtectedArchivedSession({ ...archivedByUser, archivedBy: '' })).toBe(false)
            expect(isProtectedArchivedSession(null)).toBe(false)
        })

        test('applyArchiveProtectionOnReplace forces archived lifecycle and preserves stamp when CLI tries to revive', () => {
            const incoming = {
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'running',
                lifecycleStateSince: 999,
                hostPid: 42,
            }
            const { metadata, preserved } = applyArchiveProtectionOnReplace(archivedByUser, incoming)
            expect(preserved).toBe(true)
            expect(metadata).toEqual({
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'archived',
                lifecycleStateSince: 100,
                archivedBy: 'user',
                archiveReason: 'User archived session',
                hostPid: 42,
            })
        })

        test('applyArchiveProtectionOnReplace keeps archivedBy stamp even when incoming metadata already archived', () => {
            const incoming = {
                source: 'brain-child',
                mainSessionId: 'brain-1',
                lifecycleState: 'archived',
                lifecycleStateSince: 200,
            }
            const { metadata, preserved } = applyArchiveProtectionOnReplace(archivedByUser, incoming)
            expect(preserved).toBe(false)
            expect(metadata).toMatchObject({
                lifecycleState: 'archived',
                lifecycleStateSince: 200,
                archivedBy: 'user',
                archiveReason: 'User archived session',
            })
        })

        test('applyArchiveProtectionOnReplace is a no-op when session is not protected', () => {
            const notArchived = { source: 'manual', lifecycleState: 'running' }
            const incoming = { source: 'manual', lifecycleState: 'running', hostPid: 1 }
            const { metadata, preserved } = applyArchiveProtectionOnReplace(notArchived, incoming)
            expect(preserved).toBe(false)
            expect(metadata).toBe(incoming)
        })

        test('applyArchiveProtectionOnPatch strips unarchive stamps on protected sessions', () => {
            const patch = { lifecycleState: 'running', archivedBy: null, archiveReason: null, hostPid: 42 }
            const { metadata, preserved } = applyArchiveProtectionOnPatch(archivedByUser, patch)
            expect(preserved).toBe(true)
            expect(metadata).toEqual({ hostPid: 42 })
        })

        test('applyArchiveProtectionOnPatch leaves non-archive patches untouched on protected sessions', () => {
            const patch = { summary: 'hi' }
            const { metadata, preserved } = applyArchiveProtectionOnPatch(archivedByUser, patch)
            expect(preserved).toBe(false)
            expect(metadata).toEqual({ summary: 'hi' })
        })

        test('applyArchiveProtectionOnPatch allows re-archiving (lifecycleState=archived) to pass through', () => {
            const patch = { lifecycleState: 'archived', lifecycleStateSince: 999 }
            const { metadata, preserved } = applyArchiveProtectionOnPatch(archivedByUser, patch)
            expect(preserved).toBe(false)
            expect(metadata).toEqual({ lifecycleState: 'archived', lifecycleStateSince: 999 })
        })

        test('applyArchiveProtectionOnPatch is a no-op for cli-archived sessions', () => {
            const cliArchived = { ...archivedByUser, archivedBy: 'cli' }
            const patch = { lifecycleState: 'running' }
            const { metadata, preserved } = applyArchiveProtectionOnPatch(cliArchived, patch)
            expect(preserved).toBe(false)
            expect(metadata).toEqual({ lifecycleState: 'running' })
        })
    })
})
