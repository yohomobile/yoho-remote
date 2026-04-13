import { describe, expect, it } from 'vitest';
import {
    buildCodexServiceTierArgs,
    DEFAULT_CODEX_SERVICE_TIER,
    resolveCodexServiceTier
} from './codexServiceTier';

describe('codexServiceTier', () => {
    it('defaults Codex service tier to fast', () => {
        expect(DEFAULT_CODEX_SERVICE_TIER).toBe('fast');
        expect(resolveCodexServiceTier()).toBe('fast');
    });

    it('formats Codex CLI args for service tier overrides', () => {
        expect(buildCodexServiceTierArgs('fast')).toEqual(['-c', 'service_tier=fast']);
        expect(buildCodexServiceTierArgs('flex')).toEqual(['-c', 'service_tier=flex']);
    });

    it('prefers explicit service tier overrides', () => {
        expect(resolveCodexServiceTier({ serviceTier: 'flex' })).toBe('flex');
    });
});
