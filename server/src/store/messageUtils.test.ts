import { describe, expect, test } from 'bun:test'
import { isRealActivityMessage, isTurnStartUserMessage } from './messageUtils'

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

    test('treats valid Claude edited_text_file attachments as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'edited_text_file',
                        filename: '/tmp/demo.ts',
                        snippet: '12\tconst nextValue = 2'
                    }
                }
            }
        })).toBe(true)
    })

    test('does not treat invalid Claude edited_text_file attachments as real activity', () => {
        expect(isRealActivityMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'edited_text_file',
                        filename: '   ',
                        snippet: '   \n'
                    }
                }
            }
        })).toBe(false)
    })
})

describe('isTurnStartUserMessage', () => {
    test('accepts direct text user messages', () => {
        expect(isTurnStartUserMessage({
            role: 'user',
            content: {
                type: 'text',
                text: '继续'
            }
        })).toBe(true)
    })

    test('accepts user content arrays', () => {
        expect(isTurnStartUserMessage({
            role: 'user',
            content: [
                { type: 'text', text: 'say lol' }
            ]
        })).toBe(true)
    })

    test('accepts non-text user blocks that still start a turn', () => {
        expect(isTurnStartUserMessage({
            role: 'user',
            content: [
                { type: 'image' }
            ]
        })).toBe(true)
    })

    test('rejects empty user text payloads', () => {
        expect(isTurnStartUserMessage({
            role: 'user',
            content: {
                type: 'text',
                text: '   '
            }
        })).toBe(false)
    })
})
