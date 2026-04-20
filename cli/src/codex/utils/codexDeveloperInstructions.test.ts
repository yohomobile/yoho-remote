import { describe, expect, it } from 'vitest';

import {
    buildCodexBrainChildRuntimeFunctionTools,
    buildCodexConfigOverrides,
    buildCodexDeveloperInstructions,
    buildCodexRuntimeFunctionTools,
} from './codexDeveloperInstructions';

describe('codexDeveloperInstructions', () => {
    it('builds runtime function tool names from yoho-remote and auxiliary MCP servers', () => {
        const tools = buildCodexRuntimeFunctionTools({
            yohoRemoteToolNames: ['environment_info', 'change_title', 'session_find_or_create', 'session_abort', 'session_stop', 'session_resume', 'session_set_config'],
            auxServerNames: ['yoho_remote', 'yoho_vault', 'skill'],
        });

        expect(tools).toContain('functions.yoho_remote__environment_info');
        expect(tools).toContain('functions.yoho_remote__session_find_or_create');
        expect(tools).toContain('functions.yoho_remote__session_abort');
        expect(tools).toContain('functions.yoho_remote__session_stop');
        expect(tools).toContain('functions.yoho_remote__session_resume');
        expect(tools).toContain('functions.yoho_remote__session_set_config');
        expect(tools).toContain('functions.yoho_vault__recall');
        expect(tools).toContain('functions.skill__search');
    });

    it('builds a safe brain-child runtime function allowlist', () => {
        const tools = buildCodexBrainChildRuntimeFunctionTools({
            yohoRemoteToolNames: [
                'change_title',
                'push_download',
                'environment_info',
                'project_list',
                'project_create',
                'project_update',
                'project_delete',
                'chat_messages',
                'ask_user_question',
                'session_send',
            ],
            auxServerNames: ['yoho_remote', 'yoho_vault', 'skill'],
        });

        expect(tools).toEqual([
            'functions.yoho_remote__ask_user_question',
            'functions.yoho_remote__change_title',
            'functions.yoho_remote__chat_messages',
            'functions.yoho_remote__environment_info',
            'functions.yoho_remote__project_create',
            'functions.yoho_remote__project_delete',
            'functions.yoho_remote__project_list',
            'functions.yoho_remote__project_update',
            'functions.yoho_remote__push_download',
            'functions.yoho_vault__delete_credential',
            'functions.yoho_vault__get_credential',
            'functions.yoho_vault__list_credentials',
            'functions.yoho_vault__recall',
            'functions.yoho_vault__remember',
            'functions.yoho_vault__session_messages',
            'functions.yoho_vault__session_search',
            'functions.yoho_vault__set_credential',
            'functions.yoho_vault__skill_discover',
            'functions.yoho_vault__skill_get',
            'functions.yoho_vault__skill_list',
            'functions.yoho_vault__skill_search',
        ]);
        expect(tools).not.toContain('functions.yoho_remote__session_send');
        expect(tools).not.toContain('functions.yoho_vault__skill_save');
        expect(tools).not.toContain('functions.skill__search');
    });

    it('builds brain-specific developer instructions', () => {
        const instructions = buildCodexDeveloperInstructions({
            sessionSource: 'brain',
            runtimeFunctionTools: [
                'functions.yoho_remote__ask_user_question',
                'functions.yoho_remote__session_find_or_create',
                'functions.yoho_remote__session_abort',
                'functions.yoho_remote__session_stop',
                'functions.yoho_remote__session_resume',
                'functions.yoho_remote__session_set_config',
                'functions.yoho_remote__session_send',
                'functions.yoho_remote__session_update',
                'functions.yoho_vault__skill_search',
                'functions.skill__search',
            ],
        });

        expect(instructions).toContain('Brain orchestration hub');
        expect(instructions).toContain('functions.yoho_remote__session_find_or_create');
        expect(instructions).toContain('functions.yoho_remote__session_stop');
        expect(instructions).toContain('functions.yoho_remote__session_resume');
        expect(instructions).toContain('functions.yoho_remote__session_set_config');
        expect(instructions).toContain('functions.yoho_remote__session_update');
        expect(instructions).toContain('functions.yoho_remote__ask_user_question');
        expect(instructions).toContain('dense collaboration');
        expect(instructions).toContain('Brain is not a direct coding workstation');
        expect(instructions).toContain('functions.exec_command');
        expect(instructions).toContain('request_user_input');
        expect(instructions).toContain('at least two independent investigation or validation tracks');
        expect(instructions).toContain('Do not create meaningless parallel tracks');
        expect(instructions).toContain('lane 1 = Codex gpt-5.3-codex-spark');
        expect(instructions).toContain('lane 5 = Codex gpt-5.4');
        expect(instructions).toContain('If the hint or task framing clearly signals high complexity');
        expect(instructions).toContain('Brain-child Codex choices are intentionally converged to exactly three models');
        expect(instructions).toContain('do not auto-fallback on failure');
        expect(instructions).toContain('respect that explicit choice');
        expect(instructions).toContain('stop every still-running child session');
        expect(instructions).toContain('end the current turn instead of polling');
        expect(instructions).toContain('does not affect production');
        expect(instructions).toContain('big decisions, direction changes, permissions, or deployment advancement');
        expect(instructions).toContain('Default to 1-3 sentences');
        expect(instructions).toContain('two thorough review passes, two test passes, and two deployment-prep checks');
        expect(instructions).toContain('keep iterating until there is no bug left');
        expect(instructions).toContain('codex mcp list');
        expect(instructions).toContain('generic coding tools');
    });

    it('builds brain-child instructions for the safe helper allowlist', () => {
        const instructions = buildCodexDeveloperInstructions({
            sessionSource: 'brain-child',
            runtimeFunctionTools: [
                'functions.yoho_remote__environment_info',
                'functions.yoho_remote__change_title',
                'functions.yoho_remote__ask_user_question',
                'functions.yoho_vault__recall',
                'functions.yoho_vault__session_search',
            ],
        });

        expect(instructions).toContain('Brain child worker');
        expect(instructions).toContain('functions.yoho_remote__environment_info');
        expect(instructions).toContain('functions.yoho_vault__session_search');
        expect(instructions).toContain('functions.yoho_remote__ask_user_question');
        expect(instructions).toContain('structured user Q&A via functions.yoho_remote__ask_user_question');
        expect(instructions).toContain('request_user_input');
        expect(instructions).toContain('Do not assume session orchestration or cross-session control functions');
        expect(instructions).toContain('tool_suggest');
        expect(instructions).not.toContain('functions.yoho_remote__session_send');
    });

    it('returns restrictive brain config overrides only for brain sessions', () => {
        expect(buildCodexConfigOverrides({ sessionSource: 'user' })).toBeUndefined();
        expect(buildCodexConfigOverrides({ sessionSource: 'brain-child' })).toBeUndefined();
        expect(buildCodexConfigOverrides({ sessionSource: 'brain' })).toEqual({
            features: {
                multi_agent: false,
                shell_tool: false,
            },
            mcp_servers: {
                yoho_remote: {
                    required: true,
                },
            },
            web_search: 'live',
        });
    });
});
