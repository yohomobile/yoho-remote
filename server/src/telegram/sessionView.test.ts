import { describe, expect, it } from 'bun:test'
import { formatSessionNotification } from './sessionView'

describe('formatSessionNotification', () => {
    it('formats Agent tool requests with the same Task label', () => {
        const taskText = formatSessionNotification({
            id: 'session-1',
            metadata: {
                path: '/tmp/project'
            },
            agentState: {
                requests: {
                    req1: {
                        tool: 'Task',
                        arguments: {
                            description: '整理日志'
                        }
                    }
                }
            }
        } as any)

        const agentText = formatSessionNotification({
            id: 'session-1',
            metadata: {
                path: '/tmp/project'
            },
            agentState: {
                requests: {
                    req1: {
                        tool: 'Agent',
                        arguments: {
                            description: '整理日志'
                        }
                    }
                }
            }
        } as any)

        expect(taskText).toContain('Task: 整理日志')
        expect(agentText).toContain('Task: 整理日志')
    })
})
