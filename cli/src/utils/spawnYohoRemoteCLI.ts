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

export class SystemdScopeUnavailableError extends Error {
  constructor(unitName: string) {
    super(
      `systemd-run --user --scope is required (unit=${unitName}) but per-user systemd is not reachable. `
      + `Daemon-spawned sessions would live in the daemon cgroup and be SIGKILLed on daemon restart. `
      + `Run \`sudo loginctl enable-linger $(whoami)\` and ensure user@<uid>.service is running.`
    );
    this.name = 'SystemdScopeUnavailableError';
  }
}

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
   * Hard requirement when set: if the per-user systemd manager is not
   * reachable, spawnYohoRemoteCLI throws SystemdScopeUnavailableError instead
   * of falling back to a plain spawn that would die on daemon restart.
   * Callers that legitimately want plain spawn must omit this field.
   * Availability is probed for every spawn — the per-user manager may appear
   * after daemon start once linger is enabled or the user logs in.
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
export function isUserSystemdAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  const uid = process.getuid?.();
  if (typeof uid !== 'number') return false;
  try {
    return existsSync(`/run/user/${uid}/systemd/private`);
  } catch {
    return false;
  }
}

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

  if (extras.systemdUnitName) {
    if (!isUserSystemdAvailable()) {
      logger.warn(
        `[SPAWN CLI] Refusing plain spawn for unit=${extras.systemdUnitName}: user systemd not reachable. `
        + `Throwing SystemdScopeUnavailableError so caller surfaces a real failure instead of a session that dies on daemon restart.`
      );
      throw new SystemdScopeUnavailableError(extras.systemdUnitName);
    }
    const wrapped = buildSystemdRunCommand(base.command, base.args, extras.systemdUnitName);
    const wrappedOptions = ensureUserBusEnv(options);
    logger.debug(`[SPAWN CLI] Wrapping in systemd-run --user --scope: unit=${extras.systemdUnitName}`);
    const child = spawn(wrapped.command, wrapped.args, wrappedOptions);
    attachSystemdScopeDiagnostics(child, extras.systemdUnitName);
    return child;
  }

  return spawn(base.command, base.args, options);
}

/**
 * Verifies that systemd-run actually placed the child in the requested scope.
 * If the target's /proc/<pid>/cgroup is missing the unit, SIGKILL it: the
 * session would otherwise live in the daemon cgroup and die on daemon restart.
 * Killing turns the silent failure into an early-exit the caller already
 * handles (no 15s webhook timeout).
 *
 * Spawn errors and non-zero early exits are surfaced via the existing
 * 'error'/'exit' events the daemon already listens for.
 */
function attachSystemdScopeDiagnostics(child: ChildProcess, unitName: string): void {
  child.on('error', (error) => {
    logger.warn(`[SPAWN CLI] systemd-run spawn error for unit=${unitName}: ${error instanceof Error ? error.message : String(error)}`);
  });

  const pid = child.pid;
  if (typeof pid !== 'number' || pid <= 0) return;

  setTimeout(() => {
    readFile(`/proc/${pid}/cgroup`, 'utf-8', (err, data) => {
      if (err) {
        logger.debug(`[SPAWN CLI] Unable to read /proc/${pid}/cgroup for diagnostics: ${err.message}`);
        return;
      }
      if (data.includes(`${unitName}.scope`)) {
        logger.debug(`[SPAWN CLI] Verified cgroup membership: pid=${pid} unit=${unitName}.scope`);
        return;
      }
      const currentCgroup = data.trim().split('\n').pop() ?? '(empty)';
      logger.warn(
        `[SPAWN CLI] pid=${pid} is NOT in expected scope ${unitName}.scope (current: ${currentCgroup}). `
        + `Killing child so spawn fails fast instead of running in the daemon cgroup.`
      );
      try {
        process.kill(pid, 'SIGKILL');
      } catch (killError) {
        logger.debug(`[SPAWN CLI] Failed to SIGKILL pid=${pid} after cgroup mismatch: ${killError instanceof Error ? killError.message : String(killError)}`);
      }
    });
  }, 300).unref();
}
