import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  basePath: string;
  worktreePath: string;
  branch: string;
  name: string;
  createdAt: number;
};

type WorktreeResult =
  | { ok: true; info: WorktreeInfo }
  | { ok: false; error: string };

export type RemoveWorktreeResult =
  | { ok: true }
  | { ok: false; error: string };

const MAX_ATTEMPTS = 5;

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('git', args, { cwd });
    return {
      stdout: result.stdout ? result.stdout.toString() : '',
      stderr: result.stderr ? result.stderr.toString() : ''
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const stderr = execError.stderr ? execError.stderr.toString() : '';
    const stdout = execError.stdout ? execError.stdout.toString() : '';
    const message = stderr.trim() || stdout.trim() || execError.message || 'Git command failed';
    throw new Error(message);
  }
}

async function resolveRepoRoot(basePath: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], basePath);
  const root = result.stdout.trim();
  if (!root) {
    throw new Error('Unable to resolve Git repository root.');
  }
  return root;
}

function toSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned;
}

function formatDatePrefix(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

function normalizeNameHint(nameHint?: string): string | null {
  if (!nameHint) {
    return null;
  }
  const trimmed = nameHint.trim();
  if (!trimmed) {
    return null;
  }
  const slug = toSlug(trimmed);
  return slug ? slug : null;
}

function makeDefaultBaseName(): string {
  const suffix = randomBytes(2).toString('hex');
  return `${formatDatePrefix()}-${suffix}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(options: {
  basePath: string;
  nameHint?: string;
  reuseExisting?: boolean;
}): Promise<WorktreeResult> {
  const { basePath, nameHint, reuseExisting = false } = options;
  let repoRoot: string;

  try {
    repoRoot = await resolveRepoRoot(basePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Path is not a Git repository: ${message}`
    };
  }

  const repoParent = dirname(repoRoot);
  const repoName = basename(repoRoot);
  const repoWorktreesRoot = join(repoParent, `${repoName}-worktrees`);
  await mkdir(repoWorktreesRoot, { recursive: true });

  const normalizedNameHint = normalizeNameHint(nameHint);
  const baseName = normalizedNameHint ?? makeDefaultBaseName();

  if (reuseExisting && normalizedNameHint) {
    const branch = normalizedNameHint;
    const worktreePath = join(repoWorktreesRoot, normalizedNameHint);

    if (await pathExists(worktreePath)) {
      const existing = await readExistingWorktree(repoRoot, worktreePath, normalizedNameHint);
      if (existing) {
        return { ok: true, info: existing };
      }
      return {
        ok: false,
        error: `Existing worktree path is invalid: ${worktreePath}`
      };
    }

    if (await branchExists(repoRoot, branch)) {
      try {
        await runGit(['worktree', 'add', worktreePath, branch], repoRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Failed to restore worktree: ${message}`
        };
      }

      const restored = await readExistingWorktree(repoRoot, worktreePath, normalizedNameHint);
      if (restored) {
        return { ok: true, info: restored };
      }
      return {
        ok: false,
        error: `Failed to validate restored worktree: ${worktreePath}`
      };
    }
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? baseName : `${baseName}-${randomBytes(2).toString('hex')}`;
    const branch = name;
    const worktreePath = join(repoWorktreesRoot, name);

    // If both directory and branch already exist, reuse the existing worktree
    if (await pathExists(worktreePath) && await branchExists(repoRoot, branch)) {
      return {
        ok: true,
        info: {
          basePath: repoRoot,
          worktreePath,
          branch,
          name,
          createdAt: Date.now()
        }
      };
    }

    // Only one of them exists — collision, try next name
    if (await pathExists(worktreePath) || await branchExists(repoRoot, branch)) {
      continue;
    }

    try {
      await runGit(['worktree', 'add', '-b', branch, worktreePath], repoRoot);
      return {
        ok: true,
        info: {
          basePath: repoRoot,
          worktreePath,
          branch,
          name,
          createdAt: Date.now()
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Failed to create worktree: ${message}`
      };
    }
  }

  return {
    ok: false,
    error: 'Failed to create worktree after multiple attempts. Try again.'
  };
}

async function readExistingWorktree(repoRoot: string, worktreePath: string, name: string): Promise<WorktreeInfo | null> {
  try {
    const resolvedWorktreeRoot = await resolveRepoRoot(worktreePath);
    if (resolvedWorktreeRoot !== worktreePath) {
      return null;
    }

    const commonDirResult = await runGit(['rev-parse', '--git-common-dir'], worktreePath);
    const commonDir = commonDirResult.stdout.trim();
    if (!commonDir) {
      return null;
    }

    const resolvedCommonDir = normalizeGitPath(commonDir, worktreePath);
    if (dirname(resolvedCommonDir) !== repoRoot) {
      return null;
    }

    const branchResult = await runGit(['symbolic-ref', '--short', 'HEAD'], worktreePath)
      .catch(() => runGit(['rev-parse', '--short', 'HEAD'], worktreePath));
    const branch = branchResult.stdout.trim();
    if (!branch) {
      return null;
    }

    return {
      basePath: repoRoot,
      worktreePath,
      branch,
      name,
      createdAt: await readCreatedAt(worktreePath)
    };
  } catch {
    return null;
  }
}

function normalizeGitPath(rawPath: string, cwd: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

async function readCreatedAt(worktreePath: string): Promise<number> {
  try {
    const info = await stat(worktreePath);
    const birthtimeMs = Math.round(info.birthtimeMs);
    if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) {
      return birthtimeMs;
    }

    const ctimeMs = Math.round(info.ctimeMs);
    if (Number.isFinite(ctimeMs) && ctimeMs > 0) {
      return ctimeMs;
    }
  } catch {
    return Date.now();
  }

  return Date.now();
}

export async function removeWorktree(options: {
  repoRoot: string;
  worktreePath: string;
}): Promise<RemoveWorktreeResult> {
  try {
    await runGit(['worktree', 'remove', '--force', options.worktreePath], options.repoRoot);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
