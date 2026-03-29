import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    AgentBackend,
    AgentMessage,
    AgentSessionConfig,
    HistoryMessage,
    PermissionRequest,
    PermissionResponse,
    PromptContent
} from '@/agent/types';
import { logger } from '@/ui/logger';
import { killProcessByChildProcess } from '@/utils/process';
import { DroidStreamParser } from './DroidStreamParser';

type DroidSession = {
    id: string;
    config: AgentSessionConfig;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    abortController: AbortController | null;
    childProcess: ChildProcessWithoutNullStreams | null;
    /** Droid 端的 session_id（从 completion 事件提取） */
    droidSessionId: string | null;
    tempPromptFile: string | null;
};

export type DroidBackendOptions = {
    apiKey: string;
    autoConfirm?: boolean;
};

export class DroidBackend implements AgentBackend {
    private readonly apiKey: string;
    private readonly autoConfirm: boolean;
    private readonly sessions = new Map<string, DroidSession>();
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;

    constructor(options: DroidBackendOptions) {
        this.apiKey = options.apiKey;
        this.autoConfirm = options.autoConfirm ?? false;
        logger.debug('[Droid] Backend created', { autoConfirm: this.autoConfirm });
    }

    async initialize(): Promise<void> {
        logger.debug('[Droid] Initializing backend...');

        if (!this.apiKey) {
            const error = 'Factory API key not configured. Set FACTORY_API_KEY environment variable.';
            logger.warn('[Droid]', error);
            throw new Error(error);
        }

        try {
            await this.checkDroidExists();
            logger.debug('[Droid] droid CLI found in PATH');
        } catch (error) {
            logger.warn('[Droid] droid CLI not found', error);
            throw error;
        }

        logger.debug('[Droid] Backend initialized successfully');
    }

    private async checkDroidExists(): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = spawn('droid', ['--version'], {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                const message = error.message;
                const isNotFound = message.includes('ENOENT') || message.includes('not found');
                reject(new Error(
                    isNotFound
                        ? 'droid not found. Install Factory CLI: curl -fsSL https://app.factory.ai/cli | sh'
                        : `Failed to run droid: ${message}`
                ));
            });

