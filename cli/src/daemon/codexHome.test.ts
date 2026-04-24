import { existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDaemonCodexHomeDir } from './codexHome';

describe('createDaemonCodexHomeDir', () => {
    const createdRoots: string[] = [];

    afterEach(async () => {
        await Promise.all(createdRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('creates session-scoped Codex homes under yoho remote home tmp', async () => {
        const yohoRemoteHomeDir = await mkdtemp(join(tmpdir(), 'yoho-remote-home-'));
        createdRoots.push(yohoRemoteHomeDir);

        const codexHomeDir = await createDaemonCodexHomeDir('yr-codex-', {
            yohoRemoteHomeDir,
        });

        expect(codexHomeDir.startsWith(join(yohoRemoteHomeDir, 'tmp', 'yr-codex-'))).toBe(true);
        expect(existsSync(codexHomeDir)).toBe(true);
    });

    it('supports a separate prefix for Codex token source homes', async () => {
        const yohoRemoteHomeDir = await mkdtemp(join(tmpdir(), 'yoho-remote-home-'));
        createdRoots.push(yohoRemoteHomeDir);

        const codexHomeDir = await createDaemonCodexHomeDir('yr-codex-provider-', {
            yohoRemoteHomeDir,
        });

        expect(codexHomeDir.startsWith(join(yohoRemoteHomeDir, 'tmp', 'yr-codex-provider-'))).toBe(true);
        expect(existsSync(codexHomeDir)).toBe(true);
    });
});
