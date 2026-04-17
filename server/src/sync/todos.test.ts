import { describe, expect, test } from 'bun:test'

import { extractTodoWriteTodosFromMessageContent } from './todos'

describe('extractTodoWriteTodosFromMessageContent', () => {
    test('extracts todos from Claude todo_reminder attachments', () => {
        const todos = extractTodoWriteTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'todo_reminder',
                        itemCount: 2,
                        content: [
                            {
                                content: 'Inspect the repo',
                                status: 'completed'
                            },
                            {
                                content: 'Patch the UI',
                                status: 'in_progress',
                                activeForm: 'Patching the UI'
                            }
                        ]
                    }
                }
            }
        })

        expect(todos).toEqual([
            {
                id: 'claude-plan-1',
                content: 'Inspect the repo',
                status: 'completed',
                priority: 'medium'
            },
            {
                id: 'claude-plan-2',
                content: 'Patch the UI',
                status: 'in_progress',
                priority: 'medium'
            }
        ])
    })

    test('ignores empty Claude todo_reminder attachments', () => {
        const todos = extractTodoWriteTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'attachment',
                    attachment: {
                        type: 'todo_reminder',
                        itemCount: 0,
                        content: []
                    }
                }
            }
        })

        expect(todos).toBeNull()
    })
})