            child.on('exit', (code) => {
                if (code === 0) {
                    logger.debug('[Droid] droid version:', stdout.trim());
                    resolve();
                } else {
                    reject(new Error(`droid exited with code ${code}: ${stderr}`));
                }
            });
        });
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        const sessionId = randomUUID();

        const session: DroidSession = {
            id: sessionId,
            config,
            messages: [],
            abortController: null,
            childProcess: null,
            droidSessionId: null,
            tempPromptFile: null
        };

        this.sessions.set(sessionId, session);
        logger.debug('[Droid] Created session', { sessionId, cwd: config.cwd });

        return sessionId;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            const error = `Session not found: ${sessionId}`;
            logger.warn('[Droid]', error);
            throw new Error(error);
        }

        const userMessage = content.map(c => c.text).join('\n');
        session.messages.push({ role: 'user', content: userMessage });

        logger.debug('[Droid] Starting prompt', {
            sessionId,
            messageLength: userMessage.length,
            cwd: session.config.cwd
        });

        const args = this.buildArgs(userMessage, session);
        logger.debug('[Droid] Spawning droid exec', { argsCount: args.length });

        session.abortController = new AbortController();

        let assistantContent = '';

        try {
            assistantContent = await this.runDroidProcess(session, args, onUpdate);

            if (assistantContent) {
                session.messages.push({ role: 'assistant', content: assistantContent });
            }

            logger.debug('[Droid] Prompt completed', {
                sessionId,
                responseLength: assistantContent.length
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                logger.debug('[Droid] Prompt cancelled', { sessionId });
                onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
                return;
            }

            logger.warn('[Droid] Prompt failed', {
                sessionId,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        } finally {
            session.childProcess = null;
            session.abortController = null;
        }
    }

    private buildArgs(message: string, session: DroidSession): string[] {
        const args: string[] = [
            'exec',
            '--output-format', 'stream-json'
        ];

        // 模型选择（通过环境变量传入）
        const droidModel = process.env.YR_DROID_MODEL;
        if (droidModel) {
            args.push('--model', droidModel);
        }

        // Reasoning effort（通过环境变量传入）
        const droidReasoningEffort = process.env.YR_DROID_REASONING_EFFORT;
        if (droidReasoningEffort) {
            args.push('--reasoning-effort', droidReasoningEffort);
        }

        // 权限级别映射
        if (this.autoConfirm) {
            args.push('--auto', 'high');
        }

        // 工作目录
        if (session.config.cwd) {
            args.push('--cwd', session.config.cwd);
        }

        // 续接 Droid 端的 session（如果有）
        if (session.droidSessionId) {
            args.push('-s', session.droidSessionId);
        }

        // 长消息使用临时文件
        if (message.length > 4000) {
            const tempFile = join(tmpdir(), `droid-prompt-${session.id}-${Date.now()}.md`);
            writeFileSync(tempFile, message, 'utf8');
            session.tempPromptFile = tempFile;
            args.push('-f', tempFile);
        } else {
            args.push(message);
        }

        return args;
    }

    private async runDroidProcess(
        session: DroidSession,
        args: string[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                FACTORY_API_KEY: this.apiKey
            };

            const child = spawn('droid', args, {
                cwd: session.config.cwd,
                env,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            session.childProcess = child;

            const processExitHandler = () => {
                if (child.exitCode === null && !child.killed) {
                    logger.debug('[Droid] Parent process exiting, killing child process');
                    try {
                        child.kill('SIGKILL');
                    } catch (error) {
                        logger.debug('[Droid] Failed to kill child on parent exit', error);
                    }
                }
            };
            process.on('exit', processExitHandler);

            let textContent = '';
            let lastStderr = '';

            const wrappedOnUpdate = (msg: AgentMessage) => {
                if (msg.type === 'text') {
                    textContent += msg.text;
                }
                onUpdate(msg);
            };

            const parser = new DroidStreamParser(wrappedOnUpdate);

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                parser.handleChunk(chunk);
            });

            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => {
                lastStderr = chunk;
                parser.handleStderr(chunk);
            });

            child.on('exit', (code, signal) => {
                logger.debug('[Droid] Process exited', { code, signal });
                process.removeListener('exit', processExitHandler);

                // 提取 Droid 端 session_id 用于后续续接
                if (parser.droidSessionId) {
                    session.droidSessionId = parser.droidSessionId;
                }

                if (code === 0 || signal === 'SIGTERM') {
                    const remaining = parser.getRemaining();
                    if (remaining) {
                        logger.debug('[Droid] Remaining buffer after exit', {
                            length: remaining.length
                        });
                    }

                    resolve(textContent);
                } else {
                    const errorMsg = `droid exited with code ${code}`;
                    logger.warn('[Droid] Unexpected exit', {
                        code,
                        signal,
                        stderr: lastStderr.slice(0, 500)
                    });
                    onUpdate({ type: 'error', message: errorMsg });
                    reject(new Error(`${errorMsg}${lastStderr ? `: ${lastStderr}` : ''}`));
                }
            });

            child.on('error', (error) => {
                logger.warn('[Droid] Process error', {
                    error: error.message,
                    stack: error.stack
                });

                const message = error.message;
                const isNotFound = message.includes('ENOENT') || message.includes('not found');

                if (isNotFound) {
                    reject(new Error(
                        'droid not found. Install Factory CLI: curl -fsSL https://app.factory.ai/cli | sh'
                    ));
                } else {
                    reject(error);
                }
            });

            session.abortController?.signal.addEventListener('abort', () => {
                logger.debug('[Droid] Abort signal received, killing process');
                child.kill('SIGTERM');

                setTimeout(() => {
                    if (!child.killed) {
                        logger.debug('[Droid] Force killing process');
                        child.kill('SIGKILL');
                    }
                }, 2000);
            });

            child.stdin.end();
        });
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.debug('[Droid] Cannot cancel: session not found', { sessionId });
            return;
        }

        logger.debug('[Droid] Cancelling prompt', { sessionId });

        if (session.abortController) {
            session.abortController.abort();
        }

        if (session.childProcess && !session.childProcess.killed) {
            await killProcessByChildProcess(session.childProcess);
        }
    }

    /**
     * Droid exec headless 模式不产生交互式权限请求，
     * 权限通过 --auto 参数在 spawn 时控制
     */
    async respondToPermission(
        _sessionId: string,
        _request: PermissionRequest,
        _response: PermissionResponse
    ): Promise<void> {
        logger.debug('[Droid] respondToPermission called (no-op for Droid exec)');
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
        logger.debug('[Droid] Permission handler registered');
    }

    async disconnect(): Promise<void> {
        logger.debug('[Droid] Disconnecting, cleaning up sessions', {
            sessionCount: this.sessions.size
        });

        for (const session of this.sessions.values()) {
            if (session.abortController) {
                session.abortController.abort();
            }
            if (session.childProcess && !session.childProcess.killed) {
                await killProcessByChildProcess(session.childProcess);
            }
            this.cleanupTempFile(session);
        }

        this.sessions.clear();
        logger.debug('[Droid] Disconnected');
    }

    restoreHistory(sessionId: string, messages: HistoryMessage[]): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.debug('[Droid] Cannot restore history: session not found', { sessionId });
            return;
        }

        for (const msg of messages) {
            session.messages.push({
                role: msg.role,
                content: msg.content
            });
        }

        logger.debug('[Droid] Restored history', {
            sessionId,
            count: messages.length
        });
    }

    private cleanupTempFile(session: DroidSession): void {
        if (session.tempPromptFile) {
            try {
                unlinkSync(session.tempPromptFile);
            } catch {
                // ignore
            }
            session.tempPromptFile = null;
        }
    }
}
