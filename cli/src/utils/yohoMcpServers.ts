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
    headers?: Record<string, string>;
}

export type YohoMcpServerConfig = YohoStdioMcpServerConfig | YohoHttpMcpServerConfig;

export interface YohoAuxProjectRef {
    name: string;
    path: string;
}

export interface YohoAuxProjectClient {
    getProjects(sessionId: string): Promise<YohoAuxProjectRef[]>;
}

export interface YohoAuxMcpServerOptions {
    apiClient?: YohoAuxProjectClient;
    sessionId?: string | null;
    /** Org ID for data isolation. Passed as YOHO_ORG_ID env (stdio) or x-org-id header (HTTP). */
    orgId?: string | null;
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

/** Well-known HTTP port for the unified yoho-vault MCP server (co-located with yoho-remote-server) */
export const VAULT_HTTP_PORT = 3100;

export function resolveYohoMemoryHttpAuthToken(): string | null {
    return process.env.YR_HTTP_MCP_AUTH_TOKEN?.trim()
        || process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN?.trim()
        || null;
}

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
 * Returns the MCP server config for yoho-vault (unified memory + credentials, org-isolated).
 *
 * Path resolution order:
 * 1) YOHO_MEMORY_PATH env (legacy compat)
 * 2) Project list: YohoVault / yoho-vault / YohoMemory / yoho-memory
 * 3) ~/happy/yoho-memory (legacy path)
 *
 * Org isolation: orgId passed as YOHO_ORG_ID env (stdio) or x-org-id header (HTTP).
 * Codex only supports stdio; gets nothing when local files are absent.
 */
export async function getYohoAuxMcpServers(flavor: 'codex', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoStdioMcpServerConfig>>;
export async function getYohoAuxMcpServers(flavor: 'claude', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoMcpServerConfig>>;
export async function getYohoAuxMcpServers(flavor: 'claude' | 'codex', options?: YohoAuxMcpServerOptions): Promise<Record<string, YohoMcpServerConfig>> {
    const homeDir = resolveHomeDir();
    const env: Record<string, string> = { PATH: buildPathEnv(homeDir) };
    if (options?.orgId) env.YOHO_ORG_ID = options.orgId;

    const serverName = flavor === 'codex' ? 'yoho_vault' : 'yoho-vault';

    const vaultRepoRoot = resolveRepoRoot(process.env.YOHO_MEMORY_PATH, 'src/mcp/stdio.ts')
        ?? await resolveProjectRepoRoot('src/mcp/stdio.ts', ['YohoVault', 'yoho-vault', 'YohoMemory', 'yoho-memory'], options)
        ?? resolveRepoRoot(`${homeDir}/happy/yoho-memory`, 'src/mcp/stdio.ts');
    const vaultLocalPath = vaultRepoRoot ? join(vaultRepoRoot, 'src/mcp/stdio.ts') : null;
    const skillLocalPath = vaultRepoRoot ? join(vaultRepoRoot, 'src/mcp/skill-stdio.ts') : null;

    const result: Record<string, YohoMcpServerConfig> = {};

    if (vaultLocalPath && existsSync(vaultLocalPath)) {
        result[serverName] = {
            command: 'bun',
            args: ['run', vaultLocalPath],
            cwd: vaultRepoRoot ?? `${homeDir}/happy/yoho-memory`,
            env,
        };
        if (skillLocalPath && existsSync(skillLocalPath)) {
            result['skill'] = {
                command: 'bun',
                args: ['run', skillLocalPath],
                cwd: vaultRepoRoot ?? `${homeDir}/happy/yoho-memory`,
                env,
            };
        }
    } else if (flavor === 'claude') {
        const host = deriveAuxMcpHost();
        const authToken = resolveYohoMemoryHttpAuthToken();
        if (host && authToken) {
            const headers: Record<string, string> = {};
            headers.authorization = `Bearer ${authToken}`;
            if (options?.orgId) headers['x-org-id'] = options.orgId;
            result[serverName] = { type: 'http', url: `http://${host}:${VAULT_HTTP_PORT}/mcp`, headers };
        }
    }

    return result;
}
