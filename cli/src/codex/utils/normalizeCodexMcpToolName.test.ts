import { describe, expect, it } from 'vitest';

import { normalizeCodexMcpToolName } from './normalizeCodexMcpToolName';

describe('normalizeCodexMcpToolName', () => {
    it('canonicalizes yoho ask_user_question for shared permission/UI handling', () => {
        expect(normalizeCodexMcpToolName('yoho_remote', 'ask_user_question')).toBe('ask_user_question');
    });

    it('keeps other MCP tool names namespaced', () => {
        expect(normalizeCodexMcpToolName('yoho_remote', 'change_title')).toBe('yoho_remote__change_title');
        expect(normalizeCodexMcpToolName('yoho_vault', 'recall')).toBe('yoho_vault__recall');
    });
});
