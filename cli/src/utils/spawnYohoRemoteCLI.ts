/**
 * Cross-platform CLI spawning utility
 *
 * Handles spawning CLI subprocesses (for daemon processes) in a cross-platform way,
 * detecting the current runtime mode (compiled binary vs development) and using
 * the appropriate command and arguments.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join, dirname, basename } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync, readFile } from 'node:fs';

/**
 * Check if we're running as a standalone daemon/server executable (not the main CLI)
 */
function isStandaloneExecutable(): boolean {
  const execName = basename(process.execPath);
  return execName === 'yoho-remote-daemon' || execName === 'yoho-remote-daemon.exe' ||
         execName === 'yoho-remote-server' || execName === 'yoho-remote-server.exe';
}

/**
 * Get the path to the main CLI executable when running as standalone daemon/server.
 * Looks for 'yoho-remote' binary in the same directory as the current executable.
 */
function getMainCliExecutable(): string | null {
  if (!isStandaloneExecutable()) {
    return null;
  }

  const execDir = dirname(process.execPath);
  const isWindows = process.platform === 'win32';
  const cliExe = join(execDir, isWindows ? 'yoho-remote.exe' : 'yoho-remote');

  if (existsSync(cliExe)) {
    return cliExe;
  }

  return null;
}

/**
 * Look for a compiled yoho-remote binary in the project's dist-exe directory.
 * Returns the path if found, null otherwise.
 */
function findCompiledCli(projectRoot: string): string | null {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const exeName = process.platform === 'win32' ? 'yoho-remote.exe' : 'yoho-remote';
  const candidate = join(projectRoot, 'dist-exe', `bun-${platform}-${arch}`, exeName);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the TypeScript entrypoint for development mode.
 */
function resolveEntrypoint(projectRoot: string): string {
  const srcEntrypoint = join(projectRoot, 'src', 'index.ts');
  if (existsSync(srcEntrypoint)) {
    return srcEntrypoint;
  }

  throw new Error('No CLI entrypoint found (expected src/index.ts)');
}

export interface YohoRemoteCliCommand {
  command: string;
  args: string[];
}

export function getYohoRemoteCliCommand(args: string[]): YohoRemoteCliCommand {
  // Compiled binary mode: just use the executable directly
  if (isBunCompiled()) {
    // Check if we're running as standalone daemon/server
    // In that case, we need to use the main CLI executable for spawning sessions
    const mainCli = getMainCliExecutable();
    if (mainCli) {
      logger.debug(`[SPAWN CLI] Using main executable: ${mainCli}`);
      return {
        command: mainCli,
        args
      };
    }

    return {
      command: process.execPath,
      args
    };
  }

  // Check if a compiled yoho-remote binary exists alongside project files
  // This handles the case where the daemon runs via Node.js/tsx but sessions
  // should use the compiled Bun executable (e.g. macmini setup)
  const projectRoot = projectPath();
  const compiledCli = findCompiledCli(projectRoot);
  if (compiledCli) {
    logger.debug(`[SPAWN CLI] Using compiled CLI binary: ${compiledCli}`);
    return {
      command: compiledCli,
      args
    };
  }

  // Development mode: spawn with TypeScript entrypoint
  const entrypoint = resolveEntrypoint(projectRoot);
  const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);

  if (isBunRuntime) {
    // Bun can run TypeScript directly
    return {
      command: process.execPath,
      args: [entrypoint, ...args]
    };
  }

  // Node.js fallback: preserve execArgv (for compatibility)
  return {
    command: process.execPath,
    args: [...process.execArgv, entrypoint, ...args]
  };
}

export interface YohoRemoteCliSpawnExtras {
  /**
   * When set on Linux under systemd (daemon.service with User= set and the
   * per-user systemd manager reachable), wrap the spawn in
   * `systemd-run --user --scope --unit=<name>`. This puts the session in its
   * own transient scope cgroup, escaping `yoho-remote-daemon.service`'s
   * control-group. Without it, `systemctl restart yoho-remote-daemon`
   * SIGKILLs every session via KillMode=control-group — regardless of
   * child_process detached / setsid, because cgroup != process group.
   *
   * No-op when user-systemd is not reachable; spawn falls back to the plain
   * path and the caller gets the same behaviour as before.
   */
  systemdUnitName?: string;
}

/**
 * Probe whether the per-user systemd manager is actually reachable.
 *
 * The directory `/run/user/$UID/systemd` can exist as a bind-mount relic even
 * when `user@$UID.service` has exited, so we require the `private` socket to
 * also be present. This is the same file `systemd-run --user` connects to.
 */
const USER_SYSTEMD_AVAILABLE: boolean = (() => {
  if (process.platform !== 'linux') return false;
  const uid = process.getuid?.();
  if (typeof uid !== 'number') return false;
  try {
    return existsSync(`/run/user/${uid}/systemd/private`);
  } catch {
    return false;
  }
})();

