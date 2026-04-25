import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  readFile: vi.fn(),
  spawn: vi.fn(),
  isBunCompiled: vi.fn(() => false),
  projectPath: vi.fn(() => '/repo'),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFile: mocks.readFile
}));

vi.mock('child_process', () => ({
  spawn: mocks.spawn
}));

vi.mock('@/projectPath', () => ({
  isBunCompiled: mocks.isBunCompiled,
  projectPath: mocks.projectPath
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn
  }
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true
  });
}

function makeChild(): EventEmitter & { pid: number } {
  return Object.assign(new EventEmitter(), { pid: 1234 });
}

function setSystemdProbe(present: boolean): void {
  mocks.existsSync.mockImplementation((path: string) => {
    if (path === '/repo/src/index.ts') return true;
    if (path === '/run/user/1000/systemd/private') return present;
    return false;
  });
}

describe('spawnYohoRemoteCLI systemd user scope', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    setPlatform('linux');
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    mocks.existsSync.mockImplementation((path: string) => path === '/repo/src/index.ts');
    mocks.spawn.mockImplementation(() => makeChild());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('re-probes user systemd availability on every spawn (unavailable → available)', async () => {
    const { spawnYohoRemoteCLI, SystemdScopeUnavailableError } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(false);
    expect(() =>
      spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-first' })
    ).toThrowError(SystemdScopeUnavailableError);

    setSystemdProbe(true);
    spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-second' });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([
        '--user',
        '--scope',
        '--collect',
        '--quiet',
        '--unit=yr-session-second',
        '--',
        process.execPath,
        expect.stringContaining('/repo/src/index.ts')
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: '/run/user/1000',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
        })
      })
    );
  });

  it('re-probes user systemd availability on every spawn (available → unavailable)', async () => {
    const { spawnYohoRemoteCLI, SystemdScopeUnavailableError } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(true);
    spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-up' });

    setSystemdProbe(false);
    expect(() =>
      spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-down' })
    ).toThrowError(SystemdScopeUnavailableError);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining(['--unit=yr-session-up']),
      expect.any(Object)
    );
    const probedPaths = mocks.existsSync.mock.calls
      .map((call) => call[0])
      .filter((path) => path === '/run/user/1000/systemd/private');
    expect(probedPaths).toHaveLength(2);
  });

  it('does not probe user systemd when systemdUnitName is omitted', async () => {
    const { spawnYohoRemoteCLI } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(true);
    spawnYohoRemoteCLI(['session', 'start']);
    spawnYohoRemoteCLI(['daemon', 'install'], { stdio: 'inherit' });

    const probedPaths = mocks.existsSync.mock.calls
      .map((call) => call[0])
      .filter((path) => path === '/run/user/1000/systemd/private');
    expect(probedPaths).toHaveLength(0);
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      expect.any(Array),
      {}
    );
  });

  it('throws SystemdScopeUnavailableError when systemd is unreachable + systemdUnitName provided', async () => {
    const { spawnYohoRemoteCLI, SystemdScopeUnavailableError } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(false);

    expect(() =>
      spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-fb' })
    ).toThrowError(SystemdScopeUnavailableError);

    expect(mocks.spawn).not.toHaveBeenCalled();
    const warned = mocks.loggerWarn.mock.calls.some((call) => {
      const msg = call.join(' ');
      return msg.includes('yr-session-fb');
    });
    expect(warned).toBe(true);
  });

  it('still allows plain spawn for callers that omit systemdUnitName entirely', async () => {
    const { spawnYohoRemoteCLI } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(false);
    spawnYohoRemoteCLI(['daemon', 'install'], { stdio: 'inherit' });

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('/repo/src/index.ts'), 'daemon', 'install']),
      { stdio: 'inherit' }
    );
  });

  it('SIGKILLs child when /proc/<pid>/cgroup does not contain the expected scope', async () => {
    const { spawnYohoRemoteCLI } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(true);
    const child = makeChild();
    mocks.spawn.mockReturnValueOnce(child);

    mocks.readFile.mockImplementation((_path: unknown, _enc: unknown, cb: (err: NodeJS.ErrnoException | null, data: string) => void) => {
      cb(null, '0::/user.slice/user-1000.slice/session-foreign.scope\n');
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-mismatch' });

    vi.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();

    expect(killSpy).toHaveBeenCalledWith(child.pid, 'SIGKILL');
    const warned = mocks.loggerWarn.mock.calls.some((call) => {
      const msg = call.map(String).join(' ');
      return msg.includes('yr-session-mismatch') && msg.includes('Killing child');
    });
    expect(warned).toBe(true);
  });

  it('warns at warn-level (not debug) on systemd-run spawn error', async () => {
    const { spawnYohoRemoteCLI } = await import('./spawnYohoRemoteCLI');

    setSystemdProbe(true);
    const child = makeChild();
    mocks.spawn.mockReturnValueOnce(child);

    spawnYohoRemoteCLI(['session', 'start'], {}, { systemdUnitName: 'yr-session-err' });

    child.emit('error', new Error('execve EACCES'));

    const warned = mocks.loggerWarn.mock.calls.some((call) => {
      const msg = call.map(String).join(' ');
      return msg.includes('systemd-run spawn error') && msg.includes('yr-session-err');
    });
    expect(warned).toBe(true);
  });
});
