import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export interface YohoStdioMcpServerConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export type YohoMcpServerConfig = YohoStdioMcpServerConfig;

export interface YohoAuxMcpServerOptions {
    /** Org ID for data isolation. Passed as YOHO_ORG_ID env. */
    orgId?: string | null;
}

export const YOHO_MEMORY_REPO_ROOT = '/home/workspaces/tools/yoho-memory';
export const YOHO_MEMORY_MCP_DB_MAX_CONNECTIONS = '2';

function resolveHomeDir(): string {
    const homeDir = process.env.HOME?.trim();
    return homeDir || os.homedir();
}

function buildPathEnv(homeDir: string): string {
    const bunBin = `${homeDir}/.bun/bin`;
    const currentPath = process.env.PATH?.trim();
    return currentPath ? `${bunBin}:${currentPath}` : bunBin;
}

/**
 * Returns the MCP server config for yoho-vault (unified memory + credentials, org-isolated).
 *
 * Yoho Memory is intentionally pinned to /home/workspaces/tools/yoho-memory.
 */
export async function getYohoAuxMcpServers(flavor: 'codex', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoStdioMcpServerConfig>>;
export async function getYohoAuxMcpServers(flavor: 'claude', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoMcpServerConfig>>;
export async function getYohoAuxMcpServers(flavor: 'claude' | 'codex', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoMcpServerConfig>> {
    const homeDir = resolveHomeDir();
    const env: Record<string, string> = {
        PATH: buildPathEnv(homeDir),
        // These stdio MCP servers are spawned per agent session, so a large default
        // DB pool is multiplied by the number of active remote sessions.
        DB_MAX_CONNECTIONS: YOHO_MEMORY_MCP_DB_MAX_CONNECTIONS,
    };
    if (options?.orgId) env.YOHO_ORG_ID = options.orgId;

    const serverName = flavor === 'codex' ? 'yoho_vault' : 'yoho-vault';

    const vaultLocalPath = join(YOHO_MEMORY_REPO_ROOT, 'src/mcp/stdio.ts');
    const skillLocalPath = join(YOHO_MEMORY_REPO_ROOT, 'src/mcp/skill-stdio.ts');

    const result: Record<string, YohoMcpServerConfig> = {};

    if (existsSync(vaultLocalPath)) {
        result[serverName] = {
            command: 'bun',
            args: ['run', vaultLocalPath],
            cwd: YOHO_MEMORY_REPO_ROOT,
            env,
        };
        if (existsSync(skillLocalPath)) {
            result['skill'] = {
                command: 'bun',
                args: ['run', skillLocalPath],
                cwd: YOHO_MEMORY_REPO_ROOT,
                env,
            };
        }
    }

    return result;
}