function buildSystemdRunCommand(
  baseCommand: string,
  baseArgs: string[],
  unitName: string
): YohoRemoteCliCommand {
  // --user: talk to the per-user systemd manager (daemon runs as a user)
  // --scope: systemd-run exec()s into the target — child.pid IS the session pid
  // --collect: auto-remove the scope unit after exit (incl. failed state)
  // --quiet: suppress "Running scope as unit" on stderr
  const systemdArgs = [
    '--user',
    '--scope',
    '--collect',
    '--quiet',
    `--unit=${unitName}`,
    '--',
    baseCommand,
    ...baseArgs
  ];
  return { command: 'systemd-run', args: systemdArgs };
}

function ensureUserBusEnv(options: SpawnOptions): SpawnOptions {
  const uid = process.getuid?.() ?? 0;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  const dbusAddr = process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${xdgRuntime}/bus`;
  const baseEnv = (options.env ?? process.env) as NodeJS.ProcessEnv;
  return {
    ...options,
    env: {
      ...baseEnv,
      XDG_RUNTIME_DIR: xdgRuntime,
      DBUS_SESSION_BUS_ADDRESS: dbusAddr
    }
  };
}

export function spawnYohoRemoteCLI(
  args: string[],
  options: SpawnOptions = {},
  extras: YohoRemoteCliSpawnExtras = {}
): ChildProcess {

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  const fullCommand = `cli ${args.join(' ')}`;
  logger.debug(`[SPAWN CLI] Spawning: ${fullCommand} in ${directory}`);

  const base = getYohoRemoteCliCommand(args);

  // Sanity check that the entrypoint path exists
  if (!isBunCompiled()) {
    const entrypoint = base.args.find((arg) => arg.endsWith('index.ts'));
    if (entrypoint && !existsSync(entrypoint)) {
      const errorMessage = `Entrypoint ${entrypoint} does not exist`;
      logger.debug(`[SPAWN CLI] ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  if (extras.systemdUnitName && USER_SYSTEMD_AVAILABLE) {
    const wrapped = buildSystemdRunCommand(base.command, base.args, extras.systemdUnitName);
    const wrappedOptions = ensureUserBusEnv(options);
    logger.debug(`[SPAWN CLI] Wrapping in systemd-run --user --scope: unit=${extras.systemdUnitName}`);
    const child = spawn(wrapped.command, wrapped.args, wrappedOptions);
    attachSystemdScopeDiagnostics(child, extras.systemdUnitName);
    return child;
  }

  if (extras.systemdUnitName && !USER_SYSTEMD_AVAILABLE) {
    // Falling back means the session will live in the daemon's cgroup and die
    // on `systemctl restart yoho-remote-daemon`. Log loudly so the operator
    // notices and fixes the environment (e.g. `loginctl enable-linger`).
    logger.debug(
      `[SPAWN CLI] WARNING: systemdUnitName=${extras.systemdUnitName} requested but user systemd is not reachable; `
        + `session will run in the parent's cgroup and will NOT survive daemon restart. `
        + `Run \`sudo loginctl enable-linger $(whoami)\` to fix.`
    );
  }

  return spawn(base.command, base.args, options);
}

/**
 * Attach best-effort diagnostics to a child process wrapped in `systemd-run
 * --user --scope`. None of these are blocking: they only log.
 *
 *   1. If systemd-run exits non-zero within the first 500ms, the target likely
 *      never execed into its own scope — surface the exit code.
 *   2. If the target's /proc/<pid>/cgroup does not contain our scope unit,
 *      surface a warning — this indicates the session is still in the daemon's
 *      cgroup and would be killed on daemon restart.
 */
function attachSystemdScopeDiagnostics(child: ChildProcess, unitName: string): void {
  child.on('error', (error) => {
    logger.debug(`[SPAWN CLI] systemd-run spawn error for unit=${unitName}:`, error);
  });

  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) return;

  // Give systemd-run ~300ms to exec into the target; then peek /proc.
  setTimeout(() => {
    readFile(`/proc/${pid}/cgroup`, 'utf-8', (err, data) => {
      if (err) {
        // Process may have exited legitimately already; silent unless debugging.
        logger.debug(`[SPAWN CLI] Unable to read /proc/${pid}/cgroup for diagnostics: ${err.message}`);
        return;
      }
      if (data.includes(`${unitName}.scope`)) {
        logger.debug(`[SPAWN CLI] Verified cgroup membership: pid=${pid} unit=${unitName}.scope`);
        return;
      }
      logger.debug(
        `[SPAWN CLI] WARNING: pid=${pid} is NOT in expected scope ${unitName}.scope. `
          + `Current cgroup: ${data.trim().split('\n').pop() ?? '(empty)'}. `
          + `Session may die on daemon restart.`
      );
    });
  }, 300).unref();
}
