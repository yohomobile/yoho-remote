import fs from 'fs/promises';
import { join } from 'path';

import { configuration } from '@/configuration';

export async function createDaemonCodexHomeDir(
    prefix: string,
    options?: {
        yohoRemoteHomeDir?: string;
    }
): Promise<string> {
    const yohoRemoteHomeDir = options?.yohoRemoteHomeDir ?? configuration.yohoRemoteHomeDir;
    const rootDir = join(yohoRemoteHomeDir, 'tmp');
    await fs.mkdir(rootDir, { recursive: true });
    return await fs.mkdtemp(join(rootDir, prefix));
}
