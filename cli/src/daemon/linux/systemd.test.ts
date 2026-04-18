import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    configuration: {
        serverUrl: 'https://remote.example.com',
        yohoRemoteHomeDir: '/custom/.yoho-remote',
    },
    execFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    userInfo: vi.fn(),
    writeFileSync: vi.fn(),
}));

vi.mock('@/configuration', () => ({
    configuration: mocks.configuration,
}));

vi.mock('node:child_process', () => ({
    execFileSync: mocks.execFileSync,
}));

vi.mock('node:fs', () => ({
    existsSync: mocks.existsSync,
    mkdirSync: mocks.mkdirSync,
    readFileSync: mocks.readFileSync,
    writeFileSync: mocks.writeFileSync,
}));

vi.mock('node:os', () => ({
    default: {
        userInfo: mocks.userInfo,
    },
}));

import {
    SYSTEMD_SERVICE_PATH,
    buildSystemdServiceFile,
    type InstallContext,
    writeSystemdServiceFile,
} from './systemd';

describe('linux systemd helpers', () => {
    const context: InstallContext = {
        envFilePath: '/home/yoho/.yoho-remote/daemon.systemd.env',
        execParts: ['/opt/yoho-remote/yoho-remote-daemon'],
        serviceUser: 'yoho',
        workingDirectory: '/home/yoho/.yoho-remote',
    };

    beforeEach(() => {
        mocks.execFileSync.mockReset();
        mocks.existsSync.mockReset();
        mocks.mkdirSync.mockReset();
        mocks.readFileSync.mockReset();
        mocks.userInfo.mockReset();
        mocks.writeFileSync.mockReset();
    });

    it('builds a systemd unit with the expected network and kill semantics', () => {
        const unit = buildSystemdServiceFile(context);

        expect(unit).toContain('After=network-online.target');
        expect(unit).toContain('Wants=network-online.target');
        expect(unit).toContain('Environment=YR_DAEMON_UNDER_SYSTEMD=1');
        expect(unit).toContain('KillMode=control-group');
        expect(unit).toContain('RestartSec=10');
    });

    it('reports whether rewriting the service file changed the managed unit', () => {
        mocks.existsSync.mockImplementation((path: string) => path === SYSTEMD_SERVICE_PATH);
        mocks.readFileSync.mockReturnValue('legacy service file');

        const result = writeSystemdServiceFile(context);

        expect(result).toEqual({ existed: true, changed: true });
        expect(mocks.writeFileSync).toHaveBeenCalledTimes(1);
        expect(mocks.writeFileSync).toHaveBeenCalledWith(
            SYSTEMD_SERVICE_PATH,
            expect.stringContaining('KillMode=control-group'),
            { mode: 0o644 },
        );
    });

    it('skips rewriting the service file when it already matches the managed template', () => {
        mocks.existsSync.mockImplementation((path: string) => path === SYSTEMD_SERVICE_PATH);
        mocks.readFileSync.mockReturnValue(buildSystemdServiceFile(context));

        const result = writeSystemdServiceFile(context);

        expect(result).toEqual({ existed: true, changed: false });
        expect(mocks.writeFileSync).not.toHaveBeenCalled();
    });
});
