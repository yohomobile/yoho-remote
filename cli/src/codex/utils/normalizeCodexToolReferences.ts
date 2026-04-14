const TOOL_REFERENCE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/mcp__yoho_remote__([a-z0-9_]+)/gi, 'functions.yoho_remote__$1'],
    [/mcp__yoho-vault__([a-z0-9_]+)/gi, 'functions.yoho_vault__$1'],
    [/mcp__yoho_vault__([a-z0-9_]+)/gi, 'functions.yoho_vault__$1'],
    [/mcp__yoho-memory__([a-z0-9_]+)/gi, 'functions.yoho_memory__$1'],
    [/mcp__yoho_memory__([a-z0-9_]+)/gi, 'functions.yoho_memory__$1'],
    [/mcp__yoho-credentials__([a-z0-9_]+)/gi, 'functions.yoho_credentials__$1'],
    [/mcp__yoho_credentials__([a-z0-9_]+)/gi, 'functions.yoho_credentials__$1']
];

export function normalizeCodexToolReferences(message: string): string {
    let normalizedMessage = message;
    for (const [pattern, replacement] of TOOL_REFERENCE_REPLACEMENTS) {
        normalizedMessage = normalizedMessage.replaceAll(pattern, replacement);
    }
    return normalizedMessage;
}
