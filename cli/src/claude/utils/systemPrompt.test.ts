import { describe, expect, it } from 'vitest'

import { buildRuntimeMcpSystemPrompt } from './systemPrompt'

describe('buildRuntimeMcpSystemPrompt', () => {
    it('describes the detected runtime MCP namespaces and forbids shell-based checks', () => {
        const prompt = buildRuntimeMcpSystemPrompt([
            'Task',
            'mcp__yoho_remote__environment_info',
            'mcp__yoho-vault__recall',
            'mcp__yoho-memory__remember',
            'mcp__skill__search',
        ])

        expect(prompt).toContain('mcp__yoho_remote__*')
        expect(prompt).toContain('mcp__yoho-vault__*')
        expect(prompt).toContain('mcp__yoho-memory__*')
        expect(prompt).toContain('mcp__skill__*')
        expect(prompt).toContain('which mcp')
        expect(prompt).toContain('claude mcp list')
        expect(prompt).toContain('mcp__yoho_remote__environment_info')
        expect(prompt).toContain('mcp__skill__search')
    })

    it('returns undefined when there are no MCP tools', () => {
        expect(buildRuntimeMcpSystemPrompt(['Task', 'Bash'])).toBeUndefined()
    })
})
