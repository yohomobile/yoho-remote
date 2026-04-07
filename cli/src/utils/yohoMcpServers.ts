import { existsSync } from 'node:fs';
import os from 'node:os';

export interface YohoStdioMcpServerConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export interface YohoHttpMcpServerConfig {
    type: 'http';
    url: string;
}

export type YohoMcpServerConfig = YohoStdioMcpServerConfig | YohoHttpMcpServerConfig;

function resolveHomeDir(): string {
    const homeDir = process.env.HOME?.trim();
    return homeDir || os.homedir();
}

function buildPathEnv(homeDir: string): string {
    const bunBin = `${homeDir}/.bun/bin`;
    const currentPath = process.env.PATH?.trim();
    return currentPath ? `${bunBin}:${currentPath}` : bunBin;
}

/** Well-known ports for auxiliary MCP servers (co-located with yoho-remote-server) */
export const MEMORY_HTTP_PORT = 3100;
export const CREDENTIALS_HTTP_PORT = 3101;

/**
 * Derive the host where auxiliary MCP HTTP servers run from YOHO_REMOTE_URL.
 * They are co-located with yoho-remote-server, so we just extract the hostname.
 */
function deriveAuxMcpHost(): string | null {
    const serverUrl = process.env.YOHO_REMOTE_URL;
    if (!serverUrl) return null;
    try {
        return new URL(serverUrl).hostname;
    } catch {
        return null;
    }
}

/**
 * Returns MCP server configs for yoho-memory and yoho-credentials.
 *
 * Strategy: if the local MCP entry files exist, use stdio (works everywhere).
 * Otherwise, for Claude, fall back to HTTP against the remote servers.
 * Codex only supports stdio, so it gets nothing when local files are absent.
 */
export function getYohoAuxMcpServers(flavor: 'codex'): Record<string, YohoStdioMcpServerConfig>;
export function getYohoAuxMcpServers(flavor: 'claude'): Record<string, YohoMcpServerConfig>;
export function getYohoAuxMcpServers(flavor: 'claude' | 'codex'): Record<string, YohoMcpServerConfig> {
    const homeDir = resolveHomeDir();
    const env = { PATH: buildPathEnv(homeDir) };

    const memoryServerName = flavor === 'codex' ? 'yoho_memory' : 'yoho-memory';
    const credentialsServerName = flavor === 'codex' ? 'yoho_credentials' : 'yoho-credentials';

    const memoryLocalPath = `${homeDir}/happy/yoho-memory/src/mcp/stdio.ts`;
    const credentialsLocalPath = `${homeDir}/happy/yoho-task-v2/mcp/credentials-server/index.ts`;

    const result: Record<string, YohoMcpServerConfig> = {};

    // yoho-memory
    if (existsSync(memoryLocalPath)) {
        result[memoryServerName] = {
            command: 'bun',
            args: ['run', memoryLocalPath],
            cwd: `${homeDir}/happy/yoho-memory`,
            env,
        };
    } else if (flavor === 'claude') {
        const host = deriveAuxMcpHost();
        if (host) {
            result[memoryServerName] = { type: 'http', url: `http://${host}:${MEMORY_HTTP_PORT}/mcp` };
        }
    }

    // yoho-credentials
    if (existsSync(credentialsLocalPath)) {
        result[credentialsServerName] = {
            command: 'bun',
            args: ['run', credentialsLocalPath],
            cwd: `${homeDir}/happy/yoho-task-v2/mcp/credentials-server`,
            env,
        };
    } else if (flavor === 'claude') {
        const host = deriveAuxMcpHost();
        if (host) {
            result[credentialsServerName] = { type: 'http', url: `http://${host}:${CREDENTIALS_HTTP_PORT}/mcp` };
        }
    }

    return result;
}
