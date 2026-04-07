import os from 'node:os';

export interface YohoStdioMcpServerConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
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

export function getYohoAuxMcpServers(flavor: 'claude' | 'codex'): Record<string, YohoStdioMcpServerConfig> {
    const homeDir = resolveHomeDir();
    const env = {
        PATH: buildPathEnv(homeDir),
    };

    const memoryServerName = flavor === 'codex' ? 'yoho_memory' : 'yoho-memory';
    const credentialsServerName = flavor === 'codex' ? 'yoho_credentials' : 'yoho-credentials';

    // For codex flavor, skip aux MCP servers to avoid head-of-line blocking bug
    // in Codex binary (see https://github.com/openai/codex/issues/11816).
    // These tools are available through the yoho_remote MCP bridge instead.
    if (flavor === 'codex') {
        return {};
    }

    return {
        [memoryServerName]: {
            command: 'bun',
            args: ['run', `${homeDir}/happy/yoho-memory/src/mcp/stdio.ts`],
            cwd: `${homeDir}/happy/yoho-memory`,
            env,
        },
        [credentialsServerName]: {
            command: 'bun',
            args: ['run', `${homeDir}/happy/yoho-task-v2/mcp/credentials-server/index.ts`],
            cwd: `${homeDir}/happy/yoho-task-v2/mcp/credentials-server`,
            env,
        },
    };
}
