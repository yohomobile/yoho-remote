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

        expect(args[0]).toBe('exec');
        expect(args).toContain('--skip-git-repo-check');
        expect(args).toContain('--sandbox');
        expect(args).toContain('workspace-write');
        expect(args).not.toContain('resume');
        expect(args.at(-1)).toBe('hello');
    });

    it('places resume subcommand after all exec-level flags', () => {
        const args = buildCodexExecArgs({
            ...baseOptions,
            threadId: 'thread-123',
        });

        const resumeIndex = args.indexOf('resume');
        expect(args[0]).toBe('exec');
        expect(resumeIndex).toBeGreaterThan(0);
        expect(args[resumeIndex + 1]).toBe('thread-123');
        expect(args.at(-1)).toBe('hello');

        // All exec-level flags must appear before `resume <id>`
        const jsonIndex = args.indexOf('--json');
        const sandboxIndex = args.indexOf('--sandbox');
        const modelIndex = args.indexOf('-m');
        expect(jsonIndex).toBeGreaterThan(-1);
        expect(jsonIndex).toBeLessThan(resumeIndex);
        expect(sandboxIndex).toBeGreaterThan(-1);
        expect(sandboxIndex).toBeLessThan(resumeIndex);
        expect(modelIndex).toBeGreaterThan(-1);
        expect(modelIndex).toBeLessThan(resumeIndex);

        // No --skip-git-repo-check when flag is not requested
        expect(args).not.toContain('--skip-git-repo-check');
    });

    it('places safe-yolo and skip-git-repo-check flags before resume subcommand', () => {
        const args = buildCodexExecArgs({
            ...baseOptions,
            threadId: 'thread-123',
            permissionMode: 'safe-yolo',
            skipGitRepoCheck: true,
        });

        const resumeIndex = args.indexOf('resume');
        const fullAutoIndex = args.indexOf('--full-auto');
        const skipGitIndex = args.indexOf('--skip-git-repo-check');

        expect(args[0]).toBe('exec');
        expect(resumeIndex).toBeGreaterThan(0);
        expect(args[resumeIndex + 1]).toBe('thread-123');
        expect(fullAutoIndex).toBeGreaterThan(-1);
        expect(fullAutoIndex).toBeLessThan(resumeIndex);
        expect(skipGitIndex).toBeGreaterThan(-1);
        expect(skipGitIndex).toBeLessThan(resumeIndex);
        // safe-yolo uses --full-auto instead of explicit --sandbox
        expect(args).not.toContain('--sandbox');
    });

    it('places yolo bypass flag before resume subcommand', () => {
        const args = buildCodexExecArgs({
            ...baseOptions,
            threadId: 'thread-123',
            permissionMode: 'yolo',
        });

        const resumeIndex = args.indexOf('resume');
        const yoloIndex = args.indexOf('--dangerously-bypass-approvals-and-sandbox');

        expect(yoloIndex).toBeGreaterThan(-1);
        expect(yoloIndex).toBeLessThan(resumeIndex);
        expect(args).not.toContain('--sandbox');
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
