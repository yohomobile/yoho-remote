function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function extractTextFromContentBlocks(value: unknown): string | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const parts = value
        .map((item) => {
            if (typeof item === 'string') {
                return item;
            }
            if (!isObject(item)) {
                return null;
            }
            return typeof item.text === 'string' ? item.text : null;
        })
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0);

    return parts.length > 0 ? parts.join('\n') : null;
}

function extractTextCandidate(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return value;
    }

    return extractTextFromContentBlocks(value);
}

const COMMAND_OUTPUT_KEYS = [
    'output',
    'stdout',
    'stderr',
    'aggregated_output',
    'combined_output',
    'output_text',
    'text',
    'message',
    'content'
] as const;

export function buildCommandExecutionResult(item: Record<string, unknown>): Record<string, unknown> {
    const { id, type, status, ...rest } = item;
    return rest;
}

export function getCommandExecutionPreview(item: Record<string, unknown>): string | null {
    const result = buildCommandExecutionResult(item);

    for (const key of COMMAND_OUTPUT_KEYS) {
        const direct = extractTextCandidate(result[key]);
        if (direct) {
            return direct;
        }
    }

    return null;
}
