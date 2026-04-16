import { describe, expect, test } from 'bun:test'

import {
    shouldRenderAskUserQuestionAsRegularTool,
    shouldRenderAskUserQuestionInteractively,
} from './askUserQuestion'

describe('AskUserQuestion rendering state', () => {
    test('keeps pending questions interactive', () => {
        expect(shouldRenderAskUserQuestionInteractively({
            state: 'pending',
            permission: {
                id: 'tool-1',
                status: 'pending'
            }
        })).toBe(true)

        expect(shouldRenderAskUserQuestionAsRegularTool({
            state: 'pending',
            permission: {
                id: 'tool-1',
                status: 'pending'
            }
        })).toBe(false)
    })

    test('keeps missing-permission running questions interactive while waiting for state sync', () => {
        expect(shouldRenderAskUserQuestionInteractively({
            state: 'running',
            permission: undefined
        })).toBe(true)

        expect(shouldRenderAskUserQuestionAsRegularTool({
            state: 'running',
            permission: undefined
        })).toBe(false)
    })

    test('renders terminal orphan questions as regular tool cards', () => {
        expect(shouldRenderAskUserQuestionInteractively({
            state: 'error',
            permission: undefined
        })).toBe(false)
        expect(shouldRenderAskUserQuestionAsRegularTool({
            state: 'error',
            permission: undefined
        })).toBe(true)

        expect(shouldRenderAskUserQuestionInteractively({
            state: 'completed',
            permission: undefined
        })).toBe(false)
        expect(shouldRenderAskUserQuestionAsRegularTool({
            state: 'completed',
            permission: undefined
        })).toBe(true)
    })
})
