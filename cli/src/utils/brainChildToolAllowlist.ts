import { CLAUDE_BUILTIN_TOOLS } from '@/claude/utils/claudeBuiltinTools';

export const BRAIN_CHILD_YOHO_REMOTE_TOOL_NAMES = [
    'change_title',
    'environment_info',
    'push_download',
    'project_list',
    'project_create',
    'project_update',
    'project_delete',
    'chat_messages',
    'session_search',
] as const;

export const BRAIN_CHILD_INTERACTION_YOHO_REMOTE_TOOL_NAMES = [
    'ask_user_question',
] as const;

export const BRAIN_CHILD_YOHO_VAULT_TOOL_NAMES = [
    'recall',
    'remember',
    'session_search',
    'session_messages',
    'skill_search',
    'skill_get',
    'skill_list',
    'skill_discover',
    'list_credentials',
    'get_credential',
    'set_credential',
    'delete_credential',
] as const;

// Host-provided tools are not provisioned by Yoho Remote MCP registration.
// They remain runtime-dependent and should only be used when the host actually exposes them.
export const BRAIN_CHILD_OPTIONAL_HOST_TOOL_NAMES = [
    'tool_suggest',
] as const;

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

export function filterBrainChildYohoRemoteToolNames(toolNames: readonly string[]): string[] {
    const allowed = new Set<string>(BRAIN_CHILD_YOHO_REMOTE_TOOL_NAMES);
    return toolNames.filter((toolName) => allowed.has(toolName));
}

export function filterBrainChildInteractionToolNames(toolNames: readonly string[]): string[] {
    const allowed = new Set<string>(BRAIN_CHILD_INTERACTION_YOHO_REMOTE_TOOL_NAMES);
    return toolNames.filter((toolName) => allowed.has(toolName));
}

export function buildBrainChildCodexFunctionTools(args: {
    yohoRemoteToolNames: readonly string[];
    auxServerNames: readonly string[];
    includeInteractionTools?: boolean;
}): string[] {
    const yohoRemoteToolNames = [
        ...filterBrainChildYohoRemoteToolNames(args.yohoRemoteToolNames),
        ...(args.includeInteractionTools ? filterBrainChildInteractionToolNames(args.yohoRemoteToolNames) : []),
    ];
    const tools = yohoRemoteToolNames
        .map((toolName) => `functions.yoho_remote__${toolName}`);
    const auxServerNames = new Set(args.auxServerNames);

    if (auxServerNames.has('yoho_vault')) {
        tools.push(...BRAIN_CHILD_YOHO_VAULT_TOOL_NAMES.map((toolName) => `functions.yoho_vault__${toolName}`));
    }

    return uniqueSorted(tools);
}

export function buildBrainChildClaudeAllowedTools(args: {
    yohoRemoteToolNames: readonly string[];
    sessionCaller?: string | null;
    includeInteractionTools?: boolean;
}): string[] {
    const yohoRemoteTools = [
        ...filterBrainChildYohoRemoteToolNames(args.yohoRemoteToolNames),
        ...(args.includeInteractionTools ? filterBrainChildInteractionToolNames(args.yohoRemoteToolNames) : []),
    ]
        .filter((toolName) => args.sessionCaller === 'feishu' ? toolName !== 'change_title' : true)
        .map((toolName) => `mcp__yoho_remote__${toolName}`);
    const yohoVaultTools = BRAIN_CHILD_YOHO_VAULT_TOOL_NAMES.map((toolName) => `mcp__yoho-vault__${toolName}`);

    return uniqueSorted([
        ...CLAUDE_BUILTIN_TOOLS,
        ...yohoRemoteTools,
        ...yohoVaultTools,
    ]);
}
