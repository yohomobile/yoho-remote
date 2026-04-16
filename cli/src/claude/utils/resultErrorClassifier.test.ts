import { describe, expect, it } from 'vitest';
import {
    buildClaudeLimitUserMessage,
    ClaudeLimitError,
    extractClaudeLimitInfo,
    isFatalAuthResultError,
    toClaudeLimitError
} from './resultErrorClassifier';

describe('resultErrorClassifier', () => {
    describe('extractClaudeLimitInfo', () => {
        it('classifies wrapped quota payloads as quota_exceeded', () => {
            const message = 'Failed to authenticate. API Error: 403 {"error":{"code":"E014","message":"Quota exceeded"},"status":429}';
            expect(extractClaudeLimitInfo(message)).toEqual({
                kind: 'quota_exceeded',
                detail: 'Quota exceeded'
            });
        });

        it('classifies hit-your-limit text as rate_limited', () => {
            expect(extractClaudeLimitInfo('You hit your limit.')).toEqual({
                kind: 'rate_limited',
                detail: 'Usage limit reached'
            });
        });

        it('classifies generic wrapped 429 errors as rate_limited', () => {
            const message = 'Failed to authenticate. API Error: 403 {"error":{"message":"rate limited"},"status":429}';
            expect(extractClaudeLimitInfo(message)).toEqual({
                kind: 'rate_limited',
                detail: 'rate limited'
            });
        });

        it('ignores plain auth failures', () => {
            expect(extractClaudeLimitInfo('Failed to authenticate. API Error: 401 invalid token')).toBe(null);
        });
    });

    describe('isFatalAuthResultError', () => {
        it('matches real auth failures', () => {
            expect(isFatalAuthResultError('Failed to authenticate. API Error: 401 invalid token')).toBe(true);
        });

        it('does not treat quota failures as auth errors', () => {
            const message = 'Failed to authenticate. API Error: 403 {"error":{"code":"E014","message":"Quota exceeded"},"status":429}';
            expect(isFatalAuthResultError(message)).toBe(false);
        });

        it('does not treat temporary rate limits as auth errors', () => {
            const message = 'Failed to authenticate. API Error: 403 {"error":{"message":"rate limited"},"status":429}';
            expect(isFatalAuthResultError(message)).toBe(false);
        });
    });

    describe('toClaudeLimitError', () => {
        it('creates a typed quota error', () => {
            const error = toClaudeLimitError('Failed to authenticate. API Error: 403 {"error":{"code":"E014","message":"Quota exceeded"},"status":429}');
            expect(error).toBeInstanceOf(ClaudeLimitError);
            expect(error?.kind).toBe('quota_exceeded');
            expect(error?.detail).toBe('Quota exceeded');
        });
    });

    describe('buildClaudeLimitUserMessage', () => {
        it('formats a clear quota-exceeded message', () => {
            const error = new ClaudeLimitError({ kind: 'quota_exceeded', detail: 'Quota exceeded' });
            expect(buildClaudeLimitUserMessage(error)).toContain('Claude 配额已耗尽');
            expect(buildClaudeLimitUserMessage(error)).toContain('Quota exceeded');
        });

        it('formats a clear temporary rate-limit message', () => {
            const error = new ClaudeLimitError({ kind: 'rate_limited', detail: 'rate limited' });
            expect(buildClaudeLimitUserMessage(error)).toContain('Claude 触发临时限流');
            expect(buildClaudeLimitUserMessage(error)).toContain('rate limited');
        });
    });
});
