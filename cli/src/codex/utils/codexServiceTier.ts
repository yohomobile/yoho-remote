import type { CodexCliOverrides } from './codexCliOverrides';

export type CodexServiceTier = 'fast' | 'flex';

export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier = 'fast';

export function resolveCodexServiceTier(
    overrides?: Pick<CodexCliOverrides, 'serviceTier'>
): CodexServiceTier {
    return overrides?.serviceTier ?? DEFAULT_CODEX_SERVICE_TIER;
}

export function buildCodexServiceTierArgs(serviceTier: CodexServiceTier): string[] {
    return ['-c', `service_tier=${serviceTier}`];
}
