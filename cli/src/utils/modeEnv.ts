import type { SessionModelMode, SessionModelReasoningEffort, SessionPermissionMode } from '@/api/types';

/**
 * Valid permission modes for resume
 */
const PERMISSION_MODES = new Set<SessionPermissionMode>([
    'bypassPermissions',
    'read-only', 'safe-yolo', 'yolo'
]);

/**
 * Valid model modes for resume
 */
const MODEL_MODES = new Set<SessionModelMode>([
    'sonnet', 'opus', 'opus-4-7', 'glm-5.1',
    'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
    'grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-code-fast-1',
    'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning', 'grok-4-0709', 'grok-3-mini', 'grok-3'
]);

/**
 * Valid reasoning effort levels
 */
const REASONING_EFFORTS = new Set<SessionModelReasoningEffort>([
    'low', 'medium', 'high', 'xhigh'
]);

export interface ModeEnvSettings {
    permissionMode?: SessionPermissionMode;
    modelMode?: SessionModelMode;
    modelReasoningEffort?: SessionModelReasoningEffort;
}

/**
 * Read mode settings from environment variables.
 * These are set by the daemon when resuming a session to restore the original settings.
 */
export function readModeEnv(): ModeEnvSettings {
    const result: ModeEnvSettings = {};

    const permissionMode = process.env.YR_PERMISSION_MODE?.trim();
    if (permissionMode && PERMISSION_MODES.has(permissionMode as SessionPermissionMode)) {
        result.permissionMode = permissionMode as SessionPermissionMode;
    }

    const modelMode = process.env.YR_MODEL_MODE?.trim();
    if (modelMode && MODEL_MODES.has(modelMode as SessionModelMode)) {
        result.modelMode = modelMode as SessionModelMode;
    }

    const modelReasoningEffort = process.env.YR_MODEL_REASONING_EFFORT?.trim();
    if (modelReasoningEffort && REASONING_EFFORTS.has(modelReasoningEffort as SessionModelReasoningEffort)) {
        result.modelReasoningEffort = modelReasoningEffort as SessionModelReasoningEffort;
    }

    return result;
}
