import { logger } from '@/ui/logger';
import { install as installMac } from './mac/install';
import { install as installLinux } from './linux/install';

export async function install(): Promise<void> {
    if (process.platform === 'win32') {
        throw new Error('Daemon installation as Windows service not yet supported. Use "yoho-remote daemon start".');
    }

    if (process.getuid && process.getuid() !== 0) {
        throw new Error('Daemon installation requires sudo privileges. Please run with sudo.');
    }

    if (process.platform === 'darwin') {
        logger.info('Installing yoho-remote daemon for macOS...');
        await installMac();
        return;
    }

    if (process.platform === 'linux') {
        logger.info('Installing yoho-remote daemon for Linux...');
        await installLinux();
        return;
    }

    throw new Error(`Daemon installation is not supported on platform "${process.platform}"`);
}
