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
    config?: Record<string, unknown>;
}

export function buildMcpConfigFlags(
    mcpServers: Record<string, CodexExecMcpServerConfig>
): string[] {
    const flags: string[] = [];
    for (const [name, cfg] of Object.entries(mcpServers)) {
        flags.push('-c', `mcp_servers.${name}.command=${formatTomlScalar(cfg.command)}`);
        const argsToml = `[${cfg.args.map((arg) => formatTomlScalar(arg)).join(', ')}]`;
        flags.push('-c', `mcp_servers.${name}.args=${argsToml}`);
        if (cfg.cwd) {
            flags.push('-c', `mcp_servers.${name}.cwd=${formatTomlScalar(cfg.cwd)}`);
        }
        if (cfg.env) {
            for (const [key, value] of Object.entries(cfg.env)) {
                flags.push('-c', `mcp_servers.${name}.env.${key}=${formatTomlScalar(value)}`);
            }
        }
    }
    return flags;
}

function formatTomlScalar(value: string | number | boolean): string {
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`Unsupported non-finite config number: ${value}`);
        }
        return String(value);
    }
    return value ? 'true' : 'false';
}

function buildConfigOverrideFlags(
    config: Record<string, unknown>,
    prefix?: string,
    shouldSkip?: (keyPath: string) => boolean
): string[] {
    const flags: string[] = [];

    for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null) {
            continue;
        }

        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (shouldSkip?.(fullKey)) {
            continue;
        }
        if (Array.isArray(value)) {
            const arrayValue = `[${value.map((entry) => {
                if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
                    return formatTomlScalar(entry);
                }
                throw new Error(`Unsupported config array value at ${fullKey}`);
            }).join(', ')}]`;
            flags.push('-c', `${fullKey}=${arrayValue}`);
            continue;
        }

        if (typeof value === 'object') {
            flags.push(...buildConfigOverrideFlags(value as Record<string, unknown>, fullKey, shouldSkip));
            continue;
        }

        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            flags.push('-c', `${fullKey}=${formatTomlScalar(value)}`);
            continue;
        }

        throw new Error(`Unsupported config value at ${fullKey}`);
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
    if (opts.startConfig.config) {
        args.push(...buildConfigOverrideFlags(
            opts.startConfig.config,
            undefined,
            (keyPath) => /^mcp_servers\.[^.]+\.(command|args|cwd)$/.test(keyPath) || /^mcp_servers\.[^.]+\.env(\.|$)/.test(keyPath)
        ));
    }

    if (opts.startConfig.model_reasoning_effort) {
        args.push('-c', `model_reasoning_effort="${opts.startConfig.model_reasoning_effort}"`);
    }

    if (opts.startConfig.service_tier) {
        args.push(...buildCodexServiceTierArgs(opts.startConfig.service_tier));
    }

    args.push(opts.prompt);

    return args;
}
