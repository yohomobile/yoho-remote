const HIT_LIMIT_RESULT_ERROR_RE = /hit your limit|hit.your.limit/i;
const AUTH_RESULT_ERROR_RE = /does not have access|authentication.*(?:failed|error|invalid)|Failed to authenticate|\b401\b|Invalid.*credentials/i;
const QUOTA_RESULT_ERROR_RE = /\bquota exceeded\b|"code"\s*:\s*"E014"/i;
const RATE_LIMIT_RESULT_ERROR_RE = /\brate limit(?:ed)?\b|too many requests|throttled|temporar(?:ily)? unavailable|"status"\s*:\s*429/i;

type WrappedLimitPayload = {
    status?: unknown;
    error?: {
        code?: unknown;
        message?: unknown;
    } | null;
    message?: unknown;
};

export type ClaudeLimitKind = 'quota_exceeded' | 'rate_limited';

export type ClaudeLimitInfo = {
    kind: ClaudeLimitKind;
    detail: string;
};

export class ClaudeLimitError extends Error {
    readonly kind: ClaudeLimitKind;
    readonly detail: string;

    constructor(info: ClaudeLimitInfo, rawMessage?: string) {
        super(rawMessage ?? info.detail);
        this.name = 'ClaudeLimitError';
        this.kind = info.kind;
        this.detail = info.detail;
    }
}

function normalizeNumericStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        return Number(value);
    }
    return null;
}

function pickWrappedMessage(parsed: WrappedLimitPayload): string | null {
    if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
        return parsed.error.message.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
    }
    return null;
}

export function extractClaudeLimitInfo(text: string): ClaudeLimitInfo | null {
    if (!text) {
        return null;
    }

    const jsonStart = text.indexOf('{');
    const rawPayload = jsonStart >= 0 ? text.slice(jsonStart) : text;

    try {
        const parsed = JSON.parse(rawPayload) as WrappedLimitPayload;
        const detail = pickWrappedMessage(parsed);
        const code = typeof parsed.error?.code === 'string'
            ? parsed.error.code.trim().toUpperCase()
            : null;
        const status = normalizeNumericStatus(parsed.status);

        if (code === 'E014' || /\bquota exceeded\b/i.test(detail ?? '')) {
            return { kind: 'quota_exceeded', detail: detail || 'Quota exceeded' };
        }
        if (status === 429 || HIT_LIMIT_RESULT_ERROR_RE.test(detail ?? '') || RATE_LIMIT_RESULT_ERROR_RE.test(detail ?? '')) {
            return { kind: 'rate_limited', detail: detail || 'Rate limited' };
        }
    } catch {
        // Fall through to regex-based detection below.
    }

    if (QUOTA_RESULT_ERROR_RE.test(text)) {
        return { kind: 'quota_exceeded', detail: 'Quota exceeded' };
    }
    if (HIT_LIMIT_RESULT_ERROR_RE.test(text)) {
        return { kind: 'rate_limited', detail: 'Usage limit reached' };
    }
    if (RATE_LIMIT_RESULT_ERROR_RE.test(text)) {
        return { kind: 'rate_limited', detail: 'Rate limited' };
    }

    return null;
}

export function isLimitResultError(text: string): boolean {
    const limit = extractClaudeLimitInfo(text);
    return limit?.kind === 'rate_limited';
}

export function isWrappedQuotaResultError(text: string): boolean {
    const limit = extractClaudeLimitInfo(text);
    return limit?.kind === 'quota_exceeded';
}

export function isFatalAuthResultError(text: string): boolean {
    if (!text) {
        return false;
    }
    return AUTH_RESULT_ERROR_RE.test(text) && !extractClaudeLimitInfo(text);
}

export function toClaudeLimitError(text: string): ClaudeLimitError | null {
    const info = extractClaudeLimitInfo(text);
    return info ? new ClaudeLimitError(info, text) : null;
}

export function buildClaudeLimitUserMessage(input: ClaudeLimitError | string): string {
    const info = typeof input === 'string'
        ? extractClaudeLimitInfo(input) ?? { kind: 'rate_limited' as const, detail: 'Rate limited' }
        : { kind: input.kind, detail: input.detail };

    if (info.kind === 'quota_exceeded') {
        return `Claude 配额已耗尽（${info.detail}），本次请求未执行成功。请等待额度恢复后重试，或切换到其他有可用额度的账号。`;
    }

    return `Claude 触发临时限流（${info.detail}），本次请求未执行成功。请稍后重试；如果持续出现，请切换到其他账号或稍后再试。`;
}
