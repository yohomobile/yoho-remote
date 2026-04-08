import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { basename, join, normalize } from 'node:path';

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

export interface YohoAuxProjectRef {
    name: string;
    path: string;
}

export interface YohoAuxProjectClient {
    getProjects(sessionId: string, machineId?: string): Promise<YohoAuxProjectRef[]>;
}

export interface YohoAuxMcpServerOptions {
    apiClient?: YohoAuxProjectClient;
    sessionId?: string | null;
}

function resolveHomeDir(): string {
    const homeDir = process.env.HOME?.trim();
    return homeDir || os.homedir();
}

function buildPathEnv(homeDir: string): string {
    const bunBin = `${homeDir}/.bun/bin`;
    const currentPath = process.env.PATH?.trim();
    return currentPath ? `${bunBin}:${currentPath}` : bunBin;
}

function normalizeProjectKey(value: string): string {
    return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function resolveRepoRoot(candidate: string | null | undefined, entryRelativePath: string): string | null {
    const trimmed = candidate?.trim();
    if (!trimmed) return null;

    try {
        if (existsSync(trimmed) && statSync(trimmed).isDirectory()) {
            return existsSync(join(trimmed, entryRelativePath)) ? trimmed : null;
        }

        const normalizedCandidate = normalize(trimmed);
        const normalizedEntry = normalize(entryRelativePath);
        if (existsSync(normalizedCandidate) && statSync(normalizedCandidate).isFile() && normalizedCandidate.endsWith(normalizedEntry)) {
            return normalizedCandidate.slice(0, -normalizedEntry.length).replace(/[\\/]+$/, '');
        }
    } catch {
        return null;
    }

    return null;
}

async function resolveProjectRepoRoot(
    entryRelativePath: string,
    projectNames: string[],
    options?: YohoAuxMcpServerOptions
): Promise<string | null> {
    if (!options?.apiClient || !options.sessionId) {
        return null;
    }

    try {
        const projects = await options.apiClient.getProjects(options.sessionId);
        const projectNameKeys = new Set(projectNames.map(normalizeProjectKey));
        for (const project of projects) {
            const nameKey = normalizeProjectKey(project.name);
            const pathBase = basename(project.path);
            if (!projectNameKeys.has(nameKey) && !projectNameKeys.has(normalizeProjectKey(pathBase))) {
                continue;
            }
            const repoRoot = resolveRepoRoot(project.path, entryRelativePath);
            if (repoRoot) {
                return repoRoot;
            }
        }
    } catch {
        return null;
    }

    return null;
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
 * yoho-memory path resolution order:
 * 1) YOHO_MEMORY_PATH env
 * 2) Project list entry (YohoMemory / yoho-memory)
 * 3) legacy ~/happy/yoho-memory path
 *
 * Otherwise, for Claude, fall back to HTTP against the remote servers.
 * Codex only supports stdio, so it gets nothing when local files are absent.
 */
export async function getYohoAuxMcpServers(flavor: 'codex', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoStdioMcpServerConfig>>;
export async function getYohoAuxMcpServers(flavor: 'claude', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoMcpServerConfig>>;
export async function getYohoAuxMcpServers(flavor: 'claude' | 'codex', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoMcpServerConfig>> {
    const homeDir = resolveHomeDir();
    const env = { PATH: buildPathEnv(homeDir) };

    const memoryServerName = flavor === 'codex' ? 'yoho_memory' : 'yoho-memory';
    const credentialsServerName = flavor === 'codex' ? 'yoho_credentials' : 'yoho-credentials';

    const memoryRepoRoot = resolveRepoRoot(process.env.YOHO_MEMORY_PATH, 'src/mcp/stdio.ts')
        ?? await resolveProjectRepoRoot('src/mcp/stdio.ts', ['YohoMemory', 'yoho-memory'], options)
        ?? resolveRepoRoot(`${homeDir}/happy/yoho-memory`, 'src/mcp/stdio.ts');
    const memoryLocalPath = memoryRepoRoot ? join(memoryRepoRoot, 'src/mcp/stdio.ts') : null;
    const credentialsLocalPath = `${homeDir}/happy/yoho-task-v2/mcp/credentials-server/index.ts`;

    const result: Record<string, YohoMcpServerConfig> = {};

    // yoho-memory
    if (memoryLocalPath && existsSync(memoryLocalPath)) {
        result[memoryServerName] = {
            command: 'bun',
            args: ['run', memoryLocalPath],
            cwd: memoryRepoRoot ?? `${homeDir}/happy/yoho-memory`,
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
