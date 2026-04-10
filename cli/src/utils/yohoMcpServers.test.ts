import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { getYohoAuxMcpServers, type YohoHttpMcpServerConfig, type YohoStdioMcpServerConfig } from './yohoMcpServers';

const homeDir = process.env.HOME || require('node:os').homedir();
const vaultExists = existsSync(`${homeDir}/happy/yoho-memory/src/mcp/stdio.ts`);

describe('getYohoAuxMcpServers', () => {
    it('returns correct server names for Claude', async () => {
        const servers = await getYohoAuxMcpServers('claude');
        for (const key of Object.keys(servers)) {
            expect(['yoho-vault']).toContain(key);
        }
    });

    it('returns correct server names for Codex', async () => {
        const servers = await getYohoAuxMcpServers('codex');
        for (const key of Object.keys(servers)) {
            expect(['yoho_vault']).toContain(key);
        }
    });

    it('returns stdio config when local path exists', async () => {
        const servers = await getYohoAuxMcpServers('claude');
        if (vaultExists) {
            const cfg = servers['yoho-vault'] as YohoStdioMcpServerConfig;
            expect(cfg.command).toBe('bun');
            expect(cfg.cwd).toContain('/happy/yoho-memory');
        }
    });

    it('falls back to HTTP for Claude when local path is missing and YOHO_REMOTE_URL is set', async () => {
        if (vaultExists) return; // skip on machines with local path

        const original = process.env.YOHO_REMOTE_URL;
        process.env.YOHO_REMOTE_URL = 'http://192.168.122.1:3006';
        try {
            const servers = await getYohoAuxMcpServers('claude');
            if (!vaultExists) {
                const cfg = servers['yoho-vault'] as YohoHttpMcpServerConfig;
                expect(cfg.type).toBe('http');
                expect(cfg.url).toContain(':3100/mcp');
            }
        } finally {
            if (original !== undefined) process.env.YOHO_REMOTE_URL = original;
            else delete process.env.YOHO_REMOTE_URL;
        }
    });

    it('omits vault server for Codex when local path is missing', async () => {
        const servers = await getYohoAuxMcpServers('codex');
        if (!vaultExists) {
            expect(servers).not.toHaveProperty('yoho_vault');
        }
    });

    it('resolves vault from Project list when registered as YohoVault or YohoMemory', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'yoho-vault-project-'));
        const repoRoot = join(tempRoot, 'yoho-memory');
        const entryPath = join(repoRoot, 'src', 'mcp');
        mkdirSync(entryPath, { recursive: true });
        writeFileSync(join(entryPath, 'stdio.ts'), 'console.log("ok")\n');

        try {
            const servers = await getYohoAuxMcpServers('codex', {
                apiClient: {
                    getProjects: vi.fn().mockResolvedValue([
                        { name: 'YohoMemory', path: repoRoot }
                    ])
                },
                sessionId: 'session-123'
            });

            const cfg = servers.yoho_vault as YohoStdioMcpServerConfig;
            expect(cfg.command).toBe('bun');
            expect(cfg.cwd).toBe(repoRoot);
            expect(cfg.args).toEqual(['run', join(repoRoot, 'src', 'mcp', 'stdio.ts')]);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('passes orgId as YOHO_ORG_ID env when provided (stdio)', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'yoho-vault-org-'));
        const repoRoot = join(tempRoot, 'yoho-vault');
        const entryPath = join(repoRoot, 'src', 'mcp');
        mkdirSync(entryPath, { recursive: true });
        writeFileSync(join(entryPath, 'stdio.ts'), 'console.log("ok")\n');

        try {
            const servers = await getYohoAuxMcpServers('codex', {
                apiClient: {
                    getProjects: vi.fn().mockResolvedValue([
                        { name: 'YohoVault', path: repoRoot }
                    ])
                },
                sessionId: 'session-123',
                orgId: 'test-org-id',
            });

            const cfg = servers.yoho_vault as YohoStdioMcpServerConfig;
            expect(cfg.env?.YOHO_ORG_ID).toBe('test-org-id');
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
