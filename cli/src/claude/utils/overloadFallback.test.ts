import { describe, expect, it } from 'vitest';
import type { EnhancedMode } from '@/claude/loop';
import {
    DEFAULT_OPENAI_FALLBACK_MODEL,
    isClaudeOverloadError,
    resolveOpenAiOverloadFallbackMode,
    shouldUseOpenAiOverloadFallback
} from './overloadFallback';

function createMode(overrides: Partial<EnhancedMode> = {}): EnhancedMode {
    return {
        permissionMode: 'bypassPermissions',
        model: 'opus',
        ...overrides
    };
}

describe('overloadFallback', () => {
    describe('shouldUseOpenAiOverloadFallback', () => {
        it('returns true for brain sources', () => {
            expect(shouldUseOpenAiOverloadFallback('brain')).toBe(true);
            expect(shouldUseOpenAiOverloadFallback('brain-child')).toBe(true);
        });

        it('returns false for unrelated sources', () => {
            expect(shouldUseOpenAiOverloadFallback('external-api')).toBe(false);
            expect(shouldUseOpenAiOverloadFallback('legacy-source')).toBe(false);
            expect(shouldUseOpenAiOverloadFallback('')).toBe(false);
            expect(shouldUseOpenAiOverloadFallback(undefined)).toBe(false);
        });
    });

    describe('isClaudeOverloadError', () => {
        it('matches E012/529 overload payload', () => {
            const message = 'API Error: 400 {"error":{"code":"E012","message":"Server overloaded"},"status":529}';
            expect(isClaudeOverloadError(message)).toBe(true);
        });

        it('does not match unrelated errors', () => {
            expect(isClaudeOverloadError('authentication failed: invalid token')).toBe(false);
        });
    });

    describe('resolveOpenAiOverloadFallbackMode', () => {
        it('first sets fallback model', () => {
            const resolved = resolveOpenAiOverloadFallbackMode(
                createMode({ model: 'sonnet' }),
                DEFAULT_OPENAI_FALLBACK_MODEL
            );

            expect(resolved?.strategy).toBe('set_fallback_model');
            expect(resolved?.mode.model).toBe('sonnet');
            expect(resolved?.mode.fallbackModel).toBe(DEFAULT_OPENAI_FALLBACK_MODEL);
        });

        it('then switches primary model when fallback still fails', () => {
            const resolved = resolveOpenAiOverloadFallbackMode(
                createMode({ model: 'sonnet', fallbackModel: DEFAULT_OPENAI_FALLBACK_MODEL }),
                DEFAULT_OPENAI_FALLBACK_MODEL
            );

            expect(resolved?.strategy).toBe('switch_primary_model');
            expect(resolved?.mode.model).toBe(DEFAULT_OPENAI_FALLBACK_MODEL);
            expect(resolved?.mode.fallbackModel).toBeUndefined();
        });

        it('returns null when already using target model', () => {
            const resolved = resolveOpenAiOverloadFallbackMode(
                createMode({ model: DEFAULT_OPENAI_FALLBACK_MODEL }),
                DEFAULT_OPENAI_FALLBACK_MODEL
            );

            expect(resolved).toBe(null);
        });
    });
});
