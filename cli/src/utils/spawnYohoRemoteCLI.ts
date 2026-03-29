/**
 * Cross-platform CLI spawning utility
 *
 * Handles spawning CLI subprocesses (for daemon processes) in a cross-platform way,
 * detecting the current runtime mode (compiled binary vs development) and using
 * the appropriate command and arguments.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join, dirname, basename } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';

/**
 * Check if we're running as a standalone daemon/server executable (not the main CLI)
 */
function isStandaloneExecutable(): boolean {
  const execName = basename(process.execPath);
  return execName === 'yoho-remote-daemon' || execName === 'yoho-remote-daemon.exe' ||
         execName === 'yoho-remote-server' || execName === 'yoho-remote-server.exe';
}

/**
 * Get the path to the main CLI executable when running as standalone daemon/server.
 * Looks for 'yoho-remote' binary in the same directory as the current executable.
 */
function getMainCliExecutable(): string | null {
  if (!isStandaloneExecutable()) {
    return null;
  }

  const execDir = dirname(process.execPath);
  const isWindows = process.platform === 'win32';
  const cliExe = join(execDir, isWindows ? 'yoho-remote.exe' : 'yoho-remote');

  if (existsSync(cliExe)) {
    return cliExe;
  }

  return null;
}

/**
 * Resolve the TypeScript entrypoint for development mode.
 */
function resolveEntrypoint(projectRoot: string): string {
  const srcEntrypoint = join(projectRoot, 'src', 'index.ts');
  if (existsSync(srcEntrypoint)) {
    return srcEntrypoint;
  }

  throw new Error('No CLI entrypoint found (expected src/index.ts)');
}

export interface YohoRemoteCliCommand {
  command: string;
  args: string[];
}

export function getYohoRemoteCliCommand(args: string[]): YohoRemoteCliCommand {
  // Compiled binary mode: just use the executable directly
  if (isBunCompiled()) {
    // Check if we're running as standalone daemon/server
    // In that case, we need to use the main CLI executable for spawning sessions
    const mainCli = getMainCliExecutable();
    if (mainCli) {
      logger.debug(`[SPAWN CLI] Using main executable: ${mainCli}`);
      return {
        command: mainCli,
        args
      };
    }

    return {
      command: process.execPath,
      args
    };
  }

  // Development mode: spawn with TypeScript entrypoint
  const projectRoot = projectPath();
  const entrypoint = resolveEntrypoint(projectRoot);
  const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);

  if (isBunRuntime) {
    // Bun can run TypeScript directly
    return {
      command: process.execPath,
      args: [entrypoint, ...args]
    };
  }

  // Node.js fallback: preserve execArgv (for compatibility)
  return {
    command: process.execPath,
    args: [...process.execArgv, entrypoint, ...args]
  };
}

export function spawnYohoRemoteCLI(args: string[], options: SpawnOptions = {}): ChildProcess {

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  const fullCommand = `cli ${args.join(' ')}`;
  logger.debug(`[SPAWN CLI] Spawning: ${fullCommand} in ${directory}`);
  
  const { command: spawnCommand, args: spawnArgs } = getYohoRemoteCliCommand(args);

  // Sanity check that the entrypoint path exists
  if (!isBunCompiled()) {
    const entrypoint = spawnArgs.find((arg) => arg.endsWith('index.ts'));
    if (entrypoint && !existsSync(entrypoint)) {
      const errorMessage = `Entrypoint ${entrypoint} does not exist`;
      logger.debug(`[SPAWN CLI] ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
  
  return spawn(spawnCommand, spawnArgs, options);
}
