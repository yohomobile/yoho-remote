import { describe, expect, test } from 'bun:test'
import { isRealActivityMessage } from './messageUtils'

describe('isRealActivityMessage', () => {
    test('treats Claude result text as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'result',
                    result: 'Final answer from Claude'
                }
            }
        })).toBe(true)
    })

    test('does not treat empty Claude result as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'result',
                    result: '   '
                }
            }
        })).toBe(false)
    })

    test('treats non-empty Claude todo reminders as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'todo_reminder',
                        content: [{
                            content: 'Inspect the repo',
                            status: 'in_progress'
                        }]
                    }
                }
            }
        })).toBe(true)
    })

    test('does not treat empty Claude todo reminders as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'todo_reminder',
                        content: []
                    }
                }
            }
        })).toBe(false)
    })

    test('treats Claude queued_command attachments as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'queued_command',
                        commandMode: 'task-notification',
                        prompt: 'Background command completed'
                    }
                }
            }
        })).toBe(true)
    })
})
