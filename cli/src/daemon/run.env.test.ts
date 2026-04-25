import { describe, expect, it } from 'vitest';

import { buildSessionUnitName, sanitizeSpawnEnvForAgent } from './run';

describe('sanitizeSpawnEnvForAgent', () => {
    it('removes inherited Claude token-source env from Codex sessions without Codex token source', () => {
        const env = {
            OPENAI_API_KEY: 'local-openai-key',
            OPENAI_BASE_URL: 'https://api.example.com',
            ANTHROPIC_API_KEY: 'claude-key',
            ANTHROPIC_BASE_URL: 'https://ccproxy.yohomobile.dev',
            YOHO_REMOTE_TOKEN_SOURCE_API_KEY: 'proxy-key',
            YR_TOKEN_SOURCE_ID: 'source-1',
            YR_TOKEN_SOURCE_NAME: 'CCQiao',
            YR_TOKEN_SOURCE_TYPE: 'claude',
            KEEP_ME: '1',
        };

        const removed = sanitizeSpawnEnvForAgent(env, { agent: 'codex', tokenSourceType: 'claude' });

        expect(removed).toEqual(expect.arrayContaining([
            'OPENAI_API_KEY',
            'OPENAI_BASE_URL',
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_BASE_URL',
            'YOHO_REMOTE_TOKEN_SOURCE_API_KEY',
            'YR_TOKEN_SOURCE_ID',
            'YR_TOKEN_SOURCE_NAME',
            'YR_TOKEN_SOURCE_TYPE',
        ]));
        expect(env).toEqual({ KEEP_ME: '1' });
    });

    it('keeps Codex token-source env while still removing Claude-specific env', () => {
        const env = {
            ANTHROPIC_API_KEY: 'claude-key',
            ANTHROPIC_BASE_URL: 'https://ccproxy.yohomobile.dev',
            YOHO_REMOTE_TOKEN_SOURCE_API_KEY: 'codex-proxy-key',
            YR_TOKEN_SOURCE_ID: 'source-1',
            YR_TOKEN_SOURCE_NAME: 'Codex Proxy',
            YR_TOKEN_SOURCE_TYPE: 'codex',
        };

        sanitizeSpawnEnvForAgent(env, { agent: 'codex', tokenSourceType: 'codex' });

        expect(env).toEqual({
            YOHO_REMOTE_TOKEN_SOURCE_API_KEY: 'codex-proxy-key',
            YR_TOKEN_SOURCE_ID: 'source-1',
            YR_TOKEN_SOURCE_NAME: 'Codex Proxy',
            YR_TOKEN_SOURCE_TYPE: 'codex',
        });
    });

    it('only clears Claude OAuth env when claude session uses claude token source', () => {
        const env = {
            ANTHROPIC_AUTH_TOKEN: 'oauth-claude',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-2',
            ANTHROPIC_API_KEY: 'session-key',
            ANTHROPIC_BASE_URL: 'https://ccproxy.example.com',
            YOHO_REMOTE_TOKEN_SOURCE_API_KEY: 'proxy-key',
            YR_TOKEN_SOURCE_ID: 'src-1',
            YR_TOKEN_SOURCE_NAME: 'Claude Proxy',
            YR_TOKEN_SOURCE_TYPE: 'claude',
            CLI_API_TOKEN: 'cli-token',
            YOHO_REMOTE_URL: 'https://yoho.example',
            PATH: '/usr/bin',
            HOME: '/home/guang',
        };

        const removed = sanitizeSpawnEnvForAgent(env, { agent: 'claude', tokenSourceType: 'claude' });

        expect(removed.sort()).toEqual(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].sort());
        expect(env).toMatchObject({
            ANTHROPIC_API_KEY: 'session-key',
            ANTHROPIC_BASE_URL: 'https://ccproxy.example.com',
            YOHO_REMOTE_TOKEN_SOURCE_API_KEY: 'proxy-key',
            YR_TOKEN_SOURCE_ID: 'src-1',
            YR_TOKEN_SOURCE_NAME: 'Claude Proxy',
            YR_TOKEN_SOURCE_TYPE: 'claude',
            CLI_API_TOKEN: 'cli-token',
            YOHO_REMOTE_URL: 'https://yoho.example',
            PATH: '/usr/bin',
            HOME: '/home/guang',
        });
    });

    it('does not strip auth env for claude sessions without a token source', () => {
        const env = {
            ANTHROPIC_AUTH_TOKEN: 'oauth-claude',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-2',
            ANTHROPIC_API_KEY: 'inherit-key',
            CLI_API_TOKEN: 'cli-token',
        };

        const removed = sanitizeSpawnEnvForAgent(env, { agent: 'claude' });

        expect(removed).toEqual([]);
        expect(env).toEqual({
            ANTHROPIC_AUTH_TOKEN: 'oauth-claude',
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-2',
            ANTHROPIC_API_KEY: 'inherit-key',
            CLI_API_TOKEN: 'cli-token',
        });
    });

    it('preserves daemon-critical env (CLI_API_TOKEN, YOHO_REMOTE_URL, PATH, HOME, XDG_RUNTIME_DIR) on every code path', () => {
        const daemonCritical = {
            CLI_API_TOKEN: 'cli-token',
            YOHO_REMOTE_URL: 'https://yoho.example',
            PATH: '/usr/bin:/bin',
            HOME: '/home/guang',
            XDG_RUNTIME_DIR: '/run/user/1000',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
            YOHO_REMOTE_HOME: '/home/guang/.yoho-remote',
        };

        const cases: { agent?: string; tokenSourceType?: 'claude' | 'codex' }[] = [
            { agent: 'codex', tokenSourceType: 'claude' },
            { agent: 'codex', tokenSourceType: 'codex' },
            { agent: 'claude', tokenSourceType: 'claude' },
            { agent: 'claude' },
            {},
        ];

        for (const opts of cases) {
            const env = { ...daemonCritical, ANTHROPIC_AUTH_TOKEN: 'x', OPENAI_API_KEY: 'y' };
            sanitizeSpawnEnvForAgent(env, opts);
            for (const key of Object.keys(daemonCritical)) {
                expect(env, `case=${JSON.stringify(opts)} stripped daemon-critical ${key}`)
                    .toHaveProperty(key, daemonCritical[key as keyof typeof daemonCritical]);
            }
        }
    });
});

describe('buildSessionUnitName', () => {
    it('always returns a non-empty unit name even when sessionId is missing (B1)', () => {
        const placeholder = buildSessionUnitName();
        expect(placeholder).toMatch(/^yr-session-pending-\d+-[0-9a-f]+$/);
    });

    it('uses sanitized sessionId in unit name when provided', () => {
        const explicit = buildSessionUnitName('abc-123_DEF');
        expect(explicit.startsWith('yr-session-abc123DEF-')).toBe(true);
    });

    it('falls back to placeholder when sessionId sanitises to an empty string', () => {
        const fallback = buildSessionUnitName('---');
        expect(fallback).toMatch(/^yr-session-pending-\d+-[0-9a-f]+$/);
    });

    it('produces distinct unit names across calls without sessionId', () => {
        const a = buildSessionUnitName();
        const b = buildSessionUnitName();
        expect(a).not.toBe(b);
    });
});
