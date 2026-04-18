import { logger } from "@/ui/logger";
import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { Future } from "@/utils/future";
import { createSessionScanner } from "./utils/sessionScanner";
import { getLocalLaunchExitReason } from "@/agent/localLaunchPolicy";

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    const updateRuntimeModelFromMessage = (message: { type: string; model?: unknown }) => {
        if (message.type !== 'system' || typeof message.model !== 'string' || !message.model.trim()) {
            return;
        }
        session.updateRuntimeModel(message.model);
    };

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => { 
            updateRuntimeModelFromMessage(message as { type: string; model?: unknown });
            // Block SDK summary messages - we generate our own
            if (message.type !== 'summary') {
                session.client.sendClaudeSessionMessage(message)
            }
        }
    });

    const handleSessionFound = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);

    const handleSessionClearMessages = (payload: { sid?: string; sessionId?: string; time?: number }) => {
        const targetSessionId = typeof payload.sid === 'string' && payload.sid.length > 0
            ? payload.sid
            : typeof payload.sessionId === 'string' && payload.sessionId.length > 0
                ? payload.sessionId
                : session.client.sessionId;
        if (targetSessionId !== session.client.sessionId) {
            return;
        }
        scanner.clearSessionCache(
            targetSessionId,
            typeof payload.time === 'number' && Number.isFinite(payload.time) ? payload.time : Date.now()
        );
    };
    session.client.on('session:clear-messages', handleSessionClearMessages);


    // Handle abort and interrupt
    let exitReason: 'switch' | 'exit' | null = null;
    const processAbortController = new AbortController();
    const exitFuture = new Future<void>();

    // Store the interrupt function when it's registered by spawnWithAbort
    let sendInterrupt: (() => void) | null = null;

    try {
        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exitFuture.promise;
        }

        async function doAbort() {
            logger.debug('[local]: doAbort');

            // Send SIGINT to cancel current task without killing the process
            if (sendInterrupt) {
                logger.debug('[local]: sending SIGINT via interrupt handler');
                sendInterrupt();
            } else {
                logger.debug('[local]: no interrupt handler registered, cannot send SIGINT');
            }
        }

        async function doSwitch() {
            logger.debug('[local]: doSwitch');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = 'switch';
            }

            // Abort
            await abort();
        }

        // When to abort (now sends SIGINT instead of killing)
        session.client.rpcHandlerManager.registerHandler('abort', doAbort); // Send SIGINT to cancel current task
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When user wants to switch to remote mode
        session.queue.setOnMessage((message: string, mode) => {
            // Switch to remote mode when message received
            doSwitch();
        }); // When any message is received, abort current process, clean queue and switch to remote mode

        // Exit if there are messages in the queue
        if (session.queue.size() > 0) {
            return 'switch';
        }

        // Run local mode
        while (true) {
            // If we already have an exit reason, return it
            if (exitReason) {
                return exitReason;
            }

            // Launch
            logger.debug('[local]: launch');
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    abort: processAbortController.signal,
                    onInterruptRegistrar: (interruptFn) => {
                        // Store the interrupt function so doAbort can call it
                        sendInterrupt = interruptFn;
                        // Return cleanup function
                        return () => {
                            sendInterrupt = null;
                        };
                    },
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.hookSettingsPath,
                    executableCommand: session.executableCommand,
                });

                // Consume one-time Claude flags after spawn
                // For example we don't want to pass --resume flag after first spawn
                session.consumeOneTimeFlags();

                // Normal exit
                if (!exitReason) {
                    exitReason = 'exit';
                    break;
                }
            } catch (e) {
                logger.debug('[local]: launch error', e);
                const message = e instanceof Error ? e.message : String(e);
                session.client.sendSessionEvent({ type: 'message', message: `Local Claude process failed: ${message}` });

                const failureExitReason = exitReason ?? getLocalLaunchExitReason({
                    startedBy: session.startedBy,
                    startingMode: session.startingMode
                });
                session.recordLocalLaunchFailure(message, failureExitReason);
                if (!exitReason) {
                    exitReason = failureExitReason;
                }
                if (failureExitReason === 'exit') {
                    logger.warn(`[local]: Local Claude process failed: ${message}`);
                }
                break;
            }
            logger.debug('[local]: launch done');
        }
    } finally {

        // Resolve future
        exitFuture.resolve(undefined);

        // Set handlers to no-op
        session.client.rpcHandlerManager.registerHandler('abort', async () => { });
        session.client.rpcHandlerManager.registerHandler('switch', async () => { });
        session.queue.setOnMessage(null);

        // Cleanup
        session.removeSessionFoundCallback(handleSessionFound);
        session.client.off('session:clear-messages', handleSessionClearMessages);
        await scanner.cleanup();
    }

    // Return
    return exitReason || 'exit';
}
