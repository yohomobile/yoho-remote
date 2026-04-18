import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult, SpawnLogEntry } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnYohoRemoteCLI } from '@/utils/spawnYohoRemoteCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, readSettings, applyPathMapping, acquireDaemonLock, releaseDaemonLock } from '@/persistence';
import { isProcessAlive, isWindows, killProcess, killProcessByChildProcess } from '@/utils/process';
import { resolveClaudeModelArg } from '@/utils/claudeModelArg';

import { cleanupDaemonState, getInstalledCliMtimeMs, isDaemonRunningCurrentlyInstalledVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { EXTERNAL_TRACKED_SESSION_LABEL, recoverTrackedSessionsFromServer } from './recoverTrackedSessions';
import { isSessionProcessIdentityCurrent, isTrackedSessionProcessCurrent } from './trackedSessionIdentity';
import { buildClaudeTokenSourceEnv } from './tokenSourceEnv';
import { createWorktree, removeWorktree, type WorktreeInfo } from './worktree';
import { join } from 'path';
import { runtimePath } from '@/projectPath';

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: process.env.YOHO_MACHINE_NAME || os.hostname(),
  platform: os.platform(),
  yohoRemoteCliVersion: packageJson.version,
  arch: os.arch(),
  user: process.env.USER ?? null,
  shell: process.env.SHELL ?? null,
  homeDir: os.homedir(),
  yohoRemoteHomeDir: configuration.yohoRemoteHomeDir,
  yohoRemoteLibDir: runtimePath(),
  serverUrl: configuration.serverUrl,
  cwd: process.cwd(),
  ...(process.env.YOHO_MACHINE_IP ? { ip: process.env.YOHO_MACHINE_IP, publicIp: process.env.YOHO_MACHINE_IP } : {}),
  ...(process.env.YOHO_MACHINE_NAME ? { displayName: process.env.YOHO_MACHINE_NAME } : {}),
};

