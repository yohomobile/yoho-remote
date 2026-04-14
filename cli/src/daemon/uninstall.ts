import { logger } from '@/ui/logger';
import { uninstall as uninstallMac } from './mac/uninstall';
import { uninstall as uninstallLinux } from './linux/uninstall';

export async function uninstall(): Promise<void> {
    if (process.platform === 'win32') {
        throw new Error('Daemon uninstallation as Windows service not yet supported. Use "yoho-remote daemon start".');
    }

    if (process.getuid && process.getuid() !== 0) {
        throw new Error('Daemon uninstallation requires sudo privileges. Please run with sudo.');
    }

    if (process.platform === 'darwin') {
        logger.info('Uninstalling yoho-remote daemon for macOS...');
        await uninstallMac();
        return;
    }

    if (process.platform === 'linux') {
        logger.info('Uninstalling yoho-remote daemon for Linux...');
        await uninstallLinux();
        return;
    }

    throw new Error(`Daemon uninstallation is not supported on platform "${process.platform}"`);
}
