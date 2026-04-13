import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import { resolveCodexBinary } from './codexBinary';
import {
    buildCodexServiceTierArgs,
    DEFAULT_CODEX_SERVICE_TIER,
    type CodexServiceTier
} from './utils/codexServiceTier';

/**
 * Filter out 'resume' subcommand which is managed internally by yoho-remote.
 * Codex CLI format is `codex resume <session-id>`, so subcommand is always first.
 */
export function filterResumeSubcommand(args: string[]): string[] {
    if (args.length === 0 || args[0] !== 'resume') {
        return args;
    }

    // First arg is 'resume', filter it and optional session ID
    if (args.length > 1 && !args[1].startsWith('-')) {
        logger.debug(`[CodexLocal] Filtered 'resume ${args[1]}' - session managed by yoho-remote`);
        return args.slice(2);
    }

    logger.debug(`[CodexLocal] Filtered 'resume' - session managed by yoho-remote`);
    return args.slice(1);
}

export async function codexLocal(opts: {
    abort: AbortSignal;
    sessionId: string | null;
    path: string;
    model?: string;
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    serviceTier?: CodexServiceTier;
    onSessionFound: (id: string) => void;
    codexArgs?: string[];
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('resume', opts.sessionId);
        opts.onSessionFound(opts.sessionId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.sandbox) {
        args.push('--sandbox', opts.sandbox);
    }

    args.push(...buildCodexServiceTierArgs(opts.serviceTier ?? DEFAULT_CODEX_SERVICE_TIER));

    if (opts.codexArgs) {
        const safeArgs = filterResumeSubcommand(opts.codexArgs);
        args.push(...safeArgs);
    }

    logger.debug(`[CodexLocal] Spawning codex with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CodexLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    process.stdin.pause();
    try {
        const resolvedCodex = resolveCodexBinary(process.env);
        await spawnWithAbort({
            command: resolvedCodex.command,
            args,
            cwd: opts.path,
            env: resolvedCodex.env,
            signal: opts.abort,
            logLabel: 'CodexLocal',
            spawnName: 'codex',
            installHint: 'Codex CLI',
            includeCause: true,
            logExit: true
        });
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }
}
