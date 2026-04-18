import { describe, expect, it } from 'bun:test'
import {
    classifyLLMError,
    PermanentLLMError,
    TransientLLMError,
} from './errors'

describe('classifyLLMError', () => {
    it('treats 4xx auth/request errors as permanent', () => {
        const error = classifyLLMError({ status: 401, message: 'bad api key' })

        expect(error).toBeInstanceOf(PermanentLLMError)
        expect(error.message).toContain('401')
    })

    it('treats rate limit and 5xx errors as transient', () => {
        const rateLimitError = classifyLLMError({ status: 429, message: 'slow down' })
        const serverError = classifyLLMError({ status: 503, message: 'unavailable' })

        expect(rateLimitError).toBeInstanceOf(TransientLLMError)
        expect(serverError).toBeInstanceOf(TransientLLMError)
    })

    it('treats network timeout codes as transient', () => {
        const timeoutError = classifyLLMError({ code: 'ETIMEDOUT', message: 'socket timeout' })

        expect(timeoutError).toBeInstanceOf(TransientLLMError)
        expect(timeoutError.message).toContain('socket timeout')
        expect(timeoutError.provider).toBe('deepseek')
    })

    it('preserves provider request metadata when classifying', () => {
        const error = classifyLLMError({
            status: 429,
            message: 'slow down',
            requestId: 'req-429',
            finishReason: 'length',
            model: 'deepseek-chat',
        })

        expect(error).toBeInstanceOf(TransientLLMError)
        expect(error.statusCode).toBe(429)
        expect(error.requestId).toBe('req-429')
        expect(error.finishReason).toBe('length')
        expect(error.model).toBe('deepseek-chat')
    })
})
