import { describe, expect, it } from 'vitest'

import { buildRuntimeMcpSystemPrompt } from './systemPrompt'

describe('buildRuntimeMcpSystemPrompt', () => {
    it('describes the detected runtime MCP namespaces and forbids shell-based checks', () => {
        const prompt = buildRuntimeMcpSystemPrompt([
            'Task',
            'WebFetch',
            'WebSearch',
            'mcp__yoho_remote__environment_info',
            'mcp__yoho_remote__ask_user_question',
            'mcp__yoho-vault__recall',
            'mcp__yoho-memory__remember',
            'mcp__skill__search',
        ])

        expect(prompt).toContain('Detected ordinary Claude tools in this session: Task, WebFetch, WebSearch.')
        expect(prompt).toContain('mcp__yoho_remote__*')
        expect(prompt).toContain('mcp__yoho-vault__*')
        expect(prompt).toContain('mcp__yoho-memory__*')
        expect(prompt).toContain('mcp__skill__*')
        expect(prompt).toContain('which mcp')
        expect(prompt).toContain('claude mcp list')
        expect(prompt).toContain('mcp__yoho_remote__environment_info')
        expect(prompt).toContain('mcp__yoho_remote__ask_user_question')
        expect(prompt).toContain('mcp__skill__search')
        expect(prompt).toContain('Do not assume a generic "request_user_input" alias exists')
        expect(prompt).toContain('do not assume Bash, Read, Edit, Write, Grep, Glob, Task, Agent, or AskUserQuestion exist')
    })

    it('returns undefined when there are no MCP tools', () => {
        expect(buildRuntimeMcpSystemPrompt(['Task', 'Bash'])).toBeUndefined()
    })
})