function isManagedBySystemd(): boolean {
  return process.env.YR_DAEMON_UNDER_SYSTEMD === '1';
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function machineMetadataChanged(currentMetadata: MachineMetadata | null | undefined, nextMetadata: MachineMetadata): boolean {
  if (!currentMetadata) {
    return true;
  }

  const keys = new Set([
    ...Object.keys(currentMetadata),
    ...Object.keys(nextMetadata),
  ]);

  for (const key of keys) {
    if ((currentMetadata as Record<string, unknown>)[key] !== (nextMetadata as Record<string, unknown>)[key]) {
      return true;
    }
  }

  return false;
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'yr-app' | 'yr-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let shutdownForceTimeout: ReturnType<typeof setTimeout> | null = null;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'yr-app' | 'yr-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);
      if (shutdownForceTimeout) {
        return;
      }

      // Fallback - in case cleanup hangs - force exit after 10 seconds
      shutdownForceTimeout = setTimeout(async () => {
        logger.debug('[DAEMON RUN] Graceful shutdown timed out, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 10_000);
      shutdownForceTimeout.unref?.();

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  if (isWindows()) {
    process.on('SIGBREAK', () => {
      logger.debug('[DAEMON RUN] Received SIGBREAK');
      requestShutdown('os-signal');
    });
  } else {
    process.on('SIGHUP', () => {
      logger.debug('[DAEMON RUN] Received SIGHUP');
      requestShutdown('os-signal');
    });
  }

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  const managedBySystemd = isManagedBySystemd();

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else if (managedBySystemd) {
    logger.debug('[DAEMON RUN] systemd-managed startup detected a matching daemon, stopping residual instance so this service can take ownership');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Ensure auth and machine registration BEFORE anything else
    const { machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from YR session reporting itself
    const onYohoRemoteSessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }
      if (!isSessionProcessIdentityCurrent(sessionMetadata)) {
        logger.debug(`[DAEMON RUN] Session webhook rejected for ${sessionId}: process identity no longer matches PID ${pid}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.yohoRemoteSessionId = sessionId;
        existingSession.yohoRemoteSessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: EXTERNAL_TRACKED_SESSION_LABEL,
          yohoRemoteSessionId: sessionId,
          yohoRemoteSessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      // Collect spawn logs for detailed debugging
      const spawnLogs: SpawnLogEntry[] = [];
      const addLog = (step: string, message: string, status: SpawnLogEntry['status']) => {
        const entry: SpawnLogEntry = { timestamp: Date.now(), step, message, status };
        spawnLogs.push(entry);
        logger.debug(`[SPAWN LOG] [${step}] ${message} (${status})`);
      };

      let { directory } = options;
      const { sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      const agent = options.agent ?? 'claude';
      const yolo = options.yolo === true;
      const sessionType = options.sessionType ?? 'simple';
      const worktreeName = options.worktreeName;
      const reuseExistingWorktree = options.reuseExistingWorktree === true;
      let directoryCreated = false;
      let spawnDirectory = directory;
      let worktreeInfo: WorktreeInfo | null = null;
      let cliProcess: ReturnType<typeof spawnYohoRemoteCLI> | null = null;

      // Apply path mapping if configured
      try {
        const settings = await readSettings();
        if (settings.pathMapping && Object.keys(settings.pathMapping).length > 0) {
          const originalDirectory = directory;
          directory = applyPathMapping(directory, settings.pathMapping);
          spawnDirectory = directory;
          if (originalDirectory !== directory) {
            addLog('path-mapping', `Path mapped: ${originalDirectory} -> ${directory}`, 'success');
            logger.debug(`[DAEMON RUN] Path mapped: ${originalDirectory} -> ${directory}`);
          }
        }
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to read settings for path mapping:`, error);
      }

      // Dedup guard: if a process is already running for this sessionId, kill it first.
      // This prevents ghost duplicate processes after daemon restart or failed resume attempts.
      if (sessionId) {
        for (const [pid, tracked] of pidToTrackedSession.entries()) {
          if (tracked.yohoRemoteSessionId === sessionId) {
            if (!isTrackedSessionProcessCurrent(tracked)) {
              logger.debug(`[DAEMON RUN] Removing stale tracked session PID ${pid} for ${sessionId} before respawn`);
              pidToTrackedSession.delete(pid);
              continue;
            }
            logger.debug(`[DAEMON RUN] Session ${sessionId} already running as PID ${pid}, killing old process before respawn`);
            addLog('dedup', `Killing existing process PID ${pid} for session ${sessionId}`, 'running');
            try {
              if (tracked.startedBy === 'daemon' && tracked.childProcess) {
                await killProcessByChildProcess(tracked.childProcess);
              } else {
                await killProcess(pid);
              }
              // Wait briefly for process to actually exit before spawning replacement
              await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill existing process PID ${pid}:`, error);
            }
            pidToTrackedSession.delete(pid);
            addLog('dedup', `Killed and removed existing process PID ${pid}`, 'success');
            break;
          }
        }
      }

      addLog('init', `Starting session spawn: agent=${agent}, directory=${directory}, sessionType=${sessionType}`, 'running');

      if (sessionType === 'simple') {
        addLog('directory', `Checking directory: ${directory}`, 'running');
        try {
          await fs.access(directory);
          logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
          addLog('directory', `Directory exists: ${directory}`, 'success');
        } catch (error) {
          logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);
          addLog('directory', `Directory doesn't exist, will create: ${directory}`, 'running');

          // Check if directory creation is approved
          if (!approvedNewDirectoryCreation) {
            logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
            addLog('directory', `Directory creation not approved`, 'error');
            return {
              type: 'requestToApproveDirectoryCreation',
              directory,
              logs: spawnLogs
            };
          }

          try {
            await fs.mkdir(directory, { recursive: true });
            logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
            directoryCreated = true;
            addLog('directory', `Successfully created directory: ${directory}`, 'success');
          } catch (mkdirError: any) {
            let errorMessage = `Unable to create directory at '${directory}'. `;

            // Provide more helpful error messages based on the error code
            if (mkdirError.code === 'EACCES') {
              errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
            } else if (mkdirError.code === 'ENOTDIR') {
              errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
            } else if (mkdirError.code === 'ENOSPC') {
              errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
            } else if (mkdirError.code === 'EROFS') {
              errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
            } else {
              errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
            }

            logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
            addLog('directory', `Directory creation failed: ${errorMessage}`, 'error');
            return {
              type: 'error',
              errorMessage,
              logs: spawnLogs
            };
          }
        }
      } else {
        addLog('worktree', `Checking worktree base directory: ${directory}`, 'running');
        try {
          await fs.access(directory);
          logger.debug(`[DAEMON RUN] Worktree base directory exists: ${directory}`);
          addLog('worktree', `Worktree base directory exists`, 'success');
        } catch (error) {
          logger.debug(`[DAEMON RUN] Worktree base directory missing: ${directory}`);
          addLog('worktree', `Worktree base directory missing: ${directory}`, 'error');
          return {
            type: 'error',
            errorMessage: `Worktree sessions require an existing Git repository. Directory not found: ${directory}`,
            logs: spawnLogs
          };
        }
      }

      if (sessionType === 'worktree') {
        const worktreeAction = reuseExistingWorktree
          ? `Resolving named worktree from base: ${directory}`
          : `Creating worktree from base: ${directory}`;
        addLog('worktree', worktreeAction, 'running');
        const worktreeResult = await createWorktree({
          basePath: directory,
          nameHint: worktreeName,
          reuseExisting: reuseExistingWorktree
        });
        if (!worktreeResult.ok) {
          logger.debug(`[DAEMON RUN] Worktree creation failed: ${worktreeResult.error}`);
          addLog('worktree', `Worktree creation failed: ${worktreeResult.error}`, 'error');
          return {
            type: 'error',
            errorMessage: worktreeResult.error,
            logs: spawnLogs
          };
        }
        worktreeInfo = worktreeResult.info;
        spawnDirectory = worktreeInfo.worktreePath;
        logger.debug(`[DAEMON RUN] Ready worktree ${worktreeInfo.worktreePath} (branch ${worktreeInfo.branch})`);
        addLog('worktree', `Using worktree: ${worktreeInfo.worktreePath} (branch: ${worktreeInfo.branch})`, 'success');
      }

      const cleanupWorktree = async () => {
        if (!worktreeInfo) {
          return;
        }
        const result = await removeWorktree({
          repoRoot: worktreeInfo.basePath,
          worktreePath: worktreeInfo.worktreePath
        });
        if (!result.ok) {
          logger.debug(`[DAEMON RUN] Failed to remove worktree ${worktreeInfo.worktreePath}: ${result.error}`);
        }
      };
      const maybeCleanupWorktree = async (reason: string) => {
        if (!worktreeInfo) {
          return;
        }
        const pid = cliProcess?.pid;
        if (pid && isProcessAlive(pid)) {
          logger.debug(`[DAEMON RUN] Skipping worktree cleanup after ${reason}; child still running`, {
            pid,
            worktreePath: worktreeInfo.worktreePath
          });
          return;
        }
        await cleanupWorktree();
      };

      try {
        addLog('env', `Preparing environment for agent: ${agent}`, 'running');

        // Resolve authentication token if provided
        let extraEnv: Record<string, string> = {};
        const tempDirs: string[] = [];
        if (options.token) {
          if (options.agent === 'codex') {
            addLog('env', `Setting up Codex authentication`, 'running');
            // Create a temporary directory for Codex
            const codexHomeDir = await fs.mkdtemp(join(os.tmpdir(), 'yr-codex-'));
            tempDirs.push(codexHomeDir);

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir, 'auth.json'), options.token);

            // Set the environment variable for Codex
            extraEnv = {
              CODEX_HOME: codexHomeDir
            };
            addLog('env', `Codex authentication configured`, 'success');
          } else if (options.agent === 'claude' || !options.agent) {
            addLog('env', `Setting up Claude authentication`, 'running');
            extraEnv = {
              CLAUDE_CODE_OAUTH_TOKEN: options.token
            };
            addLog('env', `Claude authentication configured`, 'success');
          }
        }

        if (options.tokenSourceType === 'claude' && agent === 'claude' && options.tokenSourceBaseUrl && options.tokenSourceApiKey) {
          addLog('env', `Applying Token Source for Claude: ${options.tokenSourceName ?? options.tokenSourceId ?? 'unnamed'}`, 'running');
          delete extraEnv.CLAUDE_CODE_OAUTH_TOKEN;
          extraEnv = {
            ...extraEnv,
            ...buildClaudeTokenSourceEnv({
              baseUrl: options.tokenSourceBaseUrl,
              apiKey: options.tokenSourceApiKey,
              tokenSourceId: options.tokenSourceId,
              tokenSourceName: options.tokenSourceName,
            }),
          };
          addLog('env', `Claude Token Source configured`, 'success');
        }

        if (options.tokenSourceType === 'codex' && agent === 'codex' && options.tokenSourceBaseUrl && options.tokenSourceApiKey) {
          addLog('env', `Applying Token Source for Codex: ${options.tokenSourceName ?? options.tokenSourceId ?? 'unnamed'}`, 'running');
          const codexProviderHomeDir = await fs.mkdtemp(join(os.tmpdir(), 'yr-codex-provider-'));
          tempDirs.push(codexProviderHomeDir);
          const codexHomeDir = codexProviderHomeDir;
          const defaultCodexHome = process.env.CODEX_HOME || join(os.homedir(), '.codex');
          const existingConfigPath = join(defaultCodexHome, 'config.toml');
          let configContent = '';
          if (existsSync(existingConfigPath)) {
            try {
              configContent = await fs.readFile(existingConfigPath, 'utf8');
            } catch (error) {
              logger.debug('[DAEMON RUN] Failed to read existing Codex config.toml for Token Source:', error);
            }
          }
          const normalizedBaseUrl = options.tokenSourceBaseUrl.replace(/\/+$/, '');
          const providerId = 'yoho_remote_token_source';
          const providerBlock = `${configContent.trimEnd() ? `${configContent.trimEnd()}\n\n` : ''}model_provider = "${providerId}"\n[model_providers.${providerId}]\nname = ${toTomlString(options.tokenSourceName ?? 'Yoho Remote Token Source')}\nbase_url = ${toTomlString(normalizedBaseUrl)}\nwire_api = "responses"\nenv_key = "YOHO_REMOTE_TOKEN_SOURCE_API_KEY"\nenv_key_instructions = "Managed by Yoho Remote Token Source"\n`;
          await fs.writeFile(join(codexHomeDir, 'config.toml'), providerBlock);
          extraEnv = {
            ...extraEnv,
            CODEX_HOME: codexHomeDir,
            YOHO_REMOTE_TOKEN_SOURCE_API_KEY: options.tokenSourceApiKey,
            YR_TOKEN_SOURCE_ID: options.tokenSourceId ?? '',
            YR_TOKEN_SOURCE_NAME: options.tokenSourceName ?? '',
            YR_TOKEN_SOURCE_TYPE: 'codex',
          };
          addLog('env', `Codex Token Source configured`, 'success');
        }

        if (worktreeInfo) {
          extraEnv = {
            ...extraEnv,
            YR_WORKTREE_BASE_PATH: worktreeInfo.basePath,
            YR_WORKTREE_BRANCH: worktreeInfo.branch,
            YR_WORKTREE_NAME: worktreeInfo.name,
            YR_WORKTREE_PATH: worktreeInfo.worktreePath,
            YR_WORKTREE_CREATED_AT: String(worktreeInfo.createdAt)
          };
        }

        // Pass permission mode and model settings from original session
        if (options.permissionMode) {
          extraEnv = { ...extraEnv, YR_PERMISSION_MODE: options.permissionMode };
        }
        if (options.modelMode) {
          extraEnv = { ...extraEnv, YR_MODEL_MODE: options.modelMode };
        }
        if (options.modelReasoningEffort) {
          extraEnv = { ...extraEnv, YR_MODEL_REASONING_EFFORT: options.modelReasoningEffort };
        }
        const sessionSource = typeof options.source === 'string' ? options.source.trim() : '';
        if (sessionSource) {
          extraEnv = { ...extraEnv, YR_SESSION_SOURCE: sessionSource };
        }
        if (options.mainSessionId) {
          extraEnv = { ...extraEnv, YR_MAIN_SESSION_ID: options.mainSessionId };
        }
        if (options.caller) {
          extraEnv = { ...extraEnv, YR_CALLER: options.caller };
        }
        if (options.brainPreferences) {
          extraEnv = { ...extraEnv, YR_BRAIN_SESSION_PREFERENCES: JSON.stringify(options.brainPreferences) };
        }
        // Pass Claude settings type (litellm or claude)
        if (options.claudeSettingsType) {
          extraEnv = { ...extraEnv, YR_CLAUDE_SETTINGS_TYPE: options.claudeSettingsType };
        }

        addLog('env', `Environment prepared successfully`, 'success');

        // Construct arguments for the CLI
        const agentCommand = (() => {
          switch (agent) {
            case 'codex': return 'codex';
            case 'opencode': return 'opencode';
            default: return 'claude';
          }
        })();

        // Resolve the agent executable path.
        // On macOS with launchd the daemon starts with a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin)
        // that excludes user-installed bins. `which` and login-shell fallbacks are unreliable in
        // that environment, so we probe well-known install locations directly.
        const resolvedAgentPath = (() => {
          const whichResult = spawnSync('which', [agentCommand], { encoding: 'utf8' });
          if (whichResult.status === 0 && whichResult.stdout.trim()) {
            return whichResult.stdout.trim();
          }

          // Probe well-known install locations (covers npm global, homebrew, nvm, volta, etc.)
          const home = os.homedir();
          const candidateDirs = [
            '/usr/local/bin',
            '/opt/homebrew/bin',
            `${home}/.npm-global/bin`,
            `${home}/.local/bin`,
            `${home}/.volta/bin`,
            `/usr/bin`,
          ];
          for (const dir of candidateDirs) {
            const candidate = `${dir}/${agentCommand}`;
            if (existsSync(candidate)) {
              // Extend PATH so the spawned process can also resolve its dependencies
              const currentPath = process.env.PATH ?? '';
              const dirsInPath = new Set(currentPath.split(':').filter(Boolean));
              if (!dirsInPath.has(dir)) {
                extraEnv = { ...extraEnv, PATH: `${dir}:${currentPath}` };
              }
              addLog('env', `Resolved ${agentCommand} via fallback path: ${candidate}`, 'success');
              return candidate;
            }
          }
          return null;
        })();

        if (!resolvedAgentPath) {
          addLog('env', `Agent "${agentCommand}" not found in PATH`, 'error');
          return {
            type: 'error' as const,
            errorMessage: `AGENT_NOT_AVAILABLE: "${agentCommand}" not found in PATH on this machine`,
            logs: spawnLogs,
          };
        }
        const args = [
          agentCommand,
          '--yoho-remote-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];
        const claudeAgent = typeof options.claudeAgent === 'string' ? options.claudeAgent.trim() : '';
        if (agent === 'claude' && claudeAgent) {
          args.push('--agent', claudeAgent);
        }
        // Pass Claude model mode via --model argument (mapping short labels to full model IDs where needed)
        if (agent === 'claude' && options.modelMode) {
          const claudeModelArg = resolveClaudeModelArg(options.modelMode) ?? options.modelMode;
          args.push('--model', claudeModelArg);
        }
        const opencodeModel = typeof options.opencodeModel === 'string' ? options.opencodeModel.trim() : '';
        if (agent === 'opencode' && opencodeModel) {
          args.push('--model', opencodeModel);
        }
        // Always use highest reasoning effort for OpenCode
        if (agent === 'opencode') {
          extraEnv = { ...extraEnv, OPENCODE_VARIANT: 'max' };
        }
        if (options.sessionId) {
          args.push('--yoho-remote-session-id', options.sessionId);
        }
        if (options.resumeSessionId) {
          args.push('--yoho-remote-resume-session-id', options.resumeSessionId);
        }
        if (yolo) {
          args.push('--yolo');
        }

        addLog('spawn', `Spawning CLI process: yoho-remote ${args.join(' ')}`, 'running');
        addLog('spawn', `Working directory: ${spawnDirectory}`, 'running');

        const MAX_TAIL_CHARS = 4000;
        let stderrTail = '';
        const appendTail = (current: string, chunk: Buffer | string): string => {
          const text = chunk.toString();
          if (!text) {
            return current;
          }
          const combined = current + text;
          return combined.length > MAX_TAIL_CHARS ? combined.slice(-MAX_TAIL_CHARS) : combined;
        };
        const logStderrTail = () => {
          const trimmed = stderrTail.trim();
          if (!trimmed) {
            return;
          }
          logger.debug('[DAEMON RUN] Child stderr tail', trimmed);
        };

        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...extraEnv
        };

        if (options.tokenSourceType === 'claude' && agent === 'claude') {
          const removedEnvKeys = [
            'ANTHROPIC_AUTH_TOKEN',
            'CLAUDE_CODE_OAUTH_TOKEN'
          ].filter((key) => childEnv[key] !== undefined);

          for (const key of removedEnvKeys) {
            delete childEnv[key];
          }

          if (removedEnvKeys.length > 0) {
            logger.debug('[DAEMON RUN] Cleared inherited Claude auth env overrides for Token Source', {
              removedEnvKeys
            });
            addLog('env', `Cleared inherited Claude auth env overrides: ${removedEnvKeys.join(', ')}`, 'success');
          }
        }

        if (agent === 'codex') {
          const removedEnvKeys = [
            'OPENAI_API_KEY',
            'OPENAI_BASE_URL',
            'OPENAI_ORG',
            'OPENAI_ORGANIZATION',
            'OPENAI_PROJECT'
          ].filter((key) => childEnv[key] !== undefined);

          for (const key of removedEnvKeys) {
            delete childEnv[key];
          }

          if (removedEnvKeys.length > 0) {
            logger.debug('[DAEMON RUN] Cleared OpenAI env overrides for Codex session auth', {
              removedEnvKeys
            });
            addLog('env', `Cleared OpenAI env overrides for Codex: ${removedEnvKeys.join(', ')}`, 'success');
          }
        }

        // Spawn from a local (non-NFS) directory to avoid bun's early getcwd() call
        // blocking on stale/slow NFS mounts. The actual project directory is passed
        // via YR_SPAWN_DIRECTORY; runClaude.ts will chdir() to it after bun initializes.
        const safeSpawnCwd = os.homedir();
        childEnv['YR_SPAWN_DIRECTORY'] = spawnDirectory;

        cliProcess = spawnYohoRemoteCLI(args, {
          cwd: safeSpawnCwd,
          detached: true,  // Sessions stay alive when daemon stops
          stdio: ['ignore', 'ignore', 'pipe'],  // stdout ignored to prevent pipe buffer blocking
          env: childEnv
        });

        cliProcess.stderr?.on('data', (data) => {
          stderrTail = appendTail(stderrTail, data);
        });

        if (!cliProcess.pid) {
          logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
          addLog('spawn', `Failed to spawn process - no PID returned`, 'error');
          await maybeCleanupWorktree('no-pid');
          return {
            type: 'error',
            errorMessage: 'Failed to spawn YR process - no PID returned',
            logs: spawnLogs
          };
        }

        const pid = cliProcess.pid;
        logger.debug(`[DAEMON RUN] Spawned process with PID ${pid}`);
        addLog('spawn', `Process spawned with PID: ${pid}`, 'success');

        const trackedSession: TrackedSession = {
          startedBy: 'daemon',
          pid,
          childProcess: cliProcess,
          directoryCreated,
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
          tempDirs: tempDirs.length > 0 ? tempDirs : undefined
        };

        pidToTrackedSession.set(pid, trackedSession);

        let spawnWaitSettled = false;
        let spawnWaitTimeout: ReturnType<typeof setTimeout> | null = null;
        let rejectEarlyExit: ((error: Error) => void) | null = null;

        const finalizeSpawnWait = (): boolean => {
          if (spawnWaitSettled) {
            return false;
          }
          spawnWaitSettled = true;
          if (spawnWaitTimeout) {
            clearTimeout(spawnWaitTimeout);
            spawnWaitTimeout = null;
          }
          pidToAwaiter.delete(pid);
          return true;
        };

        const buildEarlyExitError = (code: number | null, signal: NodeJS.Signals | null): Error => {
          const tail = stderrTail.trim().slice(-512);
          const tailText = tail
            ? `\nStderr tail (last 512B):\n${tail}`
            : '\nStderr tail (last 512B): (empty)';
          return new Error(`Session process for PID ${pid} exited before the webhook was ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).${tailText}`);
        };

        const readyPromise = new Promise<TrackedSession>((resolve) => {
          // Register awaiter
          pidToAwaiter.set(pid, (completedSession) => {
            if (!finalizeSpawnWait()) {
              return;
            }
            logger.debug(`[DAEMON RUN] Session ${completedSession.yohoRemoteSessionId} fully spawned with webhook`);
            addLog('webhook', `Session ready: ${completedSession.yohoRemoteSessionId}`, 'success');
            addLog('complete', `Session created successfully`, 'success');
            resolve(completedSession);
          });
        });

        const exitPromise = new Promise<TrackedSession>((_, reject) => {
          rejectEarlyExit = (error: Error) => {
            if (!finalizeSpawnWait()) {
              return;
            }
            reject(error);
          };
        });

        const timeoutPromise = new Promise<TrackedSession>((_, reject) => {
          // Set timeout for webhook
          spawnWaitTimeout = setTimeout(() => {
            if (!finalizeSpawnWait()) {
              return;
            }
            logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid}`);
            logStderrTail();
            addLog('webhook', `Session webhook timeout for PID ${pid}`, 'error');
            reject(new Error(`Session webhook timeout for PID ${pid}`));
            // 15 second timeout - I have seen timeouts on 10 seconds
            // even though session was still created successfully in ~2 more seconds
          }, 15_000);
          spawnWaitTimeout.unref?.();
        });

        cliProcess.on('exit', (code, signal) => {
          logger.debug(`[DAEMON RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
          if (!spawnWaitSettled) {
            if (code !== 0 || signal) {
              logStderrTail();
            }
            const earlyExitError = buildEarlyExitError(code, signal);
            addLog('webhook', earlyExitError.message, 'error');
            rejectEarlyExit?.(earlyExitError);
          }
          onChildExited(pid);
        });

        cliProcess.on('error', (error) => {
          logger.debug(`[DAEMON RUN] Child process error:`, error);
          if (!spawnWaitSettled) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const childError = new Error(`Child process error for PID ${pid}: ${errorMessage}`);
            addLog('webhook', childError.message, 'error');
            rejectEarlyExit?.(childError);
          }
          onChildExited(pid);
        });

        // Wait for webhook to populate session with yohoRemoteSessionId
        logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);
        addLog('webhook', `Waiting for session to report back (PID: ${pid})...`, 'running');

        const completedSession = await Promise.race([readyPromise, exitPromise, timeoutPromise]);
        const spawnResult: SpawnSessionResult = {
          type: 'success',
          sessionId: completedSession.yohoRemoteSessionId!,
          logs: spawnLogs
        };
        return spawnResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        addLog('error', `Failed to spawn session: ${errorMessage}`, 'error');
        await maybeCleanupWorktree('exception');
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`,
          logs: spawnLogs
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = async (sessionId: string): Promise<boolean> => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.yohoRemoteSessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {
          if (!isTrackedSessionProcessCurrent(session)) {
            logger.debug(`[DAEMON RUN] Session ${sessionId} matched stale PID ${pid}, removing without killing`);
            pidToTrackedSession.delete(pid);
            continue;
          }

          try {
            if (session.startedBy === 'daemon' && session.childProcess) {
              const killed = await killProcessByChildProcess(session.childProcess, { timeout: 3000 });
              if (killed) {
                logger.debug(`[DAEMON RUN] Requested termination for daemon-spawned session ${sessionId}`);
              } else {
                logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}`);
              }
            } else {
              // For externally started sessions, try to kill by PID
              const killed = await killProcess(pid, { timeout: 3000 });
              if (killed) {
                logger.debug(`[DAEMON RUN] Requested termination for external session PID ${pid}`);
              } else {
                logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}`);
              }
            }
            return true;
          } catch (error) {
            logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            return false;
          } finally {
            pidToTrackedSession.delete(pid);
            logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          }
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      const tracked = pidToTrackedSession.get(pid);
      pidToTrackedSession.delete(pid);

      // Clean up temporary directories (codex auth, etc.)
      if (tracked?.tempDirs) {
        for (const dir of tracked.tempDirs) {
          fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('yr-cli'),
      onYohoRemoteSessionWebhook
    });

    const startedWithCliMtimeMs = getInstalledCliMtimeMs();

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      startedWithCliMtimeMs,
      daemonLogPath: logger.logFilePath
    };
    await writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create();

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    try {
      const recovered = await recoverTrackedSessionsFromServer({
        api,
        machineId,
        pidToTrackedSession
      });
      if (recovered > 0) {
        logger.debug(`[DAEMON RUN] Recovered ${recovered} live session(s) from server state before reconnect`);
      }
    } catch (error) {
      logger.debug('[DAEMON RUN] Failed to recover live sessions from server state', error);
    }

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      stopSession,
      requestShutdown: () => requestShutdown('yr-app')
    });

    // Connect to server
    apiMachine.connect();

    // Check if metadata has changed and update if needed
    const currentMetadata = machine.metadata;
    const metadataChanged = machineMetadataChanged(currentMetadata, initialMachineMetadata);

    if (metadataChanged) {
      logger.debug(`[DAEMON RUN] Metadata changed, updating...`);
      logger.debug(`[DAEMON RUN] Old host: ${currentMetadata?.host}, New host: ${initialMachineMetadata.host}`);
      await apiMachine.updateMachineMetadata(() => initialMachineMetadata);
      logger.debug(`[DAEMON RUN] Metadata updated successfully`);
    }

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.YR_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    let restartOnStaleVersionAndHeartbeat: ReturnType<typeof setInterval> | null = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, tracked] of pidToTrackedSession.entries()) {
        if (!isTrackedSessionProcessCurrent(tracked)) {
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists or identity changed)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update
      const installedCliMtimeMs = getInstalledCliMtimeMs();
        if (typeof installedCliMtimeMs === 'number' &&
          typeof startedWithCliMtimeMs === 'number' &&
          installedCliMtimeMs !== startedWithCliMtimeMs) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        const heartbeatInterval = restartOnStaleVersionAndHeartbeat;
        if (heartbeatInterval !== null) {
          clearInterval(heartbeatInterval);
        }

        if (managedBySystemd) {
          logger.debug('[DAEMON RUN] Running under systemd, requesting shutdown so systemd can restart the daemon with the new version');
          requestShutdown('exception', 'Daemon binary changed; systemd should restart the service with the new version.');
          return;
        }

        // Spawn new daemon
        // We do not need to clean ourselves up - we will be killed by the new daemon.
        try {
          // Check if we're running as standalone yoho-remote-daemon executable
          const isStandaloneDaemon = process.execPath.endsWith('yoho-remote-daemon') ||
                                      process.execPath.endsWith('yoho-remote-daemon.exe');

          if (isStandaloneDaemon) {
            // Standalone mode: just spawn ourselves directly (no arguments needed)
            const { spawn } = await import('child_process');
            spawn(process.execPath, [], {
              detached: true,
              stdio: 'ignore',
              env: process.env
            }).unref();
          } else {
            // Unified CLI mode: use the CLI to start daemon
            spawnYohoRemoteCLI(['daemon', 'start'], {
              detached: true,
              stdio: 'ignore'
            });
          }
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, resuming current daemon', error);
          heartbeatRunning = false;
          return;
        }

        // Wait for new daemon to kill us; if it doesn't within 10s, resume operation
        logger.debug('[DAEMON RUN] Waiting for new daemon to take over (10s timeout)');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        logger.debug('[DAEMON RUN] New daemon did not kill us — it may have failed to start. Resuming.');
        heartbeatRunning = false;
        return;
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          startedWithCliMtimeMs,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        await writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    let shutdownInProgress = false;
    const cleanupAndShutdown = async (source: 'yr-app' | 'yr-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      if (shutdownInProgress) {
        logger.debug('[DAEMON RUN] Shutdown already in progress, skipping duplicate request');
        return;
      }
      shutdownInProgress = true;
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      try {
      if (restartOnStaleVersionAndHeartbeat) {
          const heartbeatInterval = restartOnStaleVersionAndHeartbeat;
          clearInterval(heartbeatInterval);
          restartOnStaleVersionAndHeartbeat = null;
          logger.debug('[DAEMON RUN] Health check interval cleared');
        }

        try {
          await apiMachine.updateDaemonState((state: DaemonState | null) => ({
            ...state,
            status: 'shutting-down',
            shutdownRequestedAt: Date.now(),
            shutdownSource: source
          }));
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to update daemon state during shutdown', error);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      } finally {
        try {
          apiMachine.shutdown();
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to disconnect API machine during shutdown', error);
        }

        if (shutdownForceTimeout) {
          clearTimeout(shutdownForceTimeout);
          shutdownForceTimeout = null;
        }

        try {
          await stopControlServer();
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to stop control server during shutdown', error);
        }

        const trackedSessions = Array.from(pidToTrackedSession.values());
        pidToAwaiter.clear();
        for (const tracked of trackedSessions) {
          try {
            if (tracked.childProcess) {
              await killProcessByChildProcess(tracked.childProcess, { timeout: 3000 });
            } else {
              await killProcess(tracked.pid, { timeout: 3000 });
            }
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to kill tracked session during shutdown', error);
          }
        }
        pidToTrackedSession.clear();

        try {
          await cleanupDaemonState();
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to clean daemon state during shutdown', error);
        }

        try {
          await releaseDaemonLock(daemonLockHandle);
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to release daemon lock during shutdown', error);
        }

        logger.info('daemon shutdown complete');
        process.exit(0);
      }
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.debug(`[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1. Error: ${errorMessage}`);
    if (errorStack) {
      logger.debug(`[DAEMON RUN][FATAL] Stack trace: ${errorStack}`);
    }
    process.exit(1);
  }
}
