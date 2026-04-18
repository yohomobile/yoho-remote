import { describe, expect, it } from 'vitest';

import {
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

    it('builds brain-specific developer instructions', () => {
        const instructions = buildCodexDeveloperInstructions({
            sessionSource: 'brain',
            runtimeFunctionTools: [
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
        expect(instructions).toContain('dense collaboration');
        expect(instructions).toContain('at least two independent investigation or validation tracks');
        expect(instructions).toContain('Do not create meaningless parallel tracks');
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

    it('returns restrictive brain config overrides only for brain sessions', () => {
        expect(buildCodexConfigOverrides({ sessionSource: 'user' })).toBeUndefined();
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
