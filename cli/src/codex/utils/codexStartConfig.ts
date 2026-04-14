import { trimIdent } from '@/utils/trimIdent';
import type { CodexSessionConfig } from '../types';
import type { EnhancedMode } from '../loop';
import type { CodexCliOverrides } from './codexCliOverrides';
import { normalizeCodexToolReferences } from './normalizeCodexToolReferences';
import { resolveCodexServiceTier } from './codexServiceTier';

export const TITLE_INSTRUCTION = trimIdent(`If tool functions.yoho_remote__change_title is available in this session, call it to set a chat title that represents the current task. If the chat idea changes dramatically, call it again to update the title. If the tool is unavailable in this session, skip title updates.`);

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
    mcpServers: Record<string, {
        command: string;
        args: string[];
        cwd?: string;
        env?: Record<string, string>;
    }>;
    cliOverrides?: CodexCliOverrides;
    developerInstructions?: string;
    includeTitleInstruction?: boolean;
}): CodexSessionConfig {
    const approvalPolicy = resolveApprovalPolicy(args.mode);
    const sandbox = resolveSandbox(args.mode);
    const allowCliOverrides = args.mode.permissionMode === 'default';
    const permissionCliOverrides = allowCliOverrides ? args.cliOverrides : undefined;
    const resolvedApprovalPolicy = permissionCliOverrides?.approvalPolicy ?? approvalPolicy;
    const resolvedSandbox = permissionCliOverrides?.sandbox ?? sandbox;
    const resolvedServiceTier = resolveCodexServiceTier(args.cliOverrides);

    const shouldAddTitleInstruction = args.first && (args.includeTitleInstruction ?? true);
    const normalizedMessage = normalizeCodexToolReferences(args.message);
    const prompt = shouldAddTitleInstruction ? `${normalizedMessage}\n\n${TITLE_INSTRUCTION}` : normalizedMessage;
    const config: Record<string, unknown> = { mcp_servers: args.mcpServers };
    if (args.developerInstructions) {
        config.developer_instructions = args.developerInstructions;
    }
    const startConfig: CodexSessionConfig = {
        prompt,
        sandbox: resolvedSandbox,
        'approval-policy': resolvedApprovalPolicy,
        service_tier: resolvedServiceTier,
        config
    };

    if (args.mode.model) {
        startConfig.model = args.mode.model;
    }
    if (args.mode.modelReasoningEffort) {
        startConfig.model_reasoning_effort = args.mode.modelReasoningEffort;
    }

    return startConfig;
}
