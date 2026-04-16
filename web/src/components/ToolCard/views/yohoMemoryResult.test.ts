import { describe, expect, test } from 'bun:test'
import { extractYohoMemoryDisplayData } from './_results'

describe('extractYohoMemoryDisplayData', () => {
    test('renders recall answer as markdown and keeps the rest as structured json', () => {
        const result = {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    answer: '## 搜索结果\n- 第一条\n- 第二条',
                    sources: ['memories/a.md', 'memories/b.md'],
                    keywords: ['yoho-remote', 'recall'],
                    filesSearched: 2
                })
            }]
        }

        const display = extractYohoMemoryDisplayData(result)

        expect(display.markdownSections).toEqual([
            {
                key: 'answer',
                label: 'Answer',
                text: '## 搜索结果\n- 第一条\n- 第二条'
            }
        ])
        expect(display.jsonValue).toEqual({
            sources: ['memories/a.md', 'memories/b.md'],
            keywords: ['yoho-remote', 'recall'],
            filesSearched: 2
        })
    })

    test('renders remember message as markdown and pretty-prints remaining json', () => {
        const result = JSON.stringify({
            status: 'accepted',
            message: 'Memory save started in **background**.'
        })

        const display = extractYohoMemoryDisplayData(result)

        expect(display.markdownSections).toEqual([
            {
                key: 'message',
                label: 'Message',
                text: 'Memory save started in **background**.'
            }
        ])
        expect(display.jsonValue).toEqual({
            status: 'accepted'
        })
    })

    test('supports nested markdown fields for yoho memory results', () => {
        const result = {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    status: 'in_progress',
                    checks: '- 第一项\n- 第二项',
                    current_step: {
                        index: 2,
                        content: '**执行部署**：确认回滚步骤并上线'
                    }
                })
            }]
        }

        const display = extractYohoMemoryDisplayData(result)

        expect(display.markdownSections).toEqual([
            {
                key: 'checks',
                label: 'Checks',
                text: '- 第一项\n- 第二项'
            },
            {
                key: 'current_step.content',
                label: 'Current Step',
                text: '**执行部署**：确认回滚步骤并上线'
            }
        ])
        expect(display.jsonValue).toEqual({
            status: 'in_progress',
            current_step: {
                index: 2
            }
        })
    })
})
