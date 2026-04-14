import { buildCodexServiceTierArgs } from './codexServiceTier';
import type { PermissionMode } from '../loop';

export interface CodexExecMcpServerConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export interface CodexExecStartConfig {
    prompt: string;
    model?: string;
    model_reasoning_effort?: string;
    service_tier?: 'fast' | 'flex';
}

export function buildMcpConfigFlags(
    mcpServers: Record<string, CodexExecMcpServerConfig>
): string[] {
    const flags: string[] = [];
    for (const [name, cfg] of Object.entries(mcpServers)) {
        flags.push('-c', `mcp_servers.${name}.command="${cfg.command}"`);
        const argsToml = `[${cfg.args.map((arg) => `"${arg}"`).join(', ')}]`;
        flags.push('-c', `mcp_servers.${name}.args=${argsToml}`);
        if (cfg.cwd) {
            flags.push('-c', `mcp_servers.${name}.cwd="${cfg.cwd}"`);
        }
        if (cfg.env) {
            for (const [key, value] of Object.entries(cfg.env)) {
                flags.push('-c', `mcp_servers.${name}.env.${key}="${value}"`);
            }
        }
    }
    return flags;
}

export function buildCodexExecArgs(opts: {
    threadId: string | null;
    permissionMode: PermissionMode;
    startConfig: CodexExecStartConfig;
    mcpServers: Record<string, CodexExecMcpServerConfig>;
    prompt: string;
    skipGitRepoCheck?: boolean;
}): string[] {
    const args: string[] = [];

    if (opts.threadId) {
        args.push('exec', 'resume', opts.threadId);
    } else {
        args.push('exec');
    }

    args.push('--json');

    if (opts.skipGitRepoCheck) {
        args.push('--skip-git-repo-check');
    }

    if (opts.permissionMode === 'yolo') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (opts.permissionMode === 'safe-yolo') {
        args.push('--full-auto');
    } else if (opts.permissionMode === 'read-only') {
        args.push('--sandbox', 'read-only');
    } else {
        args.push('--sandbox', 'workspace-write');
    }

    if (opts.startConfig.model) {
        args.push('-m', opts.startConfig.model);
    }

    args.push(...buildMcpConfigFlags(opts.mcpServers));

    if (opts.startConfig.model_reasoning_effort) {
        args.push('-c', `model_reasoning_effort="${opts.startConfig.model_reasoning_effort}"`);
    }

    if (opts.startConfig.service_tier) {
        args.push(...buildCodexServiceTierArgs(opts.startConfig.service_tier));
    }

    args.push(opts.prompt);

    return args;
}
