import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentEvent } from '@/chat/types'
import { YohoRemoteSystemEvent } from './SystemMessage'

describe('YohoRemoteSystemEvent', () => {
    test('renders a top-level todo-reminder event with structured progress details', () => {
        const event = {
            type: 'todo-reminder',
            items: [
                { content: 'Inspect the repo', status: 'completed' },
                { content: 'Patch the UI', status: 'in_progress', activeForm: 'Patching the UI' }
            ],
            itemCount: 2,
            pendingCount: 0,
            inProgressCount: 1,
            completedCount: 1
        } satisfies AgentEvent

        const html = renderToStaticMarkup(
            <YohoRemoteSystemEvent api={{} as never} messageId="event-todo" event={event} />
        )

        expect(html).toContain('data-message-id="event-todo"')
        expect(html).toContain('Plan progress')
        expect(html).toContain('1/2')
        expect(html).toContain('Inspect the repo')
        expect(html).toContain('Patch the UI')
        expect(html).toContain('Patching the UI')
    })

    test('renders a top-level plan-mode event with visible structured plan details', () => {
        const event = {
            type: 'plan-mode',
            planFilePath: '/tmp/demo-plan.md',
            planExists: false
        } satisfies AgentEvent

        const html = renderToStaticMarkup(
            <YohoRemoteSystemEvent api={{} as never} messageId="event-plan-mode" event={event} />
        )

        expect(html).toContain('Plan mode active')
        expect(html).toContain('Claude is drafting a plan for approval.')
        expect(html).toContain('/tmp/demo-plan.md')
    })

    test('keeps the existing brain-child-callback system card path', () => {
        const event = {
            type: 'brain-child-callback',
            title: '子任务完成',
            details: ['消息数: 5']
        } satisfies AgentEvent

        const html = renderToStaticMarkup(
            <YohoRemoteSystemEvent api={{} as never} messageId="event-brain" event={event} />
        )

        expect(html).toContain('子任务回传')
        expect(html).toContain('子任务完成')
        expect(html).toContain('运行信息 (1)')
    })
})
