import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    loggerInfo: vi.fn(),
    prepareSystemdInstall: vi.fn(),
    runSystemctl: vi.fn(),
    writeSystemdServiceFile: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        info: mocks.loggerInfo,
    },
}));

vi.mock('./systemd', () => ({
    SYSTEMD_SERVICE_NAME: 'yoho-remote-daemon.service',
    SYSTEMD_SERVICE_PATH: '/etc/systemd/system/yoho-remote-daemon.service',
    prepareSystemdInstall: mocks.prepareSystemdInstall,
    runSystemctl: mocks.runSystemctl,
    writeSystemdServiceFile: mocks.writeSystemdServiceFile,
}));

import { install } from './install';

describe('linux daemon install', () => {
    beforeEach(() => {
        mocks.loggerInfo.mockReset();
        mocks.prepareSystemdInstall.mockReset();
        mocks.runSystemctl.mockReset();
        mocks.writeSystemdServiceFile.mockReset();
    });

    it('uses enable --now on first install', async () => {
        mocks.prepareSystemdInstall.mockResolvedValue({
            envFileChanged: true,
            envFilePath: '/home/yoho/.yoho-remote/daemon.systemd.env',
            execParts: ['/opt/yoho-remote/yoho-remote-daemon'],
            serviceUser: 'yoho',
            workingDirectory: '/home/yoho/.yoho-remote',
        });
        mocks.writeSystemdServiceFile.mockReturnValue({ existed: false, changed: true });

        await install();

        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(1, ['daemon-reload']);
        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(2, ['enable', '--now', 'yoho-remote-daemon.service']);
        expect(mocks.runSystemctl).toHaveBeenCalledTimes(2);
    });

    it('restarts an existing service when the unit changes', async () => {
        mocks.prepareSystemdInstall.mockResolvedValue({
            envFileChanged: false,
            envFilePath: '/home/yoho/.yoho-remote/daemon.systemd.env',
            execParts: ['/opt/yoho-remote/yoho-remote-daemon'],
            serviceUser: 'yoho',
            workingDirectory: '/home/yoho/.yoho-remote',
        });
        mocks.writeSystemdServiceFile.mockReturnValue({ existed: true, changed: true });

        await install();

        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(1, ['daemon-reload']);
        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(2, ['enable', 'yoho-remote-daemon.service']);
        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(3, ['restart', 'yoho-remote-daemon.service']);
        expect(mocks.runSystemctl).toHaveBeenCalledTimes(3);
    });

    it('restarts an existing service when the environment file changes', async () => {
        mocks.prepareSystemdInstall.mockResolvedValue({
            envFileChanged: true,
            envFilePath: '/home/yoho/.yoho-remote/daemon.systemd.env',
            execParts: ['/opt/yoho-remote/yoho-remote-daemon'],
            serviceUser: 'yoho',
            workingDirectory: '/home/yoho/.yoho-remote',
        });
        mocks.writeSystemdServiceFile.mockReturnValue({ existed: true, changed: false });

        await install();

        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(1, ['daemon-reload']);
        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(2, ['enable', 'yoho-remote-daemon.service']);
        expect(mocks.runSystemctl).toHaveBeenNthCalledWith(3, ['restart', 'yoho-remote-daemon.service']);
        expect(mocks.runSystemctl).toHaveBeenCalledTimes(3);
    });
});
