/**
 * Maps yoho-remote Claude modelMode labels to what the Claude CLI / SDK's
 * `--model` argument accepts. Short aliases like 'sonnet' and 'opus' are
 * recognized natively by the Claude CLI; version-pinned labels such as
 * 'opus-4-7' are internal to yoho-remote and must be expanded to the full
 * Claude API model ID ('claude-opus-4-7') before being passed through.
 *
 * Opus modes carry the `[1m]` suffix so Claude Code enables the 1M context
 * window beta by default. Sonnet stays at its default 200K window.
 *
 * Non-Claude modes (OpenRouter aliases like 'glm-5.1', 'gpt-5.4', etc.) are
 * not listed here — callers should fall back to the original string when
 * this table returns undefined.
 */
export const CLAUDE_MODE_TO_MODEL_ARG: Record<string, string> = {
    sonnet: 'sonnet',
    opus: 'opus[1m]',
    'opus-4-7': 'claude-opus-4-7[1m]',
};

export function resolveClaudeModelArg(mode: string | undefined | null): string | undefined {
    if (!mode) {
        return undefined;
    }
    return CLAUDE_MODE_TO_MODEL_ARG[mode];
}
