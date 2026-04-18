import type { ChildProcess } from 'node:child_process';
import spawn from 'cross-spawn';
import { delay } from '@/utils/time';

export const isWindows = (): boolean => process.platform === 'win32';

export type KillProcessOptions = {
  timeout?: number;
  force?: boolean;
};

export function getCurrentProcessStartedAtMs(): number {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  return startedAt > 0 ? startedAt : Date.now();
}

export function getProcessStartedAtMs(pid: number): number | null {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }

  try {
    const result = isWindows()
      ? spawn.sync('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`
        ], { stdio: 'pipe' })
      : spawn.sync('ps', ['-p', pid.toString(), '-o', 'lstart='], { stdio: 'pipe' });

    if (result.error || result.status !== 0) {
      return null;
    }

    const raw = result.stdout?.toString().trim();
    if (!raw) {
      return null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessWindows(pid: number, force: boolean): boolean {
  const args = ['/T', '/PID', pid.toString()];
  if (force) {
    args.unshift('/F');
  }
  try {
    const result = spawn.sync('taskkill', args, { stdio: 'pipe' });
    if (result.error) {
      return false;
    }
    return result.status === 0;
  } catch {
    return false;
  }
}

function normalizeKillOptions(optionsOrForce?: boolean | KillProcessOptions): KillProcessOptions {
  if (typeof optionsOrForce === 'boolean') {
    return { force: optionsOrForce };
  }
  return optionsOrForce ?? {};
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return !isProcessAlive(pid);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(Math.min(100, deadline - Date.now()));
  }

  return !isProcessAlive(pid);
}

export async function killProcess(
  target: number | ChildProcess,
  optionsOrForce: boolean | KillProcessOptions = false
): Promise<boolean> {
  const options = normalizeKillOptions(optionsOrForce);
  const force = options.force === true;
  const timeoutMs = options.timeout ?? 0;
  const pid = typeof target === 'number' ? target : target.pid;

  if (pid === null || pid === undefined || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const numericPid = pid;

  if (isWindows()) {
    if (force) {
      const killed = killProcessWindows(numericPid, true);
      if (!killed) {
        return false;
      }
      await waitForProcessExit(numericPid, Math.min(250, Math.max(0, timeoutMs)));
      return !isProcessAlive(numericPid);
    }
    const terminated = killProcessWindows(numericPid, false);
    if (!terminated) {
      return false;
    }
    if (timeoutMs > 0 && await waitForProcessExit(numericPid, timeoutMs)) {
      return true;
    }
    if (isProcessAlive(numericPid)) {
      killProcessWindows(numericPid, true);
      await waitForProcessExit(numericPid, Math.min(250, Math.max(0, timeoutMs)));
    }
    return !isProcessAlive(numericPid);
  }

  const sendSignal = (signal: 'SIGTERM' | 'SIGKILL'): boolean => {
    try {
      if (typeof target === 'number') {
        process.kill(numericPid, signal);
      } else {
        target.kill(signal);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (force) {
    const killed = sendSignal('SIGKILL');
    if (!killed) {
      return false;
    }
    await waitForProcessExit(numericPid, Math.min(250, Math.max(0, timeoutMs)));
    return !isProcessAlive(numericPid);
  }

  if (!sendSignal('SIGTERM')) {
    return false;
  }

  if (timeoutMs > 0 && await waitForProcessExit(numericPid, timeoutMs)) {
    return true;
  }

  if (isProcessAlive(numericPid)) {
    sendSignal('SIGKILL');
    await waitForProcessExit(numericPid, Math.min(250, Math.max(0, timeoutMs)));
  }

  return !isProcessAlive(numericPid);
}

export async function killProcessByChildProcess(
  child: ChildProcess,
  optionsOrForce: boolean | KillProcessOptions = false
): Promise<boolean> {
  return killProcess(child, optionsOrForce);
}
