import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import * as watcherModule from '@/modules/watcher/startFileWatcher';
import { logger } from '@/ui/logger';
import { createCodexSessionScanner } from './codexSessionScanner';
import type { CodexSessionEvent } from './codexEventConverter';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('codexSessionScanner', () => {
    let testDir: string;
    let sessionsDir: string;
    let sessionFile: string;
    let originalCodexHome: string | undefined;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
    let events: CodexSessionEvent[] = [];

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-scanner-${Date.now()}`);
        sessionsDir = join(testDir, 'sessions', '2025', '12', '22');
        await mkdir(sessionsDir, { recursive: true });

        originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = testDir;

        events = [];
    });

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }
        vi.restoreAllMocks();

        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }

        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('emits only new events after startup', async () => {
        const sessionId = 'session-123';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        const initialLines = [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
        ];

        await writeFile(sessionFile, initialLines.join('\n') + '\n');

        scanner = await createCodexSessionScanner({
            sessionId,
            onEvent: (event) => events.push(event)
        });

        await wait(150);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-1', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('limits session scan to dates within the start window', async () => {
        const referenceTimestampMs = Date.parse('2025-12-22T00:00:30.000Z');
        const windowMs = 2 * 60 * 1000;
        const matchingSessionId = 'session-222';
        const outsideSessionId = 'session-999';
        const outsideDir = join(testDir, 'sessions', '2025', '12', '20');
        const matchingFile = join(sessionsDir, `codex-${matchingSessionId}.jsonl`);
        const outsideFile = join(outsideDir, `codex-${outsideSessionId}.jsonl`);

        await mkdir(outsideDir, { recursive: true });
        const baseLines = [
            JSON.stringify({ type: 'session_meta', payload: { id: matchingSessionId, cwd: '/data/github/yoho-remote', timestamp: '2025-12-22T00:00:00.000Z' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
        ];
        await writeFile(matchingFile, baseLines.join('\n') + '\n');
        await writeFile(
            outsideFile,
            JSON.stringify({ type: 'session_meta', payload: { id: outsideSessionId, cwd: '/data/github/yoho-remote', timestamp: '2025-12-20T00:00:00.000Z' } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: '/data/github/yoho-remote',
            startupTimestampMs: referenceTimestampMs,
            sessionStartWindowMs: windowMs,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-2', arguments: '{}' }
        });
        await appendFile(matchingFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('emits response_item events even when payload.id is a tool call id', async () => {
        const sessionId = 'session-response-item';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: '/data/github/yoho-remote', timestamp: '2025-12-22T00:00:00.000Z' } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId,
            onEvent: (event) => events.push(event)
        });

        await wait(150);

        await appendFile(
            sessionFile,
            JSON.stringify({ type: 'response_item', payload: { type: 'function_call', id: 'call-1', name: 'Tool', arguments: '{}' } }) + '\n'
        );

        await wait(150);

        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('warns when multiple Codex sessions match the window and picks the closest one', async () => {
        const referenceTimestampMs = Date.parse('2025-12-22T00:00:30.000Z');
        const windowMs = 2 * 60 * 1000;
        const closerSessionId = 'session-closer';
        const fartherSessionId = 'session-farther';
        const closerFile = join(sessionsDir, `codex-${closerSessionId}.jsonl`);
        const fartherFile = join(sessionsDir, `codex-${fartherSessionId}.jsonl`);
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        let foundSessionId: string | null = null;

        await writeFile(
            fartherFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: fartherSessionId, cwd: '/data/github/yoho-remote', timestamp: '2025-12-22T00:00:05.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'farther' } })
            ].join('\n') + '\n'
        );
        await writeFile(
            closerFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: closerSessionId, cwd: '/data/github/yoho-remote', timestamp: '2025-12-22T00:00:25.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'closer' } })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: '/data/github/yoho-remote',
            startupTimestampMs: referenceTimestampMs,
            sessionStartWindowMs: windowMs,
            onSessionFound: (sessionId) => {
                foundSessionId = sessionId;
            },
            onEvent: (event) => events.push(event)
        });

        await wait(200);

        expect(foundSessionId).toBe(closerSessionId);
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes('Multiple Codex sessions matched cwd'))).toBe(true);

        warnSpy.mockRestore();
    });

    it('fails fast when cwd is missing and no sessionId is provided', async () => {
        const sessionId = 'session-missing-cwd';
        const matchFailedMessage = 'No cwd provided for Codex session matching; refusing to fallback.';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n'
        );

        let failureMessage: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            onEvent: (event) => events.push(event),
            onSessionMatchFailed: (message) => {
                failureMessage = message;
            }
        });

        await wait(150);
        expect(failureMessage).toBe(matchFailedMessage);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-3', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(0);
    });

    it('prunes watchers and cached state for session files that disappear', async () => {
        const sessionId = 'session-prune';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);
        const watcherStops = new Map<string, ReturnType<typeof vi.fn>>();
        vi.spyOn(watcherModule, 'startFileWatcher').mockImplementation((filePath: string) => {
            const stop = vi.fn();
            watcherStops.set(filePath, stop);
            return stop;
        });

        await writeFile(
            sessionFile,
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId,
            onEvent: (event) => events.push(event)
        });

        const stopWatcher = watcherStops.get(sessionFile);
        expect(stopWatcher).toBeDefined();

        await rm(sessionFile, { force: true });
        scanner.onNewSession('session-other');

        await wait(200);
        expect(stopWatcher).toHaveBeenCalledTimes(1);
    });

    it('skips pre-clear Codex events after a session clear signal but still emits newer ones', async () => {
        const sessionId = 'session-clear-cache';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);
        const oldTimestamp = '2026-04-17T00:00:00.000Z';

        await writeFile(
            sessionFile,
            [
                JSON.stringify({
                    type: 'session_meta',
                    payload: { id: sessionId, cwd: '/data/github/yoho-remote', timestamp: oldTimestamp }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    timestamp: oldTimestamp,
                    payload: { type: 'agent_message', message: 'before clear' }
                })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId,
            onEvent: (event) => events.push(event)
        });

        await wait(150);
        expect(events).toHaveLength(0);

        scanner.clearSessionCache(sessionId, Date.parse('2026-04-17T00:00:02.000Z'));

        await appendFile(
            sessionFile,
            JSON.stringify({
                type: 'event_msg',
                timestamp: oldTimestamp,
                payload: { type: 'agent_message', message: 'after clear but old timestamp' }
            }) + '\n'
        );
        await appendFile(
            sessionFile,
            JSON.stringify({
                type: 'event_msg',
                timestamp: '2026-04-17T00:00:05.000Z',
                payload: { type: 'agent_message', message: 'after clear and new timestamp' }
            }) + '\n'
        );

        await wait(250);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: 'event_msg',
            timestamp: '2026-04-17T00:00:05.000Z'
        });
    });
});
