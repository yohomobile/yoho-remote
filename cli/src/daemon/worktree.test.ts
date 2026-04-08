import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from './worktree';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<void> {
    await execFileAsync('git', args, { cwd });
}

describe('createWorktree naming', () => {
    let tempDir: string;
    let repoRoot: string;

    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'yr-worktree-'));
        repoRoot = join(tempDir, 'repo');
        await mkdir(repoRoot, { recursive: true });
        await runGit(['init', '--initial-branch=main'], repoRoot);
        await runGit(['config', 'user.name', 'Test User'], repoRoot);
        await runGit(['config', 'user.email', 'test@example.com'], repoRoot);
        await writeFile(join(repoRoot, 'README.md'), 'hello\n');
        await runGit(['add', 'README.md'], repoRoot);
        await runGit(['commit', '-m', 'init'], repoRoot);
    });

    afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it('preserves underscores in personal worktree names', async () => {
        const result = await createWorktree({
            basePath: repoRoot,
            nameHint: 'guang_yang',
            reuseExisting: true
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            throw new Error(result.error);
        }

        expect(result.info.name).toBe('guang_yang');
        expect(result.info.branch).toBe('yr-guang_yang');
        expect(result.info.worktreePath).toBe(join(tempDir, 'repo-worktrees', 'guang_yang'));

        const removed = await removeWorktree({
            repoRoot,
            worktreePath: result.info.worktreePath
        });
        expect(removed.ok).toBe(true);
    });

    it('still converts generic separators to hyphens', async () => {
        const result = await createWorktree({
            basePath: repoRoot,
            nameHint: 'feature test'
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            throw new Error(result.error);
        }

        expect(result.info.name).toBe('feature-test');
        expect(result.info.branch).toBe('yr-feature-test');

        const removed = await removeWorktree({
            repoRoot,
            worktreePath: result.info.worktreePath
        });
        expect(removed.ok).toBe(true);
    });
})
