export type LLMErrorContext = {
    statusCode?: number
    requestId?: string | null
    finishReason?: string | null
    provider?: string | null
    model?: string | null
    code?: string | null
}

function normalizeErrorContext(context?: number | LLMErrorContext): LLMErrorContext {
    if (typeof context === 'number') {
        return { statusCode: context }
    }

    return context ?? {}
}

export class PermanentLLMError extends Error {
    readonly statusCode?: number
    readonly requestId: string | null
    readonly finishReason: string | null
    readonly provider: string | null
    readonly model: string | null
    readonly code: string | null

    constructor(message: string, context?: number | LLMErrorContext) {
        super(message)
        this.name = 'PermanentLLMError'
        const normalized = normalizeErrorContext(context)
        this.statusCode = normalized.statusCode
        this.requestId = normalized.requestId ?? null
        this.finishReason = normalized.finishReason ?? null
        this.provider = normalized.provider ?? null
        this.model = normalized.model ?? null
        this.code = normalized.code ?? null
    }
}

export class TransientLLMError extends Error {
    readonly statusCode?: number
    readonly requestId: string | null
    readonly finishReason: string | null
    readonly provider: string | null
    readonly model: string | null
    readonly code: string | null

    constructor(message: string, context?: number | LLMErrorContext) {
        super(message)
        this.name = 'TransientLLMError'
        const normalized = normalizeErrorContext(context)
        this.statusCode = normalized.statusCode
        this.requestId = normalized.requestId ?? null
        this.finishReason = normalized.finishReason ?? null
        this.provider = normalized.provider ?? null
        this.model = normalized.model ?? null
        this.code = normalized.code ?? null
    }
}

const TRANSIENT_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const TRANSIENT_CODES = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
])

export function classifyLLMError(error: unknown): PermanentLLMError | TransientLLMError {
    if (error instanceof PermanentLLMError || error instanceof TransientLLMError) {
        return error
    }

    const record = error as {
        status?: number
        statusCode?: number
        code?: string
        message?: string
        requestId?: string
        finishReason?: string | null
        provider?: string | null
        model?: string | null
    }
    const status = record?.status ?? record?.statusCode
    const code = record?.code
    const message = record?.message ?? String(error)
    const context: LLMErrorContext = {
        statusCode: typeof status === 'number' ? status : undefined,
        requestId: record?.requestId ?? null,
        finishReason: record?.finishReason ?? null,
        provider: record?.provider ?? ((typeof status === 'number' || code != null) ? 'deepseek' : null),
        model: record?.model ?? null,
        code: code ?? null,
    }

    if (status === 400 || status === 401 || status === 403 || status === 404) {
        return new PermanentLLMError(`DeepSeek ${status}: ${message}`, context)
    }

    if ((typeof status === 'number' && TRANSIENT_STATUS.has(status)) || (code && TRANSIENT_CODES.has(code))) {
        return new TransientLLMError(`DeepSeek ${status ?? code}: ${message}`, context)
    }

    return new TransientLLMError(message, context)
}

export async function safeLLMCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn()
    } catch (error) {
        throw classifyLLMError(error)
    }
}
