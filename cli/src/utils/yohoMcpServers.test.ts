import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { getYohoAuxMcpServers, type YohoHttpMcpServerConfig, type YohoStdioMcpServerConfig } from './yohoMcpServers';

const homeDir = process.env.HOME || require('node:os').homedir();
const memoryExists = existsSync(`${homeDir}/happy/yoho-memory/src/mcp/stdio.ts`);
const credentialsExists = existsSync(`${homeDir}/happy/yoho-task-v2/mcp/credentials-server/index.ts`);

describe('getYohoAuxMcpServers', () => {
    it('returns correct server names for Claude', async () => {
        const servers = await getYohoAuxMcpServers('claude');
        for (const key of Object.keys(servers)) {
            expect(['yoho-memory', 'yoho-credentials']).toContain(key);
        }
    });

    it('returns correct server names for Codex', async () => {
        const servers = await getYohoAuxMcpServers('codex');
        for (const key of Object.keys(servers)) {
            expect(['yoho_memory', 'yoho_credentials']).toContain(key);
        }
    });

    it('returns stdio config when local paths exist', async () => {
        const servers = await getYohoAuxMcpServers('claude');
        if (memoryExists) {
            const cfg = servers['yoho-memory'] as YohoStdioMcpServerConfig;
            expect(cfg.command).toBe('bun');
            expect(cfg.cwd).toContain('/happy/yoho-memory');
        }
        if (credentialsExists) {
            const cfg = servers['yoho-credentials'] as YohoStdioMcpServerConfig;
            expect(cfg.command).toBe('bun');
            expect(cfg.cwd).toContain('/happy/yoho-task-v2/mcp/credentials-server');
        }
    });

    it('falls back to HTTP for Claude when local paths are missing and YOHO_REMOTE_URL is set', async () => {
        if (memoryExists && credentialsExists) return; // skip on machines with local paths

        const original = process.env.YOHO_REMOTE_URL;
        process.env.YOHO_REMOTE_URL = 'http://192.168.122.1:3006';
        try {
            const servers = await getYohoAuxMcpServers('claude');
            if (!memoryExists) {
                const cfg = servers['yoho-memory'] as YohoHttpMcpServerConfig;
                expect(cfg.type).toBe('http');
                expect(cfg.url).toContain(':3100/mcp');
            }
            if (!credentialsExists) {
                const cfg = servers['yoho-credentials'] as YohoHttpMcpServerConfig;
                expect(cfg.type).toBe('http');
                expect(cfg.url).toContain(':3101/mcp');
            }
        } finally {
            if (original !== undefined) process.env.YOHO_REMOTE_URL = original;
            else delete process.env.YOHO_REMOTE_URL;
        }
    });

    it('omits servers for Codex when local paths are missing', async () => {
        const servers = await getYohoAuxMcpServers('codex');
        if (!memoryExists) {
            expect(servers).not.toHaveProperty('yoho_memory');
        }
        if (!credentialsExists) {
            expect(servers).not.toHaveProperty('yoho_credentials');
        }
    });

    it('resolves yoho-memory from Project list when configured there', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'yoho-memory-project-'));
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

            const cfg = servers.yoho_memory as YohoStdioMcpServerConfig;
            expect(cfg.command).toBe('bun');
            expect(cfg.cwd).toBe(repoRoot);
            expect(cfg.args).toEqual(['run', join(repoRoot, 'src', 'mcp', 'stdio.ts')]);
        } finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
