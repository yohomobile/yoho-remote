export function normalizeCodexMcpToolName(server: string, tool: string): string {
    if (server === 'yoho_remote' && tool === 'ask_user_question') {
        return 'ask_user_question';
    }

    return `${server}__${tool}`;
}
