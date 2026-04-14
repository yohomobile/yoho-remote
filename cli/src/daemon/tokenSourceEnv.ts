export function buildClaudeTokenSourceEnv(options: {
    baseUrl: string;
    apiKey: string;
    tokenSourceId?: string;
    tokenSourceName?: string;
}): Record<string, string> {
    return {
        ANTHROPIC_BASE_URL: options.baseUrl,
        // Token Sources are API-key based. Setting ANTHROPIC_AUTH_TOKEN would
        // force Claude CLI down the bearer-token path, which breaks API-key-only proxies.
        ANTHROPIC_API_KEY: options.apiKey,
        YR_TOKEN_SOURCE_ID: options.tokenSourceId ?? '',
        YR_TOKEN_SOURCE_NAME: options.tokenSourceName ?? '',
        YR_TOKEN_SOURCE_TYPE: 'claude',
    };
}
