/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
    includeCoAuthoredBy?: boolean;
    mcpServers?: Record<string, unknown>;
    mcp_servers?: Record<string, unknown>;
    [key: string]: any;
}

export type ClaudeSettingsType = 'litellm' | 'claude';

function getClaudeConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(settingsType?: ClaudeSettingsType): string {
    const filename = settingsType ? `settings.${settingsType}.json` : 'settings.json';
    return join(getClaudeConfigDir(), filename);
}

function readClaudeSettingsFile(settingsType?: ClaudeSettingsType): ClaudeSettings | null {
    try {
        const settingsPath = getClaudeSettingsPath(settingsType);

        if (!existsSync(settingsPath)) {
            logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
            return null;
        }

        const settingsContent = readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent) as ClaudeSettings;

        logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
        return settings;
    } catch (error) {
        logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
        return null;
    }
}

function extractMcpServers(settings: ClaudeSettings | null): Record<string, unknown> {
    if (!settings) {
        return {};
    }

    const raw = settings.mcpServers ?? settings.mcp_servers;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    return raw;
}

/**
 * Read Claude's settings.json file from the default location
 * 
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
    const settings = readClaudeSettingsFile();
    if (settings) {
        logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);
    }
    return settings;
}

/**
 * Claude 2.1.107 on our machines does not reliably auto-load user MCP servers from
 * ~/.claude/settings*.json, so we merge them into the explicit --mcp-config payload.
 */
export function readClaudeSettingsMcpServers(settingsType?: ClaudeSettingsType): Record<string, unknown> {
    const merged = {
        ...extractMcpServers(readClaudeSettingsFile()),
        ...(settingsType ? extractMcpServers(readClaudeSettingsFile(settingsType)) : {}),
    };
    logger.debug(`[ClaudeSettings] Loaded MCP servers from settings: ${Object.keys(merged).join(', ') || '(none)'}`);
    return merged;
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Claude's settings
 * 
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
    const settings = readClaudeSettings();

    // If no settings file or includeCoAuthoredBy is not explicitly set,
    // default to true to maintain backward compatibility
    if (!settings || settings.includeCoAuthoredBy === undefined) {
        return true;
    }

    return settings.includeCoAuthoredBy;
}
