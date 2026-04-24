import { describe, expect, it } from 'vitest'

import { buildRuntimeMcpSystemPrompt, systemPrompt } from './systemPrompt'

describe('buildRuntimeMcpSystemPrompt', () => {
    it('describes the detected runtime MCP namespaces and forbids shell-based checks', () => {
        const removedSkillNamespace = 'mcp__' + 'skill__*'
        const prompt = buildRuntimeMcpSystemPrompt([
            'Task',
            'WebFetch',
            'WebSearch',
            'mcp__yoho_remote__environment_info',
            'mcp__yoho_remote__ask_user_question',
            'mcp__yoho-vault__recall',
            'mcp__yoho-vault__skill_list',
            'mcp__yoho-vault__skill_doctor',
            'mcp__yoho-memory__remember',
        ])

        expect(prompt).toContain('Detected ordinary Claude tools in this session: Task, WebFetch, WebSearch.')
        expect(prompt).toContain('mcp__yoho_remote__*')
        expect(prompt).toContain('mcp__yoho-vault__*')
        expect(prompt).toContain('mcp__yoho-memory__*')
        expect(prompt).toContain('which mcp')
        expect(prompt).toContain('claude mcp list')
        expect(prompt).toContain('mcp__yoho_remote__environment_info')
        expect(prompt).toContain('mcp__yoho_remote__ask_user_question')
        expect(prompt).toContain('mcp__yoho-vault__skill_list')
        expect(prompt).toContain('mcp__yoho-vault__skill_doctor')
        expect(prompt).not.toContain(removedSkillNamespace)
        expect(prompt).toContain('skill_list({ path, query })')
        expect(prompt).toContain('candidate/draft/archived/disabled')
        expect(prompt).toContain('skill lifecycle gate')
        expect(prompt).toContain('allowActive=true')
        expect(prompt).toContain('Do not assume a generic "request_user_input" alias exists')
        expect(prompt).toContain('do not assume Bash, Read, Edit, Write, Grep, Glob, Task, Agent, or AskUserQuestion exist')
    })

    it('returns undefined when there are no MCP tools', () => {
        expect(buildRuntimeMcpSystemPrompt(['Task', 'Bash'])).toBeUndefined()
    })

    it('includes explicit subagent prompt injection guidance in the base system prompt', () => {
        expect(systemPrompt).toContain('<yoho-remote-subagent-constraints>')
        expect(systemPrompt).toContain('When you call Agent or Task, prepend the subagent prompt with exactly this block')
        expect(systemPrompt).toContain('Do not rely on the platform to inject those constraints for you')
    })
})
