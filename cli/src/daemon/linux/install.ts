import { logger } from '@/ui/logger';
import {
    SYSTEMD_SERVICE_NAME,
    SYSTEMD_SERVICE_PATH,
    prepareSystemdInstall,
    runSystemctl,
    writeSystemdServiceFile,
} from './systemd';

export async function install(): Promise<void> {
    const context = await prepareSystemdInstall();
    writeSystemdServiceFile(context);

    logger.info(`Wrote systemd unit to ${SYSTEMD_SERVICE_PATH}`);
    logger.info(`Wrote daemon environment file to ${context.envFilePath}`);

    runSystemctl(['daemon-reload']);
    runSystemctl(['enable', '--now', SYSTEMD_SERVICE_NAME]);

    logger.info('Daemon installed and started successfully');
    logger.info(`Check status with: systemctl status ${SYSTEMD_SERVICE_NAME}`);
    logger.info(`Check logs with: journalctl -u ${SYSTEMD_SERVICE_NAME} -f`);
}
