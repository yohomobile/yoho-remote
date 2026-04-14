/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync, readdirSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '@/ui/logger'

/**
 * Parse Claude CLI version output like:
 * - "2.1.107 (Claude Code)"
 * - "Claude Code 2.1.107"
 */
export function parseClaudeCodeVersion(output: string): string | null {
    const match = output.match(/(\d+\.\d+\.\d+)/)
    return match ? match[1] : null
}

export function compareClaudeCodeVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(part => Number.parseInt(part, 10))
    const rightParts = right.split('.').map(part => Number.parseInt(part, 10))
    const maxLength = Math.max(leftParts.length, rightParts.length)

    for (let index = 0; index < maxLength; index++) {
        const leftValue = leftParts[index] ?? 0
        const rightValue = rightParts[index] ?? 0
        if (leftValue !== rightValue) {
            return leftValue - rightValue
        }
    }

    return 0
}

export function pickPreferredClaudePath(
    candidates: Array<{ path: string; version: string | null }>
): string | null {
    if (candidates.length === 0) {
        return null
    }

    const ranked = [...candidates].sort((left, right) => {
        if (left.version && right.version) {
            return compareClaudeCodeVersions(right.version, left.version)
        }
        if (left.version) return -1
        if (right.version) return 1
        return left.path.localeCompare(right.path)
    })

    return ranked[0]?.path ?? null
}

function getClaudeExecutableName(): string {
    return process.platform === 'win32' ? 'claude.cmd' : 'claude'
}

function getCandidateClaudePaths(): string[] {
    const homeDir = homedir()
    const candidates: string[] = []

    const lookupCommand = process.platform === 'win32' ? 'where claude' : 'which -a claude'
    try {
        const result = execSync(lookupCommand, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
        })
        for (const line of result.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (trimmed && existsSync(trimmed)) {
                candidates.push(trimmed)
            }
        }
    } catch {
        // No claude found on PATH.
    }

    const nvmVersionsDir = join(homeDir, '.nvm', 'versions', 'node')
    if (existsSync(nvmVersionsDir)) {
        for (const versionDir of readdirSync(nvmVersionsDir)) {
            const candidate = join(nvmVersionsDir, versionDir, 'bin', getClaudeExecutableName())
            if (existsSync(candidate)) {
                candidates.push(candidate)
            }
        }
    }

    for (const candidate of [
        join(homeDir, '.local', 'bin', getClaudeExecutableName()),
        process.platform === 'win32' ? 'C:\\Program Files\\Claude\\claude.cmd' : '/usr/local/bin/claude',
        process.platform === 'win32' ? 'C:\\Program Files (x86)\\Claude\\claude.cmd' : '/usr/bin/claude',
    ]) {
        if (existsSync(candidate)) {
            candidates.push(candidate)
        }
    }

    return [...new Set(candidates)]
}

function getClaudeVersion(path: string): string | null {
    try {
        const output = execFileSync(path, ['--version'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir(),
        })
        return parseClaudeCodeVersion(output)
    } catch {
        return null
    }
}

/**
 * Try to find a globally installed Claude CLI.
 * Prefer the newest installed version instead of the first match on PATH,
 * because daemon environments can keep an older NVM path ahead of the user's
 * current shell version.
 */
function findGlobalClaudePath(): string | null {
    const candidates = getCandidateClaudePaths()
        .map(path => ({ path, version: getClaudeVersion(path) }))

    const preferredPath = pickPreferredClaudePath(candidates)
    if (!preferredPath) {
        return null
    }

    const selected = candidates.find(candidate => candidate.path === preferredPath)
    logger.debug(`[Claude SDK] Selected Claude executable: ${preferredPath} (${selected?.version ?? 'unknown version'})`)
    return preferredPath
}

/**
 * Get default path to Claude Code executable.
 *
 * Environment variables:
 * - YR_CLAUDE_PATH: Force a specific path to claude executable
 */
export function getDefaultClaudeCodePath(): string {
    // Allow explicit override via env var
    if (process.env.YR_CLAUDE_PATH) {
        logger.debug(`[Claude SDK] Using YR_CLAUDE_PATH: ${process.env.YR_CLAUDE_PATH}`)
        return process.env.YR_CLAUDE_PATH
    }

    // Find global claude
    const globalPath = findGlobalClaudePath()
    if (!globalPath) {
        throw new Error('Claude Code CLI not found on PATH. Install Claude Code or set YR_CLAUDE_PATH.')
    }
    return globalPath
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        logger.debug(message)
        console.log(message)
    }
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}
