import {
    BRAIN_CHILD_INTERACTION_YOHO_REMOTE_TOOL_NAMES,
    BRAIN_CHILD_YOHO_REMOTE_TOOL_NAMES,
    buildBrainChildCodexFunctionTools,
} from '@/utils/brainChildToolAllowlist';
import { isSessionOrchestrationParentSource } from '@/utils/sessionOrchestration';

const YOHO_VAULT_RUNTIME_TOOLS = [
    'functions.yoho_vault__recall',
    'functions.yoho_vault__remember',
    'functions.yoho_vault__list_credentials',
    'functions.yoho_vault__get_credential',
    'functions.yoho_vault__set_credential',
    'functions.yoho_vault__delete_credential',
    'functions.yoho_vault__skill_search',
    'functions.yoho_vault__skill_get',
    'functions.yoho_vault__skill_list',
    'functions.yoho_vault__skill_save',
    'functions.yoho_vault__skill_update',
    'functions.yoho_vault__skill_promote',
    'functions.yoho_vault__skill_archive',
    'functions.yoho_vault__skill_delete',
    'functions.yoho_vault__skill_doctor',
    'functions.yoho_vault__skill_discover',
] as const;

export const BRAIN_CHILD_SAFE_YOHO_REMOTE_TOOL_NAMES = [
    ...BRAIN_CHILD_YOHO_REMOTE_TOOL_NAMES,
    ...BRAIN_CHILD_INTERACTION_YOHO_REMOTE_TOOL_NAMES,
] as const;

function mapYohoRemoteRuntimeFunctionTools(toolNames: readonly string[]): string[] {
    return toolNames.map((toolName) => `functions.yoho_remote__${toolName}`);
}

export function buildCodexRuntimeFunctionTools(args: {
    yohoRemoteToolNames: string[];
    auxServerNames: string[];
}): string[] {
    const tools = mapYohoRemoteRuntimeFunctionTools(args.yohoRemoteToolNames);
    const auxServerNames = new Set(args.auxServerNames);

    if (auxServerNames.has('yoho_vault')) {
        tools.push(...YOHO_VAULT_RUNTIME_TOOLS);
    }

    return [...new Set(tools)].sort();
}

export function buildCodexBrainChildRuntimeFunctionTools(args: {
    yohoRemoteToolNames: string[];
    auxServerNames: string[];
}): string[] {
    return buildBrainChildCodexFunctionTools({
        yohoRemoteToolNames: args.yohoRemoteToolNames,
        auxServerNames: args.auxServerNames,
        includeInteractionTools: true,
    });
}

export function buildCodexConfigOverrides(args: {
    sessionSource?: string | null;
}): Record<string, unknown> | undefined {
    if (!isSessionOrchestrationParentSource(args.sessionSource)) {
        return undefined;
    }

    return {
        features: {
            multi_agent: false,
            shell_tool: false,
        },
        mcp_servers: {
            yoho_remote: {
                required: true,
            },
        },
        web_search: 'live',
    };
}
