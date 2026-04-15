import { spawn, type SpawnOptions, type StdioOptions } from 'node:child_process';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';

const DEFAULT_ABORT_EXIT_CODES = [130, 137, 143];
const DEFAULT_ABORT_SIGNALS: NodeJS.Signals[] = ['SIGTERM'];

const isAbortError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const maybeError = error as { name?: string; code?: string };
    return maybeError.name === 'AbortError' || maybeError.code === 'ABORT_ERR';
};

/**
 * Function type for registering an interrupt handler.
 * The returned cleanup function should be called when the process exits.
 */
export type InterruptRegistrar = (sendInterrupt: () => void) => (() => void);

export type SpawnWithAbortOptions = {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    logLabel: string;
    spawnName: string;
    installHint: string;
    abortKillTimeoutMs?: number;
    abortExitCodes?: number[];
    abortSignals?: NodeJS.Signals[];
    includeCause?: boolean;
    logExit?: boolean;
    shell?: SpawnOptions['shell'];
    stdio?: StdioOptions;
    /**
     * A function that registers an interrupt handler.
     * When called, it receives a function that sends SIGINT to the child process.
     * This allows external code to trigger interrupts multiple times.
     * Returns a cleanup function that should be called when the process exits.
     */
    onInterruptRegistrar?: InterruptRegistrar;
};

export async function spawnWithAbort(options: SpawnWithAbortOptions): Promise<void> {
    const abortKillTimeoutMs = options.abortKillTimeoutMs ?? 5000;
    const abortExitCodes = options.abortExitCodes ?? DEFAULT_ABORT_EXIT_CODES;
    const abortSignals = options.abortSignals ?? DEFAULT_ABORT_SIGNALS;
    const stdio = options.stdio ?? ['inherit', 'inherit', 'inherit'];
    const logPrefix = options.logLabel ? `[${options.logLabel}] ` : '';

    const logDebug = (message: string, ...args: unknown[]) => {
        logger.debug(`${logPrefix}${message}`, ...args);
    };

    await new Promise<void>((resolve, reject) => {
        const child = spawn(options.command, options.args, {
            stdio,
            signal: options.signal,
            cwd: options.cwd,
            env: options.env,
            shell: options.shell
        });

        let abortKillTimeout: NodeJS.Timeout | null = null;
        let interruptCleanup: (() => void) | null = null;

        // Register interrupt handler if provided
        // This allows external code to send SIGINT to cancel current task
        if (options.onInterruptRegistrar) {
            const sendInterrupt = () => {
                if (child.exitCode === null && !child.killed) {
                    logDebug('Sending SIGINT for interrupt');
                    try {
                        child.kill('SIGINT');
                    } catch (error) {
                        logDebug('Failed to send SIGINT', error);
                    }
                }
            };
            interruptCleanup = options.onInterruptRegistrar(sendInterrupt);
        }

        // Handle abort signal (SIGTERM/SIGKILL) - for process termination
        const abortHandler = () => {
            if (abortKillTimeout) {
                return;
            }
            abortKillTimeout = setTimeout(() => {
                if (child.exitCode === null && !child.killed) {
                    logDebug('Abort timeout reached, sending SIGKILL');
                    try {
                        void killProcessByChildProcess(child, true);
                    } catch (error) {
                        logDebug('Failed to send SIGKILL', error);
                    }
                }
            }, abortKillTimeoutMs);
        };

        if (options.signal.aborted) {
            abortHandler();
        } else {
            options.signal.addEventListener('abort', abortHandler);
        }

        // Handle parent process exit - ensure child is killed (must be synchronous)
        const processExitHandler = () => {
            if (child.exitCode === null && !child.killed) {
                logDebug('Parent process exiting, killing child process');
                try {
                    child.kill('SIGKILL');
                } catch (error) {
                    logDebug('Failed to kill child on parent exit', error);
                }
            }
        };
        process.on('exit', processExitHandler);

        const cleanupHandlers = () => {
            if (abortKillTimeout) {
                clearTimeout(abortKillTimeout);
                abortKillTimeout = null;
            }
            options.signal.removeEventListener('abort', abortHandler);
            process.removeListener('exit', processExitHandler);
            interruptCleanup?.();
        };

        child.on('error', (error) => {
            cleanupHandlers();
            if (options.signal.aborted && isAbortError(error)) {
                logDebug('Spawn aborted while switching');
                if (!child.pid) {
                    resolve();
                }
                return;
            }
            if (options.signal.aborted) {
                resolve();
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            const errorMessage = `Failed to spawn ${options.spawnName}: ${message}. ` +
                `Is ${options.installHint} installed and on PATH?`;
            if (options.includeCause) {
                reject(new Error(errorMessage, { cause: error }));
            } else {
                reject(new Error(errorMessage));
            }
        });

        child.on('exit', (code, signal) => {
            cleanupHandlers();
            if (options.logExit) {
                logDebug(`Child exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}, aborted=${options.signal.aborted})`);
            }
            if (options.signal.aborted && signal && abortSignals.includes(signal)) {
                resolve();
                return;
            }
            if (options.signal.aborted && typeof code === 'number' && abortExitCodes.includes(code)) {
                resolve();
                return;
            }
            if (signal) {
                reject(new Error(`Process terminated with signal: ${signal}`));
                return;
            }
            if (typeof code === 'number' && code !== 0) {
                reject(new Error(`Process exited with code: ${code}`));
                return;
            }
            resolve();
        });
    });
}
