import { describe, expect, it } from 'vitest';

import { __testOnly } from './codexRemoteLauncher';

describe('codexRemoteLauncher', () => {
    it('canonicalizes yoho ask_user_question tool names in MCP events', () => {
        expect(__testOnly.getNormalizedMcpToolCallName({
            server: 'yoho_remote',
            tool: 'ask_user_question',
        })).toBe('ask_user_question');

        expect(__testOnly.getNormalizedMcpToolCallName({
            server: 'yoho_remote',
            tool: 'change_title',
        })).toBe('yoho_remote__change_title');
    });
});
