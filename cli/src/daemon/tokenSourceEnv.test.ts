import { describe, expect, it } from 'vitest';

import { buildClaudeTokenSourceEnv } from './tokenSourceEnv';

describe('buildClaudeTokenSourceEnv', () => {
    it('uses API key semantics for Claude token sources', () => {
        const env = buildClaudeTokenSourceEnv({
            baseUrl: 'https://ccproxy.yohomobile.dev',
            apiKey: 'rk_test_key',
            tokenSourceId: 'source-1',
            tokenSourceName: 'CCQiao',
        });

        expect(env).toMatchObject({
            ANTHROPIC_BASE_URL: 'https://ccproxy.yohomobile.dev',
            ANTHROPIC_API_KEY: 'rk_test_key',
            YR_TOKEN_SOURCE_ID: 'source-1',
            YR_TOKEN_SOURCE_NAME: 'CCQiao',
            YR_TOKEN_SOURCE_TYPE: 'claude',
        });
        expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    });
});
