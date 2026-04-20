import { describe, expect, test } from 'bun:test'
import type { StoredSession } from '../store/types'
import { buildBrainSessionPreferences } from './brainSessionPreferences'
import { auditBrainSessions } from './brainSessionAudit'

function createStoredSession(overrides: Partial<StoredSession>): StoredSession {
    return {
        id: 'session-1',
        tag: null,
        namespace: 'default',
        machineId: 'machine-1',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
        createdBy: null,
        orgId: null,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        todos: null,
        todosUpdatedAt: null,
        active: false,
        activeAt: null,
        thinking: false,
        thinkingAt: null,
        seq: 0,
        advisorTaskId: null,
        creatorChatId: null,
        advisorMode: false,
        advisorPromptInjected: false,
        rolePromptSent: false,
        permissionMode: null,
        modelMode: null,
        modelReasoningEffort: null,
        fastMode: null,
        terminationReason: null,
        lastMessageAt: null,
        activeMonitors: null,
        ...overrides,
    }
}

describe('auditBrainSessions', () => {
    test('flags invalid brainPreferences and suggests copying from a valid parent brain session', () => {
        const parent = createStoredSession({
            id: 'brain-parent',
            metadata: {
                source: 'brain',
                flavor: 'claude',
                path: '/repo',
                brainPreferences: buildBrainSessionPreferences({
                    machineSelectionMode: 'manual',
                    machineId: 'machine-1',
                    childClaudeModels: ['sonnet'],
                    childCodexModels: ['gpt-5.4'],
                }),
            },
        })
        const child = createStoredSession({
            id: 'brain-child-1',
            metadata: {
                source: 'brain-child',
                flavor: 'claude',
                path: '/repo',
                mainSessionId: parent.id,
                brainPreferences: {
                    machineSelection: { mode: 'manual' },
                },
            },
        })
        const report = auditBrainSessions([parent, child])

        expect(report.summary).toEqual({
            totalSessions: 2,
            scannedBrainSessions: 2,
            brainSessions: 1,
            brainChildSessions: 1,
            invalidBrainPreferences: 1,
            dirtyPermissionModes: 0,
            autoFixable: 1,
            blockedByActive: 0,
        })
        expect(report.invalidBrainPreferences).toEqual([
            expect.objectContaining({
                sessionId: child.id,
                source: 'brain-child',
                issue: 'invalid-brainPreferences',
                autoFix: {
                    kind: 'copy-parent-brainPreferences',
                    parentSessionId: parent.id,
                    nextBrainPreferences: buildBrainSessionPreferences({
                        machineSelectionMode: 'manual',
                        machineId: 'machine-1',
                        childClaudeModels: ['sonnet'],
                        childCodexModels: ['gpt-5.4'],
                    }),
                },
            }),
        ])
        expect(report.autoFixable).toEqual([
            {
                sessionId: child.id,
                namespace: child.namespace,
                source: 'brain-child',
                issue: 'invalid-brainPreferences',
                active: false,
                updatedAt: child.updatedAt,
                fix: {
                    kind: 'copy-parent-brainPreferences',
                    parentSessionId: parent.id,
                    nextBrainPreferences: buildBrainSessionPreferences({
                        machineSelectionMode: 'manual',
                        machineId: 'machine-1',
                        childClaudeModels: ['sonnet'],
                        childCodexModels: ['gpt-5.4'],
                    }),
                },
            },
        ])
        expect(report.blockedAutoFixable).toEqual([])
    })

    test('flags dirty permissionMode and only marks safe normalizations as auto-fixable', () => {
        const autoFixableLegacyCodex = createStoredSession({
            id: 'brain-child-codex',
            permissionMode: 'bypassPermissions',
            metadata: {
                source: 'brain-child',
                flavor: 'codex',
                mainSessionId: 'brain-parent',
                yolo: true,
            },
        })
        const invalidClaudePermission = createStoredSession({
            id: 'brain-claude-invalid-mode',
            permissionMode: 'safe-yolo',
            metadata: {
                source: 'brain',
                flavor: 'claude',
            },
        })

        const report = auditBrainSessions([autoFixableLegacyCodex, invalidClaudePermission])

        expect(report.summary.dirtyPermissionModes).toBe(2)
        expect(report.summary.autoFixable).toBe(1)
        expect(report.summary.blockedByActive).toBe(0)
        expect(report.dirtyPermissionModes).toEqual([
            expect.objectContaining({
                sessionId: 'brain-child-codex',
                storedPermissionMode: 'bypassPermissions',
                normalizedPermissionMode: 'yolo',
                autoFix: {
                    kind: 'normalize-permissionMode',
                    nextPermissionMode: 'yolo',
                },
            }),
            expect.objectContaining({
                sessionId: 'brain-claude-invalid-mode',
                storedPermissionMode: 'safe-yolo',
                normalizedPermissionMode: null,
                autoFix: null,
            }),
        ])
        expect(report.autoFixable).toEqual([
            expect.objectContaining({
                sessionId: autoFixableLegacyCodex.id,
                active: false,
                updatedAt: autoFixableLegacyCodex.updatedAt,
                fix: {
                    kind: 'normalize-permissionMode',
                    nextPermissionMode: 'yolo',
                },
            }),
        ])
        expect(report.blockedAutoFixable).toEqual([])
    })

    test('blocks otherwise-safe fixes from auto-fix manifests when the target session is active', () => {
        const activeChild = createStoredSession({
            id: 'brain-child-active',
            active: true,
            permissionMode: 'bypassPermissions',
            metadata: {
                source: 'brain-child',
                flavor: 'codex',
                mainSessionId: 'brain-parent',
                yolo: true,
            },
        })

        const report = auditBrainSessions([activeChild])

        expect(report.summary.autoFixable).toBe(0)
        expect(report.summary.blockedByActive).toBe(1)
        expect(report.blockedAutoFixable).toEqual([
            {
                sessionId: activeChild.id,
                namespace: activeChild.namespace,
                source: 'brain-child',
                issue: 'dirty-permissionMode',
                active: true,
                updatedAt: activeChild.updatedAt,
                blockedReason: 'session-active',
                fix: {
                    kind: 'normalize-permissionMode',
                    nextPermissionMode: 'yolo',
                },
            },
        ])
    })
})
