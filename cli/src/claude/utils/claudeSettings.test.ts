/**
 * Tests for Claude settings reading functionality
 * 
 * Tests reading Claude's settings.json file and respecting the includeCoAuthoredBy setting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, readClaudeSettingsMcpServers, shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testClaudeDir = join(tmpdir(), `test-claude-${Date.now()}`);
    mkdirSync(testClaudeDir, { recursive: true });
    
    // Set environment variable to point to test directory
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    
    // Clean up test directory
    if (existsSync(testClaudeDir)) {
      rmSync(testClaudeDir, { recursive: true, force: true });
    }
  });

  describe('readClaudeSettings', () => {
    it('returns null when settings file does not exist', () => {
      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });

    it('reads settings when file exists', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      const testSettings = { includeCoAuthoredBy: false, otherSetting: 'value' };
      writeFileSync(settingsPath, JSON.stringify(testSettings));

      const settings = readClaudeSettings();
      expect(settings).toEqual(testSettings);
    });

    it('returns null when settings file is invalid JSON', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, 'invalid json');

      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });
  });

  describe('shouldIncludeCoAuthoredBy', () => {
    it('returns true when no settings file exists (default behavior)', () => {
      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    it('returns true when includeCoAuthoredBy is not set (default behavior)', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ otherSetting: 'value' }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    it('returns false when includeCoAuthoredBy is explicitly set to false', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(false);
    });

    it('returns true when includeCoAuthoredBy is explicitly set to true', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });
  });

  describe('readClaudeSettingsMcpServers', () => {
    it('returns empty object when no settings files exist', () => {
      expect(readClaudeSettingsMcpServers()).toEqual({});
    });

    it('reads MCP servers from default settings.json', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({
        mcpServers: {
          alpha: { command: 'bun', args: ['run', 'alpha.ts'] }
        }
      }));

      expect(readClaudeSettingsMcpServers()).toEqual({
        alpha: { command: 'bun', args: ['run', 'alpha.ts'] }
      });
    });

    it('merges default and typed settings MCP servers with typed override', () => {
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({
        mcpServers: {
          alpha: { command: 'bun', args: ['run', 'alpha.ts'] },
          shared: { command: 'bun', args: ['run', 'default.ts'] }
        }
      }));
      writeFileSync(join(testClaudeDir, 'settings.litellm.json'), JSON.stringify({
        mcp_servers: {
          beta: { command: 'bun', args: ['run', 'beta.ts'] },
          shared: { command: 'bun', args: ['run', 'typed.ts'] }
        }
      }));

      expect(readClaudeSettingsMcpServers('litellm')).toEqual({
        alpha: { command: 'bun', args: ['run', 'alpha.ts'] },
        beta: { command: 'bun', args: ['run', 'beta.ts'] },
        shared: { command: 'bun', args: ['run', 'typed.ts'] }
      });
    });
  });
});
