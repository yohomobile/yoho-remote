export class PermanentJobError extends Error {
    readonly code: string | null

    constructor(code: string | null, message: string) {
        super(message)
        this.name = 'PermanentJobError'
        this.code = code
    }
}

export class TransientJobError extends Error {
    readonly code: string | null

    constructor(code: string | null, message: string) {
        super(message)
        this.name = 'TransientJobError'
        this.code = code
    }
}

export function extractJobErrorCode(error: unknown): string | null {
    const record = error as { code?: unknown }
    return typeof record?.code === 'string' && record.code.length > 0
        ? record.code
        : null
}
