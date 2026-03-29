/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { isProcessAlive, killProcess } from '@/utils/process';

/**
 * Get the mtime of the daemon executable for version checking.
 * In split deployment mode (yoho-remote + yoho-remote-daemon), we always check yoho-remote-daemon's mtime
 * to ensure consistent version detection between daemon and sessions.
 */
export function getInstalledCliMtimeMs(): number | undefined {
  if (isBunCompiled()) {
    try {
      // Check if we're in split deployment mode (yoho-remote-daemon exists alongside yoho-remote)
      const execDir = dirname(process.execPath);
      const isWindows = process.platform === 'win32';
      const daemonExe = join(execDir, isWindows ? 'yoho-remote-daemon.exe' : 'yoho-remote-daemon');

      // If yoho-remote-daemon exists, use its mtime for consistent version checking
      if (existsSync(daemonExe)) {
        return statSync(daemonExe).mtimeMs;
      }

      // Fallback to current executable's mtime (unified deployment mode)
      return statSync(process.execPath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  const packageJsonPath = join(projectPath(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    return statSync(packageJsonPath).mtimeMs;
  } catch {
    return undefined;
  }
}

async function daemonPost(path: string, body?: any): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  if (!isProcessAlive(state.pid)) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = process.env.YR_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.YR_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });
    
    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage
      };
    }
    
    return await response.json();
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata
  });
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded yoho-remote,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `yoho-remote daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the daemon is running
  if (isProcessAlive(state.pid)) {
    return true;
  }

  logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
  await cleanupDaemonState();
  return false;
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  try {
    const currentCliMtimeMs = getInstalledCliMtimeMs();
    if (typeof currentCliMtimeMs === 'number' && typeof state.startedWithCliMtimeMs === 'number') {
      logger.debug(`[DAEMON CONTROL] Current CLI mtime: ${currentCliMtimeMs}, Daemon started with mtime: ${state.startedWithCliMtimeMs}`);
      return currentCliMtimeMs === state.startedWithCliMtimeMs;
    }

    const currentCliVersion = packageJson.version;
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;
    
    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // Kirill does not understand how the upgrade of npm packages happen and whether 
    // we will get a new path or not when yoho-remote is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades, 
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnYohoRemoteCLI } = await import('@/utils/spawnYohoRemoteCLI');
    const cliProcess = spawnYohoRemoteCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    cliProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => cliProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    const killed = await killProcess(state.pid, true);
    if (killed) {
      logger.debug('Force killed daemon');
    } else {
      logger.debug('Daemon already dead or could not be killed');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (isProcessAlive(pid)) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    return; // Process is dead
  }
  throw new Error('Process did not die within timeout');
}
