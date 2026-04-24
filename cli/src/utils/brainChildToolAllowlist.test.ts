import { describe, expect, it } from 'vitest'

import {
    buildBrainChildClaudeAllowedTools,
    buildBrainChildCodexFunctionTools,
} from './brainChildToolAllowlist'

describe('brainChildToolAllowlist', () => {
    it('builds the expanded Codex brain-child yoho tool set without session tools', () => {
        const tools = buildBrainChildCodexFunctionTools({
            yohoRemoteToolNames: [
                'change_title',
                'environment_info',
                'push_download',
                'project_list',
                'project_create',
                'project_update',
                'project_delete',
                'chat_messages',
                'session_search',
                'ask_user_question',
                'session_send',
            ],
            auxServerNames: ['yoho_remote', 'yoho_vault'],
            includeInteractionTools: true,
        })

        expect(tools).toContain('functions.yoho_remote__chat_messages')
        expect(tools).toContain('functions.yoho_remote__session_search')
        expect(tools).toContain('functions.yoho_remote__ask_user_question')
        expect(tools).toContain('functions.yoho_remote__project_create')
        expect(tools).toContain('functions.yoho_vault__get_credential')
        expect(tools).toContain('functions.yoho_vault__session_messages')
        expect(tools).toContain('functions.yoho_vault__skill_doctor')
        expect(tools).not.toContain('functions.yoho_remote__session_send')
    })

    it('builds the Claude brain-child MCP allowlist with structured Q&A support', () => {
        const tools = buildBrainChildClaudeAllowedTools({
            yohoRemoteToolNames: [
                'change_title',
                'environment_info',
                'push_download',
                'project_list',
                'project_create',
                'project_update',
                'project_delete',
                'chat_messages',
                'session_search',
                'ask_user_question',
                'session_send',
            ],
            sessionCaller: 'webapp',
            includeInteractionTools: true,
        })

        expect(tools).toContain('AskUserQuestion')
        expect(tools).toContain('mcp__yoho_remote__chat_messages')
        expect(tools).toContain('mcp__yoho_remote__session_search')
        expect(tools).toContain('mcp__yoho_remote__ask_user_question')
        expect(tools).toContain('mcp__yoho-vault__skill_search')
        expect(tools).toContain('mcp__yoho-vault__skill_doctor')
        expect(tools).toContain('mcp__yoho-vault__get_credential')
        expect(tools).not.toContain('mcp__yoho_remote__session_send')
        expect(tools).not.toContain('Agent')
        expect(tools).not.toContain('Task')
        expect(tools).not.toContain('ExitPlanMode')
    })
})
