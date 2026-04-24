import { describe, expect, it } from 'vitest';

import {
    buildCodexBrainChildRuntimeFunctionTools,
    buildCodexConfigOverrides,
    buildCodexRuntimeFunctionTools,
} from './codexRuntimeFunctionTools';

describe('codexRuntimeFunctionTools', () => {
    it('builds runtime function tool names from yoho-remote and auxiliary MCP servers', () => {
        const removedSkillTool = 'functions' + '.skill__search'
        const tools = buildCodexRuntimeFunctionTools({
            yohoRemoteToolNames: ['environment_info', 'change_title', 'session_find_or_create', 'session_abort', 'session_stop', 'session_resume', 'session_set_config'],
            auxServerNames: ['yoho_remote', 'yoho_vault'],
        });

        expect(tools).toContain('functions.yoho_remote__environment_info');
        expect(tools).toContain('functions.yoho_remote__session_find_or_create');
        expect(tools).toContain('functions.yoho_remote__session_abort');
        expect(tools).toContain('functions.yoho_remote__session_stop');
        expect(tools).toContain('functions.yoho_remote__session_resume');
        expect(tools).toContain('functions.yoho_remote__session_set_config');
        expect(tools).toContain('functions.yoho_vault__recall');
        expect(tools).toContain('functions.yoho_vault__skill_promote');
        expect(tools).toContain('functions.yoho_vault__skill_doctor');
        expect(tools).not.toContain(removedSkillTool);
    });

    it('builds a safe brain-child runtime function allowlist', () => {
        const removedSkillTool = 'functions' + '.skill__search'
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
            auxServerNames: ['yoho_remote', 'yoho_vault'],
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
            'functions.yoho_vault__skill_doctor',
            'functions.yoho_vault__skill_get',
            'functions.yoho_vault__skill_list',
            'functions.yoho_vault__skill_search',
        ]);
        expect(tools).not.toContain('functions.yoho_remote__session_send');
        expect(tools).not.toContain('functions.yoho_vault__skill_save');
        expect(tools).not.toContain('functions.yoho_vault__skill_promote');
        expect(tools).not.toContain(removedSkillTool);
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
