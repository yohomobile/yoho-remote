import { describe, expect, test } from 'bun:test'

import { shouldRenderExitPlanModeInteractively } from './planMode'

describe('ExitPlanMode rendering state', () => {
    test('keeps pending plan approvals interactive', () => {
        expect(shouldRenderExitPlanModeInteractively({
            state: 'pending',
            permission: {
                id: 'tool-1',
                status: 'pending'
            }
        })).toBe(true)
    })

    test('keeps missing-permission running plan approvals interactive while state sync catches up', () => {
        expect(shouldRenderExitPlanModeInteractively({
            state: 'running',
            permission: undefined
        })).toBe(true)
    })

    test('does not keep terminal orphan plan approvals interactive', () => {
        expect(shouldRenderExitPlanModeInteractively({
            state: 'completed',
            permission: undefined
        })).toBe(false)

        expect(shouldRenderExitPlanModeInteractively({
            state: 'error',
            permission: undefined
        })).toBe(false)
    })
})
