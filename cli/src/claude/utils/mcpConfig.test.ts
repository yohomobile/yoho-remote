import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveMcpConfigArg } from './mcpConfig';

describe('resolveMcpConfigArg', () => {
    it('keeps non-sensitive MCP config inline on non-Windows platforms', () => {
        const resolved = resolveMcpConfigArg({
            yoho_remote: {
                type: 'http',
                url: 'http://127.0.0.1:3000/mcp',
            },
        }, { useFile: false });

        expect(resolved.value).toContain('yoho_remote');
        expect(resolved.cleanup).toBeUndefined();
    });

    it('writes sensitive MCP config to a temporary file by default', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'mcp-config-'));
        try {
            const resolved = resolveMcpConfigArg({
                'yoho-vault': {
                    type: 'http',
                    url: 'http://127.0.0.1:3100/mcp',
                    headers: {
                        authorization: 'Bearer secret-token',
                    },
                },
            }, { baseDir: tempDir });

            expect(resolved.value).toContain(tempDir);
            expect(readFileSync(resolved.value, 'utf8')).toContain('Bearer secret-token');
            resolved.cleanup?.();
            expect(existsSync(resolved.value)).toBe(false);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
