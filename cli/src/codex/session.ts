import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { EnhancedMode, PermissionMode } from './loop';
import type { CodexCliOverrides } from './utils/codexCliOverrides';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { SessionModelReasoningEffort } from '@/api/types';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class CodexSession extends AgentSessionBase<EnhancedMode> {
    readonly codexArgs?: string[];
    readonly codexCliOverrides?: CodexCliOverrides;
    readonly startedBy: 'daemon' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    readonly machineId: string | null;
    readonly sessionSource: string | null;
    localLaunchFailure: LocalLaunchFailure | null = null;
    private runtimeModel: string | null = null;
    private runtimeModelReasoningEffort: SessionModelReasoningEffort | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<EnhancedMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'daemon' | 'terminal';
        startingMode: 'local' | 'remote';
        machineId?: string | null;
        sessionSource?: string | null;
        codexArgs?: string[];
        codexCliOverrides?: CodexCliOverrides;
        permissionMode?: PermissionMode;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'CodexSession',
            sessionIdLabel: 'Codex',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                codexSessionId: sessionId
            }),
            permissionMode: opts.permissionMode
        });

        this.codexArgs = opts.codexArgs;
        this.codexCliOverrides = opts.codexCliOverrides;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.machineId = opts.machineId ?? null;
        this.sessionSource = opts.sessionSource ?? null;
        this.permissionMode = opts.permissionMode;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    updateRuntimeModel = (model: string, reasoningEffort?: SessionModelReasoningEffort | null): void => {
        const normalizedModel = model.trim();
        if (!normalizedModel) {
            return;
        }
        const normalizedEffort = reasoningEffort ?? null;
        if (this.runtimeModel === normalizedModel && this.runtimeModelReasoningEffort === normalizedEffort) {
            return;
        }
        this.runtimeModel = normalizedModel;
        this.runtimeModelReasoningEffort = normalizedEffort;
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            runtimeModel: normalizedModel,
            runtimeModelReasoningEffort: normalizedEffort ?? undefined
        }));
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendCodexMessage = (message: unknown): void => {
        this.client.sendCodexMessage(message);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
