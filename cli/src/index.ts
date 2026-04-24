#!/usr/bin/env bun

/**
 * CLI entry point for yoho-remote command
 *
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import type { StartOptions } from '@/claude/runClaude'
import { logger } from './ui/logger'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import packageJson from '../package.json'
import { isBunCompiled } from './projectPath'
import { z } from 'zod'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayYohoRemoteProcesses } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { runDoctorCommand } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { spawnYohoRemoteCLI } from './utils/spawnYohoRemoteCLI'
import { execFileSync } from 'node:child_process'
import { initializeToken } from './ui/tokenInit'
import { ensureRuntimeAssets } from './runtime/assets'
import { runYohoRemoteMcpStdioBridge } from './codex/yohoRemoteMcpStdioBridge'
import { withBunRuntimeEnv } from './utils/bunRuntime'
import { getCliArgs } from './utils/cliArgs'


(async () => {
  const args = getCliArgs()

  if (args.includes('-v') || args.includes('--version')) {
    console.log(`yoho-remote version: ${packageJson.version}`)
    process.exit(0)
  }

  // Check if first argument is a subcommand
  const subcommand = args[0]

  if (isBunCompiled()) {
    process.env.DEV = 'false'
  }

  if (subcommand === 'mcp') {
    await runYohoRemoteMcpStdioBridge(args.slice(1))
    return
  }

  if (subcommand === 'server') {
    try {
      await import('../../server/src/index')
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return
  }

  if (subcommand === 'hook-forwarder') {
    const { runSessionHookForwarder } = await import('@/claude/utils/sessionHookForwarder')
    await runSessionHookForwarder(args.slice(1))
    return
  }

  await ensureRuntimeAssets()

  logger.debug('Starting YR CLI with args: ', process.argv)

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      const result = await killRunawayYohoRemoteProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
      process.exit(0)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
    } else if (subcommand === 'codex') {
      // Handle codex command
      try {
        const { runCodex } = await import('@/codex/runCodex');

      // Parse known arguments and collect unknown ones for passthrough
      const options: {
        startedBy?: 'daemon' | 'terminal';
        codexArgs?: string[];
        permissionMode?: 'default' | 'read-only' | 'safe-yolo' | 'yolo';
        yohoRemoteSessionId?: string;
        resumeSessionId?: string;
      } = {};
      const unknownArgs: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--started-by') {
          options.startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (arg === '--yoho-remote-session-id') {
          options.yohoRemoteSessionId = args[++i];
        } else if (arg === '--yoho-remote-resume-session-id') {
          options.resumeSessionId = args[++i];
        } else if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') {
          options.permissionMode = 'yolo';
          unknownArgs.push(arg);
        } else {
          unknownArgs.push(arg);
        }
      }
      if (unknownArgs.length > 0) {
        options.codexArgs = unknownArgs;
      }

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runCodex(options);
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini command
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let yolo = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--yolo') {
          yolo = true;
        }
      }

      const { registerGeminiAgent } = await import('./agent/runners/gemini');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerGeminiAgent(yolo);

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'gemini', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'glm') {
    // Handle glm command (NVIDIA NIM GLM-4.7)
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }

      const { registerGlmAgent } = await import('./agent/runners/glm');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerGlmAgent();

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'glm', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'minimax') {
    // Handle minimax command (NVIDIA NIM MiniMax-M2.1)
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }

      const { registerMinimaxAgent } = await import('./agent/runners/minimax');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerMinimaxAgent();

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'minimax', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'grok') {
    // Handle grok command (Grok CLI with ACP)
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let yolo = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--yolo') {
          yolo = true;
        }
      }

      const { registerGrokAgent } = await import('./agent/runners/grok');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerGrokAgent(yolo);

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'grok', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'openrouter') {
    // Handle openrouter command (OpenRouter-powered coding assistant)
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let model: string | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--model') {
          model = args[++i];
        }
      }

      const { registerOpenRouterAgent } = await import('./agent/runners/openrouter');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerOpenRouterAgent(model);

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'openrouter', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'cursor') {
    // Handle cursor command (Cursor CLI Agent)
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let yolo = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--yolo') {
          yolo = true;
        }
      }

      const { registerCursorAgent } = await import('./agent/runners/cursor');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerCursorAgent(yolo);

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'cursor', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'aider-cli') {
    // Handle aider-cli command (真正的 Aider CLI)
    try {
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let model: string | undefined = undefined;
      let yolo = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--model') {
          model = args[++i];
        } else if (args[i] === '--yolo') {
          yolo = true;
        }
      }

      const { registerAiderCliAgent } = await import('./agent/runners/aider-cli');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');
      registerAiderCliAgent(model, yolo);

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'aider-cli', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "hapi logout" is deprecated. Use "hapi auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    console.error(chalk.red('The `hapi notify` command is not available in direct-connect mode.'))
    console.error(chalk.gray('Use web push notifications from yoho-remote server instead.'))
    process.exit(1)
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const child = spawnYohoRemoteCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      await initializeToken();
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      // Show daemon-specific doctor output
      await runDoctorCommand('daemon')
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else if (daemonSubcommand === 'install') {
      try {
        await install()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else {
      console.log(`
${chalk.bold('hapi daemon')} - Daemon management

${chalk.bold('Usage:')}
  hapi daemon start              Start the daemon (detached)
  hapi daemon stop               Stop the daemon (sessions stay alive)
  hapi daemon status             Show daemon status
  hapi daemon list               List active sessions

  If you want to kill all hapi related processes run 
  ${chalk.cyan('hapi doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('hapi doctor clean')}
`)
    }
    return;
  } else {

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '--yoho-remote-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yoho-remote-session-id') {
        options.yohoRemoteSessionId = args[++i]
      } else if (arg === '--yoho-remote-resume-session-id') {
        options.resumeSessionId = args[++i]
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        options.permissionMode = 'bypassPermissions'
        unknownArgs.push('--dangerously-skip-permissions')
      } else if (arg === '--dangerously-skip-permissions') {
        options.permissionMode = 'bypassPermissions'
        unknownArgs.push(arg)
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('hapi')} - Yoho Remote

${chalk.bold('Usage:')}
  hapi [options]         Start Claude with Yoho Remote control (direct-connect)
  hapi auth              Manage authentication
  hapi codex             Start Codex mode
  hapi gemini            Start Gemini ACP mode
  hapi glm               Start GLM-4.7 mode (NVIDIA NIM)
  hapi minimax           Start MiniMax-M2.1 mode (NVIDIA NIM)
  hapi grok              Start Grok CLI mode
  hapi cursor            Start Cursor CLI mode
  hapi aider-cli         Start Aider CLI mode (真正的 aider)
  hapi mcp               Start MCP stdio bridge
  hapi connect           (not available in direct-connect mode)
  hapi notify            (not available in direct-connect mode)
  hapi server            Start the API + web server
  hapi daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  hapi doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  hapi                    Start session (will prompt for token if not set)
  hapi auth login         Configure CLI_API_TOKEN interactively
  hapi --yolo             Start with bypassing permissions
                            hapi sugar for --dangerously-skip-permissions
  hapi auth status        Show direct-connect status
  hapi doctor             Run diagnostics

${chalk.bold('hapi supports ALL Claude options!')}
  Use any claude flag with hapi as you would with claude. Our favorite:

  hapi --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)
      
      // Run claude --help and display its output
      try {
        const claudeHelp = execFileSync(
          'claude',
          ['--help'],
          { encoding: 'utf8', env: withBunRuntimeEnv(), shell: process.platform === 'win32' }
        )
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }
      
      process.exit(0)
    }

    // Normal flow - auth and machine setup
    await initializeToken();
    await authAndSetupMachineIfNeeded();

    // Always auto-start daemon for simplicity
    logger.debug('Ensuring YR background service is running & matches our version...');

    if (!(await isDaemonRunningCurrentlyInstalledVersion())) {
      logger.debug('Starting YR background service...');

      // Use the built binary to spawn daemon
      const daemonProcess = spawnYohoRemoteCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      daemonProcess.unref();

      // Give daemon a moment to write PID & port file
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Start the CLI
    try {
      const { runClaude } = await import('@/claude/runClaude');
      await runClaude(options);
    } catch (error) {
      // Categorize errors for better user experience
      const message = error instanceof Error ? error.message : 'Unknown error';
      const messageLower = message.toLowerCase();
      const axiosCode = (error as any)?.code;
      const httpStatus = (error as any)?.response?.status;
      const responseError = (error as any)?.response?.data?.error;
      const responseErrorText = typeof responseError === 'string' ? responseError : '';

      if (axiosCode === 'ECONNREFUSED' || axiosCode === 'ETIMEDOUT' || axiosCode === 'ENOTFOUND' ||
          messageLower.includes('econnrefused') || messageLower.includes('etimedout') ||
          messageLower.includes('enotfound') || messageLower.includes('network error')) {
        const { configuration } = await import('@/configuration');
        console.error(chalk.yellow('Unable to connect to YR server'));
        console.error(chalk.gray(`  Server URL: ${configuration.serverUrl}`));
        console.error(chalk.gray('  Please check your network connection or server status'));
      } else if (httpStatus === 403 && responseErrorText === 'Machine access denied') {
        console.error(chalk.red('Machine access denied.'));
        console.error(chalk.gray('  This machineId is already registered under a different namespace.'));
        console.error(chalk.gray('  Fix: run `hapi auth logout`, or set a separate YOHO_REMOTE_HOME per namespace.'));
      } else if (httpStatus === 403 && responseErrorText === 'Session access denied') {
        console.error(chalk.red('Session access denied.'));
        console.error(chalk.gray('  This session belongs to a different namespace.'));
        console.error(chalk.gray('  Use the matching CLI_API_TOKEN or switch namespaces.'));
      } else if (httpStatus === 401 || httpStatus === 403 ||
                 messageLower.includes('unauthorized') || messageLower.includes('forbidden')) {
        console.error(chalk.red('Authentication error:'), message);
        console.error(chalk.gray('  Run: hapi auth login'));
      } else {
        console.error(chalk.red('Error:'), message);
      }

      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }
})();
