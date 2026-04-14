import { describe, expect, it } from 'vitest';
import { normalizeCodexToolReferences } from './normalizeCodexToolReferences';

describe('normalizeCodexToolReferences', () => {
    it('normalizes Yoho tool namespaces from MCP syntax to Codex functions syntax', () => {
        const normalized = normalizeCodexToolReferences(
            '使用 `mcp__yoho_remote__environment_info`、`mcp__yoho-vault__recall`、`mcp__yoho-memory__remember` 和 `mcp__yoho-credentials__get_credential`'
        );

        expect(normalized).toContain('functions.yoho_remote__environment_info');
        expect(normalized).toContain('functions.yoho_vault__recall');
        expect(normalized).toContain('functions.yoho_memory__remember');
        expect(normalized).toContain('functions.yoho_credentials__get_credential');
    });

    it('supports underscore-based legacy namespaces too', () => {
        const normalized = normalizeCodexToolReferences(
            '使用 `mcp__yoho_vault__skill_search`、`mcp__yoho_memory__recall` 和 `mcp__yoho_credentials__list_credentials`'
        );

        expect(normalized).toContain('functions.yoho_vault__skill_search');
        expect(normalized).toContain('functions.yoho_memory__recall');
        expect(normalized).toContain('functions.yoho_credentials__list_credentials');
    });
});
