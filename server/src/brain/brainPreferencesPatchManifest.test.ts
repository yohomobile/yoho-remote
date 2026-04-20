import { describe, expect, test } from 'bun:test'

import type { StoredSession } from '../store/types'
import { buildBrainSessionPreferences } from './brainSessionPreferences'
import { buildBrainPreferencesPatchPlan } from './brainPreferencesPatchManifest'

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

describe('buildBrainPreferencesPatchPlan', () => {
    test('accepts canonical manifest entries for inactive brain and brain-child sessions in dry-run mode', () => {
        const brainSession = createStoredSession({
            id: 'brain-1',
            metadata: { source: 'brain' },
        })
        const brainChildSession = createStoredSession({
            id: 'brain-child-1',
            metadata: { source: 'brain-child', mainSessionId: 'brain-1' },
        })
        const brainPreferences = buildBrainSessionPreferences({
            machineSelectionMode: 'manual',
            machineId: 'machine-9',
            childClaudeModels: ['sonnet'],
            childCodexModels: ['gpt-5.4-mini'],
        })

        expect(buildBrainPreferencesPatchPlan({
            dryRun: true,
            sessions: [brainSession, brainChildSession],
            manifest: {
                'brain-1': brainPreferences,
                'brain-child-1': brainPreferences,
            },
        })).toEqual({
            ok: true,
            dryRun: true,
            entries: [
                {
                    sessionId: 'brain-1',
                    namespace: 'default',
                    source: 'brain',
                    brainPreferences,
                },
                {
                    sessionId: 'brain-child-1',
                    namespace: 'default',
                    source: 'brain-child',
                    brainPreferences,
                },
            ],
            summary: {
                checked: 2,
                accepted: 2,
            },
        })
    })

    test('rejects active sessions even when the manifest entry is canonical', () => {
        const activeBrain = createStoredSession({
            id: 'brain-active',
            active: true,
            activeAt: 1_700_000_000_200,
            metadata: { source: 'brain' },
        })

        expect(buildBrainPreferencesPatchPlan({
            sessions: [activeBrain],
            manifest: {
                'brain-active': buildBrainSessionPreferences({
                    machineSelectionMode: 'auto',
                    machineId: 'machine-1',
                }),
            },
        })).toEqual({
            ok: false,
            dryRun: true,
            errors: [{
                sessionId: 'brain-active',
                code: 'active-session',
                message: 'Session "brain-active" 当前仍是 active，会话运行中禁止应用人工 brainPreferences patch',
            }],
        })
    })

    test('rejects entries with missing canonical fields', () => {
        const brainSession = createStoredSession({
            id: 'brain-missing-field',
            metadata: { source: 'brain' },
        })

        const result = buildBrainPreferencesPatchPlan({
            sessions: [brainSession],
            manifest: {
                'brain-missing-field': {
                    machineSelection: { mode: 'manual', machineId: 'machine-1' },
                    childModels: {
                        claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                        codex: { allowed: ['gpt-5.4-mini'] },
                    },
                },
            },
        })

        expect(result.ok).toBe(false)
        if (result.ok) {
            throw new Error('expected validation failure')
        }
        expect(result.errors).toEqual([
            expect.objectContaining({
                sessionId: 'brain-missing-field',
                code: 'invalid-brainPreferences',
            }),
        ])
        expect(result.errors[0]?.message).toContain('childModels.codex.defaultModel')
    })

    test('rejects entries with unknown child models or extra fields because the schema is canonical-only', () => {
        const brainSession = createStoredSession({
            id: 'brain-unknown-model',
            metadata: { source: 'brain' },
        })

        const result = buildBrainPreferencesPatchPlan({
            sessions: [brainSession],
            manifest: {
                'brain-unknown-model': {
                    machineSelection: { mode: 'manual', machineId: 'machine-1', extra: true },
                    childModels: {
                        claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                        codex: { allowed: ['gpt-6'], defaultModel: 'gpt-6' },
                    },
                },
            },
        })

        expect(result.ok).toBe(false)
        if (result.ok) {
            throw new Error('expected validation failure')
        }
        expect(result.errors).toEqual([
            expect.objectContaining({
                sessionId: 'brain-unknown-model',
                code: 'invalid-brainPreferences',
            }),
        ])
        expect(result.errors[0]?.message).toContain('childModels.codex.allowed.0')
        expect(result.errors[0]?.message).toContain('machineSelection: Unrecognized key: "extra"')
    })

    test('rejects entries with unrecognized machineSelection.mode', () => {
        const brainChildSession = createStoredSession({
            id: 'brain-child-bad-mode',
            metadata: { source: 'brain-child', mainSessionId: 'brain-1' },
        })

        const result = buildBrainPreferencesPatchPlan({
            dryRun: false,
            sessions: [brainChildSession],
            manifest: {
                'brain-child-bad-mode': {
                    machineSelection: { mode: 'sticky', machineId: 'machine-1' },
                    childModels: {
                        claude: { allowed: ['sonnet'], defaultModel: 'sonnet' },
                        codex: { allowed: ['gpt-5.4-mini'], defaultModel: 'gpt-5.4-mini' },
                    },
                },
            },
        })

        expect(result.ok).toBe(false)
        if (result.ok) {
            throw new Error('expected validation failure')
        }
        expect(result.dryRun).toBe(false)
        expect(result.errors).toEqual([
            expect.objectContaining({
                sessionId: 'brain-child-bad-mode',
                code: 'invalid-brainPreferences',
            }),
        ])
        expect(result.errors[0]?.message).toContain('machineSelection.mode')
    })
})
