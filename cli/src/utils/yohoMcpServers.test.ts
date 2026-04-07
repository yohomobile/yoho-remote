import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getYohoAuxMcpServers, type YohoHttpMcpServerConfig, type YohoStdioMcpServerConfig } from './yohoMcpServers';

const homeDir = process.env.HOME || require('node:os').homedir();
const memoryExists = existsSync(`${homeDir}/happy/yoho-memory/src/mcp/stdio.ts`);
const credentialsExists = existsSync(`${homeDir}/happy/yoho-task-v2/mcp/credentials-server/index.ts`);

describe('getYohoAuxMcpServers', () => {
    it('returns correct server names for Claude', () => {
        const servers = getYohoAuxMcpServers('claude');
        for (const key of Object.keys(servers)) {
            expect(['yoho-memory', 'yoho-credentials']).toContain(key);
        }
    });

    it('returns correct server names for Codex', () => {
        const servers = getYohoAuxMcpServers('codex');
        for (const key of Object.keys(servers)) {
            expect(['yoho_memory', 'yoho_credentials']).toContain(key);
        }
    });

    it('returns stdio config when local paths exist', () => {
        const servers = getYohoAuxMcpServers('claude');
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

    it('falls back to HTTP for Claude when local paths are missing and YOHO_REMOTE_URL is set', () => {
        if (memoryExists && credentialsExists) return; // skip on machines with local paths

        const original = process.env.YOHO_REMOTE_URL;
        process.env.YOHO_REMOTE_URL = 'http://192.168.122.1:3006';
        try {
            const servers = getYohoAuxMcpServers('claude');
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

    it('omits servers for Codex when local paths are missing', () => {
        const servers = getYohoAuxMcpServers('codex');
        if (!memoryExists) {
            expect(servers).not.toHaveProperty('yoho_memory');
        }
        if (!credentialsExists) {
            expect(servers).not.toHaveProperty('yoho_credentials');
        }
    });
});
