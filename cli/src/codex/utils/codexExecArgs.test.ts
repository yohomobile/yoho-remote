import { describe, expect, it } from 'vitest';

import { buildCodexExecArgs } from './codexExecArgs';

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
});
