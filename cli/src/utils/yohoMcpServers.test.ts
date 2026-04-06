import { describe, expect, it } from 'vitest';
import { getYohoAuxMcpServers } from './yohoMcpServers';

describe('getYohoAuxMcpServers', () => {
    it('uses Claude MCP aliases for Claude sessions', () => {
        const servers = getYohoAuxMcpServers('claude');

        expect(Object.keys(servers)).toEqual(['yoho-memory', 'yoho-credentials']);
        expect(servers['yoho-memory']).toMatchObject({
            command: 'bun',
            cwd: expect.stringContaining('/happy/yoho-memory'),
        });
        expect(servers['yoho-credentials']).toMatchObject({
            command: 'bun',
            cwd: expect.stringContaining('/happy/yoho-task-v2/mcp/credentials-server'),
        });
    });

    it('uses Codex-safe MCP aliases for Codex sessions', () => {
        const servers = getYohoAuxMcpServers('codex');

        expect(Object.keys(servers)).toEqual(['yoho_memory', 'yoho_credentials']);
        expect(servers.yoho_memory.env?.PATH).toContain('/.bun/bin');
        expect(servers.yoho_credentials.env?.PATH).toContain('/.bun/bin');
    });
});
