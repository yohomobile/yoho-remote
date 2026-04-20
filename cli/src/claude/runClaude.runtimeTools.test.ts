import { describe, expect, it } from 'vitest'

import { resolveEffectiveRuntimeTools } from './runClaude'

describe('resolveEffectiveRuntimeTools', () => {
    it('preserves an explicit empty allowlist instead of falling back to discovered tools', () => {
        expect(resolveEffectiveRuntimeTools({
            allowedTools: [],
            discoveredTools: ['Bash', 'Read', 'mcp__yoho_remote__environment_info'],
        })).toEqual([])
    })

    it('intersects an explicit allowlist with discovered runtime tools', () => {
        expect(resolveEffectiveRuntimeTools({
            allowedTools: ['Read', 'mcp__yoho_remote__environment_info', 'Write'],
            discoveredTools: ['Read', 'mcp__yoho_remote__environment_info', 'Bash'],
        })).toEqual(['Read', 'mcp__yoho_remote__environment_info'])
    })

    it('falls back to discovered tools when no explicit allowlist is present', () => {
        expect(resolveEffectiveRuntimeTools({
            discoveredTools: ['Bash', 'mcp__yoho_remote__project_list'],
        })).toEqual(['Bash', 'mcp__yoho_remote__project_list'])
    })
})
