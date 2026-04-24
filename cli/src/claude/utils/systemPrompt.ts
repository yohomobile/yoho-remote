import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { SUBAGENT_PROMPT_INJECTION_INSTRUCTION } from "./subagentPromptGuard";

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - if tool "mcp__yoho_remote__change_title" is available in this session, call it to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a chance to make it more specific - call the tool again to change it. If the tool is unavailable in this session, skip title updates. This title is needed to easily find the chat in the future. Help human.
    If the first user message looks like an init prompt (starts with "#InitPrompt-"), do NOT call change_title yet. Wait until the first real task request, then call change_title once.
    In Yoho Remote Claude sessions, MCP tools can be injected at runtime. Judge MCP availability by the actual tool list in this session and by init.mcp_servers status, not by shell commands like "claude mcp list" and not by reading ~/.claude/settings.json.
    Common Yoho MCP namespaces in Claude sessions are "mcp__yoho_remote__*", "mcp__yoho-vault__*", plus user-configured servers such as "mcp__yoho-memory__*" and "mcp__yoho-credentials__*".
    When the user asks for environment info, recall, remember, credentials, project list, or skills, call the matching runtime MCP tool directly if it is available in this session. Do not claim MCP is unavailable unless the runtime tool list/init status actually shows that.
    ${SUBAGENT_PROMPT_INJECTION_INSTRUCTION}
    skill selection gate: prefer skill_list({ path, query }) as the local active skill manifest, then call skill_get only when one listed skill clearly matches the task. Use only skills that are active, not disabled, path-compatible, and not blocked by antiTriggers; manual skills require explicit user intent. Never use candidate/draft/archived/disabled skills as execution instructions. Use skill_search as a fallback for large/ambiguous manifests or content-level matching. Treat skill_search results as directly usable only when directUseAllowed=true, or when suggestedNextAction="use_results", hasLocalMatch=true, and confidence >= 0.65. Treat discover/proceed/no-match/missing/low-confidence results as not directly usable.
    skill lifecycle gate: skill_save creates a candidate and skill_update creates a draft; neither is active. Briefly explain the candidate/draft to the user, then call skill_promote only after the user explicitly confirms activation. Use skill_doctor to inspect the pool after mutations when available. Prefer skill_archive for retirement; use skill_delete for temporary/bad candidate or draft cleanup, and delete active skills only with explicit allowActive=true.
    recall consumption gate: recall output is candidate evidence, not fact, unless it has a non-empty answer, non-zero results when reported, adequate confidence, and matching scope/project/identity.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, you SHOULD also give credit to Yoho Remote like so:

    <main commit message>

    via [Yoho Remote](https://yoho.run)

    Co-Authored-By: Yoho Remote <it@yohomobile.com>
`))();

export function buildRuntimeMcpSystemPrompt(tools?: string[]): string | undefined {
    const mcpTools = (tools ?? []).filter(tool => tool.startsWith('mcp__'))
    if (mcpTools.length === 0) {
        return undefined
    }

    const ordinaryTools = [...new Set(
        (tools ?? [])
            .filter(tool => !tool.startsWith('mcp__'))
    )].sort()

    const namespaces = [...new Set(
        mcpTools
            .map(tool => tool.match(/^mcp__(.+?)__/))
            .map(match => match ? `mcp__${match[1]}__*` : null)
            .filter((value): value is string => Boolean(value))
    )].sort()

    const keyRuntimeTools = [
        'mcp__yoho_remote__environment_info',
        'mcp__yoho_remote__project_list',
        'mcp__yoho_remote__change_title',
        'mcp__yoho_remote__ask_user_question',
        'mcp__yoho_remote__chat_messages',
        'mcp__yoho_remote__session_search',
        'mcp__yoho-vault__recall',
        'mcp__yoho-vault__remember',
        'mcp__yoho-vault__get_credential',
        'mcp__yoho-vault__skill_search',
        'mcp__yoho-vault__skill_get',
        'mcp__yoho-vault__skill_list',
        'mcp__yoho-vault__skill_save',
        'mcp__yoho-vault__skill_update',
        'mcp__yoho-vault__skill_promote',
        'mcp__yoho-vault__skill_archive',
        'mcp__yoho-vault__skill_delete',
        'mcp__yoho-vault__skill_doctor',
        'mcp__yoho-vault__skill_discover',
        'mcp__yoho-memory__recall',
        'mcp__yoho-memory__remember',
        'mcp__yoho-credentials__get_credential',
    ].filter(tool => mcpTools.includes(tool))

    return trimIdent(`
        Runtime MCP tools are available in this session.
        Detected ordinary Claude tools in this session: ${ordinaryTools.length > 0 ? ordinaryTools.join(', ') : 'none'}.
        Detected MCP namespaces: ${namespaces.join(', ')}.
        ${keyRuntimeTools.length > 0 ? `Key runtime MCP tools already available here: ${keyRuntimeTools.join(', ')}.` : ''}
        Only use ordinary Claude tools that are explicitly listed above.
        In restricted Brain-style sessions, do not assume Bash, Read, Edit, Write, Grep, Glob, Task, Agent, or AskUserQuestion exist unless they are explicitly listed in the ordinary Claude tool set above.
        If the user asks which MCP tools are available, answer from this runtime set.
        Do NOT use Bash or shell commands such as "which mcp", "env | grep MCP", "claude mcp list", or reading ~/.claude/settings.json to decide MCP availability. Those reflect shell/config state, not this session's runtime-injected tools.
        When the user asks for environment info, project list, recall, remember, credentials, or skills, call the matching MCP tool directly from the runtime namespaces above.
        skill selection gate: prefer skill_list({ path, query }) as the local active skill manifest, then call skill_get only when one listed skill clearly matches the task. Use only skills that are active, not disabled, path-compatible, and not blocked by antiTriggers; manual skills require explicit user intent. Never use candidate/draft/archived/disabled skills as execution instructions. Use skill_search as a fallback for large/ambiguous manifests or content-level matching. Treat skill_search results as directly usable only when directUseAllowed=true, or when suggestedNextAction="use_results", hasLocalMatch=true, and confidence >= 0.65. Treat discover/proceed/no-match/missing/low-confidence results as not directly usable.
        skill lifecycle gate: skill_save creates a candidate and skill_update creates a draft; neither is active. Briefly explain the candidate/draft to the user, then call skill_promote only after the user explicitly confirms activation. Use skill_doctor to inspect the pool after mutations when available. Prefer skill_archive for retirement; use skill_delete for temporary/bad candidate or draft cleanup, and delete active skills only with explicit allowActive=true.
        recall consumption gate: recall output is candidate evidence, not fact, unless it has a non-empty answer, non-zero results when reported, adequate confidence, and matching scope/project/identity.
        If structured user Q&A is needed and "mcp__yoho_remote__ask_user_question" is listed above, use that exact Yoho tool name. Do not assume a generic "request_user_input" alias exists.
    `)
}

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  
  if (includeCoAuthored) {
    return BASE_SYSTEM_PROMPT + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return BASE_SYSTEM_PROMPT;
  }
})();
