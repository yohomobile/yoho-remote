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

    test('extracts todos from legacy TodoWrite tool calls', () => {
        const todos = extractTodoWriteTodosFromMessageContent({
            role: 'assistant',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'TodoWrite',
                    callId: 'todo-call-1',
                    input: {
                        todos: [
                            {
                                id: 'todo-1',
                                content: 'Inspect the repo',
                                status: 'completed',
                                priority: 'high',
                            },
                            {
                                id: 'todo-2',
                                content: 'Patch the UI',
                                status: 'in_progress',
                                priority: 'medium',
                            },
                        ]
                    },
                    id: 'todo-tool-call-1',
                }
            }
        })

        expect(todos).toEqual([
            {
                id: 'todo-1',
                content: 'Inspect the repo',
                status: 'completed',
                priority: 'high'
            },
            {
                id: 'todo-2',
                content: 'Patch the UI',
                status: 'in_progress',
                priority: 'medium'
            }
        ])
    })

    test('extracts todos from CodexPlan tool-call payloads', () => {
        const todos = extractTodoWriteTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call',
                    name: 'CodexPlan',
                    callId: 'plan-call-1',
                    input: {
                        plan: [
                            {
                                step: 'Inspect the repo',
                                status: 'completed',
                            },
                            {
                                step: 'Patch the UI',
                                status: 'in_progress',
                            },
                        ]
                    },
                    id: 'plan-tool-call-1',
                }
            }
        })

        expect(todos).toEqual([
            {
                id: 'plan-1',
                content: 'Inspect the repo',
                status: 'completed',
                priority: 'medium'
            },
            {
                id: 'plan-2',
                content: 'Patch the UI',
                status: 'in_progress',
                priority: 'medium'
            }
        ])
    })

    test('extracts todos from CodexPlan tool-call-result payloads', () => {
        const todos = extractTodoWriteTodosFromMessageContent({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    name: 'CodexPlan',
                    callId: 'plan-call-1',
                    output: {
                        plan: [
                            {
                                content: 'Update the route',
                                status: 'pending',
                            },
                        ]
                    },
                    id: 'plan-tool-result-1',
                }
            }
        })

        expect(todos).toEqual([
            {
                id: 'plan-1',
                content: 'Update the route',
                status: 'pending',
                priority: 'medium'
            }
        ])
    })

    test('extracts todos from legacy ACP plan payloads', () => {
        const todos = extractTodoWriteTodosFromMessageContent({
            role: 'assistant',
            content: {
                type: 'codex',
                data: {
                    type: 'plan',
                    entries: [
                        {
                            content: 'Inspect sync logs',
                            status: 'completed',
                            priority: 'high',
                            id: 'legacy-plan-1',
                        },
                        {
                            content: 'Patch retry loop',
                            status: 'in_progress',
                            priority: 'medium',
                        },
                    ]
                }
            }
        })

        expect(todos).toEqual([
            {
                id: 'legacy-plan-1',
                content: 'Inspect sync logs',
                status: 'completed',
                priority: 'high'
            },
            {
                id: 'plan-2',
                content: 'Patch retry loop',
                status: 'in_progress',
                priority: 'medium'
            }
        ])
    })
})
