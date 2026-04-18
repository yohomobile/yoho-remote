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
    const unitFileResult = writeSystemdServiceFile(context);
    const configChanged = unitFileResult.changed || context.envFileChanged;

    logger.info(`${unitFileResult.existed ? 'Updated' : 'Wrote'} systemd unit at ${SYSTEMD_SERVICE_PATH}`);
    logger.info(`${context.envFileChanged ? 'Updated' : 'Checked'} daemon environment file at ${context.envFilePath}`);

    runSystemctl(['daemon-reload']);
    if (unitFileResult.existed && configChanged) {
        logger.info('Detected daemon systemd configuration drift or environment changes; restarting service to apply the updated unit');
        runSystemctl(['enable', SYSTEMD_SERVICE_NAME]);
        runSystemctl(['restart', SYSTEMD_SERVICE_NAME]);
    } else {
        runSystemctl(['enable', '--now', SYSTEMD_SERVICE_NAME]);
    }

    logger.info('Daemon installed and started successfully');
    logger.info(`Check status with: systemctl status ${SYSTEMD_SERVICE_NAME}`);
    logger.info(`Check logs with: journalctl -u ${SYSTEMD_SERVICE_NAME} -f`);
}
