import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
    existsSync: mocks.existsSync,
}));

import {
    getYohoAuxMcpServers,
    YOHO_MEMORY_MCP_DB_MAX_CONNECTIONS,
    YOHO_MEMORY_REPO_ROOT,
    type YohoStdioMcpServerConfig,
} from './yohoMcpServers';

const vaultEntry = join(YOHO_MEMORY_REPO_ROOT, 'src/mcp/stdio.ts');
const skillEntry = join(YOHO_MEMORY_REPO_ROOT, 'src/mcp/skill-stdio.ts');

function mockExistingPaths(paths: string[]): void {
    const existing = new Set(paths);
    mocks.existsSync.mockImplementation((path: unknown) => typeof path === 'string' && existing.has(path));
}

describe('getYohoAuxMcpServers', () => {
    beforeEach(() => {
        mocks.existsSync.mockReset();
        mockExistingPaths([vaultEntry, skillEntry]);
    });

    it('returns fixed-path stdio servers for Codex', async () => {
        const servers = await getYohoAuxMcpServers('codex');

        expect(Object.keys(servers).sort()).toEqual(['skill', 'yoho_vault']);
        expect(servers.yoho_vault).toMatchObject({
            command: 'bun',
            args: ['run', vaultEntry],
            cwd: YOHO_MEMORY_REPO_ROOT,
        });
        expect(servers.skill).toMatchObject({
            command: 'bun',
            args: ['run', skillEntry],
            cwd: YOHO_MEMORY_REPO_ROOT,
        });
    });

    it('returns the Claude vault name from the same fixed path', async () => {
        mockExistingPaths([vaultEntry]);

        const servers = await getYohoAuxMcpServers('claude');

        expect(Object.keys(servers)).toEqual(['yoho-vault']);
        expect(servers['yoho-vault']).toMatchObject({
            command: 'bun',
            args: ['run', vaultEntry],
            cwd: YOHO_MEMORY_REPO_ROOT,
        });
        expect(servers).not.toHaveProperty('skill');
    });

    it('passes orgId as YOHO_ORG_ID env', async () => {
        const servers = await getYohoAuxMcpServers('codex', {
            orgId: 'test-org-id',
        });

        const cfg = servers.yoho_vault as YohoStdioMcpServerConfig;
        expect(cfg.env?.YOHO_ORG_ID).toBe('test-org-id');
    });

    it('caps yoho-memory MCP DB pools for every spawned session', async () => {
        const servers = await getYohoAuxMcpServers('codex');

        expect(servers.yoho_vault?.env?.DB_MAX_CONNECTIONS).toBe(YOHO_MEMORY_MCP_DB_MAX_CONNECTIONS);
        expect(servers.skill?.env?.DB_MAX_CONNECTIONS).toBe(YOHO_MEMORY_MCP_DB_MAX_CONNECTIONS);
    });

    it('does not use YOHO_MEMORY_PATH, Project list, or working-directory fallbacks', async () => {
        const originalMemoryPath = process.env.YOHO_MEMORY_PATH;
        const getProjects = vi.fn().mockResolvedValue([]);
        process.env.YOHO_MEMORY_PATH = '/tmp/another-yoho-memory';

        try {
            const servers = await getYohoAuxMcpServers('codex', {
                apiClient: { getProjects },
                sessionId: 'session-123',
                workingDirectory: '/tmp/workspace/repos/app',
            } as never);

            expect(getProjects).not.toHaveBeenCalled();
            expect(servers.yoho_vault?.cwd).toBe(YOHO_MEMORY_REPO_ROOT);
            expect(servers.yoho_vault?.args).toEqual(['run', vaultEntry]);
        } finally {
            if (originalMemoryPath !== undefined) process.env.YOHO_MEMORY_PATH = originalMemoryPath;
            else delete process.env.YOHO_MEMORY_PATH;
        }
    });

    it('does not create an HTTP fallback when the fixed local entry is missing', async () => {
        const originalRemoteUrl = process.env.YOHO_REMOTE_URL;
        const originalMemoryToken = process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN;
        const originalBridgeToken = process.env.YR_HTTP_MCP_AUTH_TOKEN;
        mockExistingPaths([]);
        process.env.YOHO_REMOTE_URL = 'http://192.168.122.1:3006';
        process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN = 'memory-token';
        process.env.YR_HTTP_MCP_AUTH_TOKEN = 'bridge-token';

        try {
            const servers = await getYohoAuxMcpServers('claude', {
                orgId: 'test-org-id',
            });

            expect(servers).toEqual({});
        } finally {
            if (originalRemoteUrl !== undefined) process.env.YOHO_REMOTE_URL = originalRemoteUrl;
            else delete process.env.YOHO_REMOTE_URL;
            if (originalMemoryToken !== undefined) process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN = originalMemoryToken;
            else delete process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN;
            if (originalBridgeToken !== undefined) process.env.YR_HTTP_MCP_AUTH_TOKEN = originalBridgeToken;
            else delete process.env.YR_HTTP_MCP_AUTH_TOKEN;
        }
    });
});
