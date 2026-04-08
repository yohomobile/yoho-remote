import fs from 'fs/promises';
import os from 'os';

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

import { cleanupDaemonState, getInstalledCliMtimeMs, isDaemonRunningCurrentlyInstalledVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
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
  let resolvesWhenShutdownRequested = new Promise<({ source: 'yr-app' | 'yr-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

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

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
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
          startedBy: 'yr directly - likely by user from terminal',
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
        if (options.token) {
          if (options.agent === 'codex') {
            addLog('env', `Setting up Codex authentication`, 'running');
            // Create a temporary directory for Codex
            const codexHomeDir = await fs.mkdtemp(join(os.tmpdir(), 'yr-codex-'));

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir, 'auth.json'), options.token);

            // Set the environment variable for Codex
            extraEnv = {
              CODEX_HOME: codexHomeDir
            };
            addLog('env', `Codex authentication configured`, 'success');
          } else if (options.agent === 'codez') {
            addLog('env', `Setting up Codez authentication`, 'running');
            extraEnv = {
              OPENAI_API_KEY: options.token,
              CLAUDE_CODE_USE_OPENAI: '1'
            };
            addLog('env', `Codez authentication configured`, 'success');
          } else if (options.agent === 'claude' || !options.agent) {
            addLog('env', `Setting up Claude authentication`, 'running');
            extraEnv = {
              CLAUDE_CODE_OAUTH_TOKEN: options.token
            };
            addLog('env', `Claude authentication configured`, 'success');
          }
        }

        // For codez agent, always set CLAUDE_CODE_USE_OPENAI even without token
        if (options.agent === 'codez' && !extraEnv.CLAUDE_CODE_USE_OPENAI) {
          extraEnv = { ...extraEnv, CLAUDE_CODE_USE_OPENAI: '1' };
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
        // Pass Claude settings type (litellm or claude)
        if (options.claudeSettingsType) {
          extraEnv = { ...extraEnv, YR_CLAUDE_SETTINGS_TYPE: options.claudeSettingsType };
        }

        addLog('env', `Environment prepared successfully`, 'success');

        // Construct arguments for the CLI
        const agentCommand = (() => {
          switch (agent) {
            case 'codex': return 'codex';
            case 'codez': return 'codez';
            case 'opencode': return 'opencode';
            case 'droid': return 'droid';
            default: return 'claude';
          }
        })();
        const args = [
          agentCommand,
          '--yoho-remote-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];
        const claudeAgent = typeof options.claudeAgent === 'string' ? options.claudeAgent.trim() : '';
        if (agent === 'claude' && claudeAgent) {
          args.push('--agent', claudeAgent);
        }
        // Pass Claude model mode via --model argument
        if (agent === 'claude' && options.modelMode && (options.modelMode === 'sonnet' || options.modelMode === 'opus' || options.modelMode === 'glm-5.1')) {
          args.push('--model', options.modelMode);
        }
        const opencodeModel = typeof options.opencodeModel === 'string' ? options.opencodeModel.trim() : '';
        if (agent === 'opencode' && opencodeModel) {
          args.push('--model', opencodeModel);
        }
        // Always use highest reasoning effort for OpenCode
        if (agent === 'opencode') {
          extraEnv = { ...extraEnv, OPENCODE_VARIANT: 'max' };
        }
        // Pass Droid model and reasoning effort via environment variables
        const droidModel = typeof options.droidModel === 'string' ? options.droidModel.trim() : '';
        if (agent === 'droid' && droidModel) {
          extraEnv = { ...extraEnv, YR_DROID_MODEL: droidModel };
        }
        const droidReasoningEffort = typeof options.droidReasoningEffort === 'string' ? options.droidReasoningEffort.trim() : '';
        if (agent === 'droid' && droidReasoningEffort) {
          extraEnv = { ...extraEnv, YR_DROID_REASONING_EFFORT: droidReasoningEffort };
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

        cliProcess = spawnYohoRemoteCLI(args, {
          cwd: spawnDirectory,
          detached: true,  // Sessions stay alive when daemon stops
          stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
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
          message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined
        };

        pidToTrackedSession.set(pid, trackedSession);

        cliProcess.on('exit', (code, signal) => {
          logger.debug(`[DAEMON RUN] Child PID ${pid} exited with code ${code}, signal ${signal}`);
          if (code !== 0 || signal) {
            logStderrTail();
          }
          onChildExited(pid);
        });

        cliProcess.on('error', (error) => {
          logger.debug(`[DAEMON RUN] Child process error:`, error);
          onChildExited(pid);
        });

        // Wait for webhook to populate session with yohoRemoteSessionId
        logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${pid}`);
        addLog('webhook', `Waiting for session to report back (PID: ${pid})...`, 'running');

        const spawnResult = await new Promise<SpawnSessionResult>((resolve) => {
          // Set timeout for webhook
          const timeout = setTimeout(() => {
            pidToAwaiter.delete(pid);
            logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid}`);
            logStderrTail();
            addLog('webhook', `Session webhook timeout for PID ${pid}`, 'error');
            resolve({
              type: 'error',
              errorMessage: `Session webhook timeout for PID ${pid}`,
              logs: spawnLogs
            });
            // 15 second timeout - I have seen timeouts on 10 seconds
            // even though session was still created successfully in ~2 more seconds
          }, 15_000);

          // Register awaiter
          pidToAwaiter.set(pid, (completedSession) => {
            clearTimeout(timeout);
            logger.debug(`[DAEMON RUN] Session ${completedSession.yohoRemoteSessionId} fully spawned with webhook`);
            addLog('webhook', `Session ready: ${completedSession.yohoRemoteSessionId}`, 'success');
            addLog('complete', `Session created successfully`, 'success');
            resolve({
              type: 'success',
              sessionId: completedSession.yohoRemoteSessionId!,
              logs: spawnLogs
            });
          });
        });
        if (spawnResult.type !== 'success') {
          await maybeCleanupWorktree('spawn-error');
        }
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
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.yohoRemoteSessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              void killProcessByChildProcess(session.childProcess);
              logger.debug(`[DAEMON RUN] Requested termination for daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              void killProcess(pid);
              logger.debug(`[DAEMON RUN] Requested termination for external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
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
    writeDaemonState(fileState);
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
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        if (!isProcessAlive(pid)) {
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update
      const installedCliMtimeMs = getInstalledCliMtimeMs();
      if (typeof installedCliMtimeMs === 'number' &&
          typeof startedWithCliMtimeMs === 'number' &&
          installedCliMtimeMs !== startedWithCliMtimeMs) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

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
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        process.exit(0);
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
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'yr-app' | 'yr-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await cleanupDaemonState();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
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
