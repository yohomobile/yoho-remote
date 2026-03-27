import { trimIdent } from '@/utils/trimIdent';
import type { CodexSessionConfig } from '../types';
import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';

export const TITLE_INSTRUCTION = trimIdent(`Based on this message, call functions.yoho_remote__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`);

function resolveApprovalPolicy(mode: EnhancedMode): CodexSessionConfig['approval-policy'] {
    switch (mode.permissionMode) {
        case 'default': return 'untrusted';
        case 'read-only': return 'never';
        case 'safe-yolo': return 'on-failure';
        case 'yolo': return 'on-failure';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

function resolveSandbox(mode: EnhancedMode): CodexSessionConfig['sandbox'] {
    switch (mode.permissionMode) {
        case 'default': return 'workspace-write';
        case 'read-only': return 'read-only';
        case 'safe-yolo': return 'workspace-write';
        case 'yolo': return 'danger-full-access';
        default: {
            throw new Error(`Unknown permission mode: ${mode.permissionMode}`);
        }
    }
}

export function buildCodexStartConfig(args: {
    message: string;
    mode: EnhancedMode;
    first: boolean;
    mcpServers: Record<string, { command: string; args: string[] }>;
    cliOverrides?: CodexCliOverrides;
    developerInstructions?: string;
    includeTitleInstruction?: boolean;
}): CodexSessionConfig {
    const approvalPolicy = resolveApprovalPolicy(args.mode);
    const sandbox = resolveSandbox(args.mode);
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const cliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const resolvedApprovalPolicy = cliOverrides?.approvalPolicy ?? approvalPolicy;
    const resolvedSandbox = cliOverrides?.sandbox ?? sandbox;

    const shouldAddTitleInstruction = args.first && (args.includeTitleInstruction ?? true);
    const prompt = shouldAddTitleInstruction ? `${args.message}\n\n${TITLE_INSTRUCTION}` : args.message;
    const config: Record<string, unknown> = { mcp_servers: args.mcpServers };
    if (args.developerInstructions) {
        config.developer_instructions = args.developerInstructions;
    }
    const startConfig: CodexSessionConfig = {
        prompt,
        sandbox: resolvedSandbox,
        'approval-policy': resolvedApprovalPolicy,
        config
    };

    if (args.mode.model) {
        startConfig.model = args.mode.model;
    }
    if (args.mode.modelReasoningEffort && (args.mode.model === 'gpt-5.3-codex' || args.mode.model === 'gpt-5.2-codex')) {
        startConfig.model_reasoning_effort = args.mode.modelReasoningEffort;
    }

    return startConfig;
}
