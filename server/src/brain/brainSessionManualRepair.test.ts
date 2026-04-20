import { describe, expect, test } from 'bun:test'
import type { StoredSession } from '../store/types'
import { buildBrainSessionPreferences } from './brainSessionPreferences'
import {
    applyBrainSessionManualRepairs,
    buildBrainSessionManualRepairPlan,
    parseBrainSessionManualRepairManifest,
} from './brainSessionManualRepair'

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

describe('brainSessionManualRepair', () => {
    test('manifest schema rejects ambiguous brainPreferences input', () => {
        expect(parseBrainSessionManualRepairManifest({
            version: 1,
            items: [{
                sessionId: 'brain-child-1',
                action: 'set-brainPreferences',
                brainPreferences: buildBrainSessionPreferences({
                    machineSelectionMode: 'manual',
                    machineId: 'machine-1',
                }),
                copyFromSessionId: 'brain-parent',
            }],
        })).toBeNull()
    })

    test('plan builds validated changes and always skips active sessions', () => {
        const parent = createStoredSession({
            id: 'brain-parent',
            metadata: {
                source: 'brain',
                flavor: 'claude',
                brainPreferences: buildBrainSessionPreferences({
                    machineSelectionMode: 'manual',
                    machineId: 'machine-1',
                    childClaudeModels: ['sonnet'],
                }),
            },
        })
        const inactiveChild = createStoredSession({
            id: 'brain-child-1',
            metadata: {
                source: 'brain-child',
                flavor: 'claude',
                mainSessionId: parent.id,
                brainPreferences: {
                    machineSelection: { mode: 'manual' },
                },
            },
        })
        const activeCodex = createStoredSession({
            id: 'brain-codex-active',
            active: true,
            permissionMode: 'bypassPermissions',
            metadata: {
                source: 'brain-child',
                flavor: 'codex',
                yolo: true,
            },
        })

        const manifest = parseBrainSessionManualRepairManifest({
            version: 1,
            items: [
                {
                    sessionId: inactiveChild.id,
                    action: 'set-brainPreferences',
                    copyFromSessionId: parent.id,
                },
                {
                    sessionId: activeCodex.id,
                    action: 'set-permissionMode',
                    permissionMode: 'yolo',
                },
            ],
        })

        expect(manifest).not.toBeNull()
        const plan = buildBrainSessionManualRepairPlan(
            [parent, inactiveChild, activeCodex],
            manifest!
        )

        expect(plan.summary).toEqual({
            manifestItems: 2,
            plannedWrites: 1,
            skippedActive: 1,
            skippedNoop: 0,
            rejected: 0,
        })
        expect(plan.planned).toEqual([
            expect.objectContaining({
                sessionId: inactiveChild.id,
                action: 'set-brainPreferences',
                copyFromSessionId: parent.id,
                diff: expect.objectContaining({
                    field: 'brainPreferences',
                }),
            }),
        ])
        expect(plan.skippedActive).toEqual([
            {
                manifestIndex: 1,
                sessionId: activeCodex.id,
                namespace: activeCodex.namespace,
                reason: 'active 会话永远跳过',
            },
        ])
    })

    test('apply rechecks active/drift guardrails before writing', async () => {
        const target = createStoredSession({
            id: 'brain-child-codex',
            permissionMode: 'bypassPermissions',
            metadata: {
                source: 'brain-child',
                flavor: 'codex',
                yolo: true,
            },
        })
        const manifest = parseBrainSessionManualRepairManifest({
            version: 1,
            items: [{
                sessionId: target.id,
                action: 'set-permissionMode',
                permissionMode: 'yolo',
            }],
        })
        expect(manifest).not.toBeNull()

        const plan = buildBrainSessionManualRepairPlan([target], manifest!)
        const setSessionModelConfigCalls: Array<Record<string, unknown>> = []
        const store = {
            getSession: async () => ({
                ...target,
                permissionMode: 'default',
            }),
            setSessionModelConfig: async (_id: string, config: Record<string, unknown>) => {
                setSessionModelConfigCalls.push(config)
                return true
            },
            patchSessionMetadata: async () => true,
        } as any

        const result = await applyBrainSessionManualRepairs(store, plan)

        expect(result.applied).toEqual([])
        expect(result.skippedDrifted).toEqual([
            {
                manifestIndex: 0,
                sessionId: target.id,
                namespace: target.namespace,
                reason: 'apply 前发现 permissionMode 已发生漂移，已跳过',
            },
        ])
        expect(setSessionModelConfigCalls).toEqual([])
    })

    test('plan treats reordered brainPreferences keys as noop', () => {
        const targetBrainPreferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childClaudeModels: ['sonnet'],
            childCodexModels: [],
        })
        const reorderedBrainPreferences = {
            childModels: {
                codex: {
                    allowed: [],
                    defaultModel: 'gpt-5.4',
                },
                claude: {
                    allowed: ['sonnet'],
                    defaultModel: 'sonnet',
                },
            },
            machineSelection: {
                mode: 'manual',
                machineId: 'machine-1',
            },
        }
        const target = createStoredSession({
            id: 'brain-reordered-noop',
            metadata: {
                source: 'brain',
                flavor: 'claude',
                brainPreferences: reorderedBrainPreferences,
            },
        })
        const manifest = parseBrainSessionManualRepairManifest({
            version: 1,
            items: [{
                sessionId: target.id,
                action: 'set-brainPreferences',
                brainPreferences: targetBrainPreferences,
            }],
        })
        expect(manifest).not.toBeNull()

        const plan = buildBrainSessionManualRepairPlan([target], manifest!)

        expect(plan.summary).toEqual({
            manifestItems: 1,
            plannedWrites: 0,
            skippedActive: 0,
            skippedNoop: 1,
            rejected: 0,
        })
        expect(plan.skippedNoop).toEqual([
            {
                manifestIndex: 0,
                sessionId: target.id,
                namespace: target.namespace,
                reason: 'brainPreferences 已经与目标值一致',
            },
        ])
    })

    test('apply does not treat reordered brainPreferences keys as drift', async () => {
        const beforeBrainPreferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childClaudeModels: ['sonnet'],
        })
        const reorderedBeforeBrainPreferences = {
            childModels: {
                codex: {
                    allowed: [
                        'gpt-5.4',
                        'gpt-5.4-mini',
                        'gpt-5.3-codex',
                        'gpt-5.3-codex-spark',
                        'gpt-5.2-codex',
                        'gpt-5.2',
                        'gpt-5.1-codex-max',
                        'gpt-5.1-codex-mini',
                    ],
                    defaultModel: 'gpt-5.4',
                },
                claude: {
                    allowed: ['sonnet'],
                    defaultModel: 'sonnet',
                },
            },
            machineSelection: {
                mode: 'manual',
                machineId: 'machine-1',
            },
        }
        const targetBrainPreferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-1',
            childClaudeModels: ['sonnet'],
            childCodexModels: [],
        })
        const target = createStoredSession({
            id: 'brain-reordered-apply',
            metadata: {
                source: 'brain',
                flavor: 'claude',
                brainPreferences: beforeBrainPreferences,
            },
        })
        const manifest = parseBrainSessionManualRepairManifest({
            version: 1,
            items: [{
                sessionId: target.id,
                action: 'set-brainPreferences',
                brainPreferences: targetBrainPreferences,
            }],
        })
        expect(manifest).not.toBeNull()

        const plan = buildBrainSessionManualRepairPlan([target], manifest!)
        const patchSessionMetadataCalls: Array<Record<string, unknown>> = []
        const store = {
            getSession: async () => ({
                ...target,
                metadata: {
                    source: 'brain',
                    flavor: 'claude',
                    brainPreferences: reorderedBeforeBrainPreferences,
                },
            }),
            setSessionModelConfig: async () => true,
            patchSessionMetadata: async (_id: string, patch: Record<string, unknown>) => {
                patchSessionMetadataCalls.push(patch)
                return true
            },
        } as any

        const result = await applyBrainSessionManualRepairs(store, plan)

        expect(result.skippedDrifted).toEqual([])
        expect(result.failed).toEqual([])
        expect(result.applied).toEqual([
            {
                manifestIndex: 0,
                sessionId: target.id,
                namespace: target.namespace,
                action: 'set-brainPreferences',
            },
        ])
        expect(patchSessionMetadataCalls).toEqual([
            {
                brainPreferences: targetBrainPreferences,
            },
        ])
    })
})
