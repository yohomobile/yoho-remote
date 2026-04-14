import { existsSync, unlinkSync } from 'node:fs';
import { logger } from '@/ui/logger';
import {
    SYSTEMD_SERVICE_NAME,
    SYSTEMD_SERVICE_PATH,
    getSystemdEnvFilePath,
    runSystemctl,
} from './systemd';

export async function uninstall(): Promise<void> {
    const envFilePath = getSystemdEnvFilePath();

    try {
        runSystemctl(['disable', '--now', SYSTEMD_SERVICE_NAME]);
    } catch {
        logger.info('Daemon service was not active');
    }

    if (existsSync(SYSTEMD_SERVICE_PATH)) {
        unlinkSync(SYSTEMD_SERVICE_PATH);
        logger.info(`Removed ${SYSTEMD_SERVICE_PATH}`);
    } else {
        logger.info('Systemd unit file not found');
    }

    if (existsSync(envFilePath)) {
        unlinkSync(envFilePath);
        logger.info(`Removed ${envFilePath}`);
    }

    runSystemctl(['daemon-reload']);
    logger.info('Daemon uninstalled successfully');
}
