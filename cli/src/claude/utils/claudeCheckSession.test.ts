import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    assertClaudeSessionExists,
    ClaudeResumeSessionError,
    claudeCheckSession,
} from './claudeCheckSession';

describe('claudeCheckSession', () => {
    let testDir: string;
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'claude-check-session-'));
        process.env.CLAUDE_CONFIG_DIR = testDir;
    });

    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        rmSync(testDir, { recursive: true, force: true });
    });

    it('throws when the transcript file is missing', () => {
        expect(() => assertClaudeSessionExists('session-missing', '/tmp/project-a')).toThrowError(
            ClaudeResumeSessionError
        );
        expect(() => assertClaudeSessionExists('session-missing', '/tmp/project-a')).toThrowError(
            /Claude resume transcript not found/
        );
        expect(claudeCheckSession('session-missing', '/tmp/project-a')).toBe(false);
    });

    it('throws when the transcript file has no valid Claude messages', () => {
        const projectDir = join(testDir, 'projects', '-tmp-project-b');
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(join(projectDir, 'session-invalid.jsonl'), '{"type":"status"}\n', 'utf8');

        expect(() => assertClaudeSessionExists('session-invalid', '/tmp/project-b')).toThrowError(
            ClaudeResumeSessionError
        );
        expect(() => assertClaudeSessionExists('session-invalid', '/tmp/project-b')).toThrowError(
            /empty or invalid/
        );
        expect(claudeCheckSession('session-invalid', '/tmp/project-b')).toBe(false);
    });

    it('returns true for a transcript that contains a valid Claude message', () => {
        const projectDir = join(testDir, 'projects', '-tmp-project-c');
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(
            join(projectDir, 'session-valid.jsonl'),
            '{"uuid":"message-1","type":"user"}\n',
            'utf8'
        );

        expect(() => assertClaudeSessionExists('session-valid', '/tmp/project-c')).not.toThrow();
        expect(claudeCheckSession('session-valid', '/tmp/project-c')).toBe(true);
    });
});
