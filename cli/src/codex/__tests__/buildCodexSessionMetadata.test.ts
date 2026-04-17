import { describe, expect, it } from 'vitest';

import { buildCodexSessionMetadata } from '../runCodex';

describe('buildCodexSessionMetadata', () => {
    it('includes mainSessionId for brain-child sessions', () => {
        const metadata = buildCodexSessionMetadata({
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            startedBy: 'daemon',
            sessionSource: 'brain-child',
            mainSessionId: 'brain-session-1',
        });

        expect(metadata.source).toBe('brain-child');
        expect(metadata.mainSessionId).toBe('brain-session-1');
    });

    it('omits mainSessionId when it is not provided', () => {
        const metadata = buildCodexSessionMetadata({
            workingDirectory: '/tmp/project',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sessionSource: 'webapp',
        });

        expect(metadata.source).toBe('webapp');
        expect(metadata.mainSessionId).toBeUndefined();
    });
});
