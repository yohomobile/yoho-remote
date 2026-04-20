import { logger } from "@/ui/logger";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./path";

export class ClaudeResumeSessionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClaudeResumeSessionError';
    }
}

function getClaudeSessionFile(sessionId: string, path: string): string {
    const projectDir = getProjectPath(path);
    return join(projectDir, `${sessionId}.jsonl`);
}

function hasValidClaudeSessionMessage(sessionFile: string): boolean {
    const sessionData = readFileSync(sessionFile, 'utf-8').split('\n');
    return !!sessionData.find((v) => {
        try {
            return typeof JSON.parse(v).uuid === 'string';
        } catch {
            return false;
        }
    });
}

export function claudeCheckSession(sessionId: string, path: string) {
    try {
        assertClaudeSessionExists(sessionId, path);
        return true;
    } catch {
        return false;
    }
}

export function assertClaudeSessionExists(sessionId: string, path: string): void {
    const sessionFile = getClaudeSessionFile(sessionId, path);
    if (!existsSync(sessionFile)) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
        throw new ClaudeResumeSessionError(
            `Claude resume transcript not found for session ${sessionId} at ${sessionFile}`
        );
    }

    if (!hasValidClaudeSessionMessage(sessionFile)) {
        throw new ClaudeResumeSessionError(
            `Claude resume transcript is empty or invalid for session ${sessionId} at ${sessionFile}`
        );
    }
}

export function findExplicitClaudeResumeSessionId(claudeArgs?: string[]): string | null {
    if (!claudeArgs || claudeArgs.length === 0) {
        return null;
    }

    for (let i = 0; i < claudeArgs.length; i++) {
        const arg = claudeArgs[i];
        if (arg === '--resume') {
            const nextArg = claudeArgs[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                return null;
            }
            const trimmed = nextArg.trim();
            return trimmed.length > 0 ? trimmed : null;
        }

        if (arg.startsWith('--resume=')) {
            const trimmed = arg.slice('--resume='.length).trim();
            return trimmed.length > 0 ? trimmed : null;
        }
    }

    return null;
}
