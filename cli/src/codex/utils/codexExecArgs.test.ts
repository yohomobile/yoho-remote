import { describe, expect, it } from 'vitest';

import { buildCodexExecArgs, buildMcpConfigFlags } from './codexExecArgs';

describe('buildCodexExecArgs', () => {
    const baseOptions = {
        permissionMode: 'default' as const,
        startConfig: {
            prompt: 'hello',
            model: 'gpt-5.4',
            model_reasoning_effort: 'high' as const,
            service_tier: 'flex' as const,
        },
        mcpServers: {
            yoho_remote: {
                command: 'yoho-remote',
                args: ['mcp', '--url', 'http://127.0.0.1:3000/mcp'],
            },
        },
        prompt: 'hello',
    };

    it('adds --skip-git-repo-check for daemon-managed sessions when requested', () => {
        const args = buildCodexExecArgs({
            ...baseOptions,
            threadId: null,
            skipGitRepoCheck: true,
        });

        expect(args).toContain('--skip-git-repo-check');
        expect(args).toContain('--sandbox');
        expect(args).toContain('workspace-write');
        expect(args.at(-1)).toBe('hello');
    });

    it('does not add --skip-git-repo-check by default', () => {
        const args = buildCodexExecArgs({
            ...baseOptions,
            threadId: 'thread-123',
        });

        expect(args).toEqual(expect.arrayContaining(['exec', 'resume', 'thread-123', '--json']));
        expect(args).not.toContain('--skip-git-repo-check');
    });

    it('serializes config overrides for exec sessions', () => {
        const args = buildCodexExecArgs({
            ...baseOptions,
            threadId: null,
            startConfig: {
                ...baseOptions.startConfig,
                config: {
                    developer_instructions: 'Brain only\nUse runtime tools.',
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
                },
            },
        });

        expect(args).toEqual(expect.arrayContaining([
            '-c', 'developer_instructions="Brain only\\nUse runtime tools."',
            '-c', 'features.multi_agent=false',
            '-c', 'features.shell_tool=false',
            '-c', 'mcp_servers.yoho_remote.required=true',
            '-c', 'web_search="live"',
        ]));
    });

    it('escapes MCP command, args, cwd, and env values safely', () => {
        const flags = buildMcpConfigFlags({
            yoho_remote: {
                command: 'C:\\Program Files\\Codex\\codex.exe',
                args: ['mcp', '--url', 'http://127.0.0.1:3000/mcp?note="quoted"\nnext'],
                cwd: 'C:\\Users\\brain workspace',
                env: {
                    JSON_PAYLOAD: '{"ok":true}',
                },
            },
        });

        expect(flags).toEqual(expect.arrayContaining([
            '-c', 'mcp_servers.yoho_remote.command="C:\\\\Program Files\\\\Codex\\\\codex.exe"',
            '-c', 'mcp_servers.yoho_remote.args=["mcp", "--url", "http://127.0.0.1:3000/mcp?note=\\"quoted\\"\\nnext"]',
            '-c', 'mcp_servers.yoho_remote.cwd="C:\\\\Users\\\\brain workspace"',
            '-c', 'mcp_servers.yoho_remote.env.JSON_PAYLOAD="{\\"ok\\":true}"',
        ]));
    });
});
