function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null
    return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

export function isTurnStartUserMessage(content: unknown): boolean {
    const record = asRecord(content)
    if (!record || record.role !== 'user') {
        return false
    }

    if (typeof record.content === 'string') {
        return asNonEmptyString(record.content) !== null
    }

    const contentRecord = asRecord(record.content)
    if (contentRecord?.type === 'text') {
        return asNonEmptyString(contentRecord.text) !== null
    }

    if (!Array.isArray(record.content)) {
        return false
    }

    return record.content.some((block) => {
        const blockRecord = asRecord(block)
        if (!blockRecord || typeof blockRecord.type !== 'string') {
            return false
        }
        return blockRecord.type === 'text' || blockRecord.type === 'image' || blockRecord.type === 'document'
    })
}

export function isRealActivityMessage(content: unknown): boolean {
    function hasVisibleClaudeAttachment(data: Record<string, unknown>): boolean {
        if (data.type !== 'attachment') return false
        const attachment = data.attachment
        if (!attachment || typeof attachment !== 'object') return false
        const attachmentObj = attachment as Record<string, unknown>
        if (attachmentObj.type === 'edited_text_file') {
            const filename = asNonEmptyString(attachmentObj.filename)
            const snippet = typeof attachmentObj.snippet === 'string' ? attachmentObj.snippet : null
            return filename !== null && typeof snippet === 'string' && snippet.trim().length > 0
        }
        if (
            attachmentObj.type === 'plan_file_reference'
            || attachmentObj.type === 'plan_mode'
            || attachmentObj.type === 'queued_command'
        ) {
            return true
        }
        if (attachmentObj.type !== 'todo_reminder') {
            return false
        }
        return Array.isArray(attachmentObj.content) && attachmentObj.content.length > 0
    }

    if (!content || typeof content !== 'object') return false
    const c = content as Record<string, unknown>
    const role = c.role
    if (role === 'user' || role === 'assistant') return true
    if (role === 'agent') {
        const inner = c.content
        if (inner && typeof inner === 'object') {
            const innerObj = inner as Record<string, unknown>
            if (innerObj.type === 'event') return false
            if (innerObj.type === 'output' && innerObj.data && typeof innerObj.data === 'object') {
                const data = innerObj.data as Record<string, unknown>
                const dataType = data.type
                if (dataType === 'assistant' || dataType === 'user') return true
                if (dataType === 'result' && typeof data.result === 'string' && data.result.trim().length > 0) {
                    return true
                }
                if (hasVisibleClaudeAttachment(data)) {
                    return true
                }
                return false
            }
        }
        return true
    }
    return false
}
