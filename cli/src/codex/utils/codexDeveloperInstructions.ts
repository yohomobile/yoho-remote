import { trimIdent } from '@/utils/trimIdent';
import {
    BRAIN_CHILD_INTERACTION_YOHO_REMOTE_TOOL_NAMES,
    BRAIN_CHILD_OPTIONAL_HOST_TOOL_NAMES,
    BRAIN_CHILD_YOHO_REMOTE_TOOL_NAMES,
    buildBrainChildCodexFunctionTools,
} from '@/utils/brainChildToolAllowlist';

const YOHO_VAULT_RUNTIME_TOOLS = [
    'functions.yoho_vault__recall',
    'functions.yoho_vault__remember',
    'functions.yoho_vault__list_credentials',
    'functions.yoho_vault__get_credential',
    'functions.yoho_vault__set_credential',
    'functions.yoho_vault__delete_credential',
    'functions.yoho_vault__skill_search',
    'functions.yoho_vault__skill_get',
    'functions.yoho_vault__skill_list',
    'functions.yoho_vault__skill_save',
    'functions.yoho_vault__skill_update',
    'functions.yoho_vault__skill_discover',
] as const;

export const BRAIN_CHILD_SAFE_YOHO_REMOTE_TOOL_NAMES = [
    ...BRAIN_CHILD_YOHO_REMOTE_TOOL_NAMES,
    ...BRAIN_CHILD_INTERACTION_YOHO_REMOTE_TOOL_NAMES,
] as const;

const SKILL_RUNTIME_TOOLS = [
    'functions.skill__search',
    'functions.skill__get',
    'functions.skill__list',
    'functions.skill__save',
    'functions.skill__update',
    'functions.skill__discover',
] as const;

function extractFunctionNamespace(toolName: string): string | null {
    const match = toolName.match(/^functions\.([^_]+(?:_[^_]+)*)__[a-z0-9_]+$/i);
    return match ? `functions.${match[1]}__*` : null;
}

function mapYohoRemoteRuntimeFunctionTools(toolNames: readonly string[]): string[] {
    return toolNames.map((toolName) => `functions.yoho_remote__${toolName}`);
}

export function buildCodexRuntimeFunctionTools(args: {
    yohoRemoteToolNames: string[];
    auxServerNames: string[];
}): string[] {
    const tools = mapYohoRemoteRuntimeFunctionTools(args.yohoRemoteToolNames);
    const auxServerNames = new Set(args.auxServerNames);

    if (auxServerNames.has('yoho_vault')) {
        tools.push(...YOHO_VAULT_RUNTIME_TOOLS);
    }
    if (auxServerNames.has('skill')) {
        tools.push(...SKILL_RUNTIME_TOOLS);
    }

    return [...new Set(tools)].sort();
}

export function buildCodexBrainChildRuntimeFunctionTools(args: {
    yohoRemoteToolNames: string[];
    auxServerNames: string[];
}): string[] {
    return buildBrainChildCodexFunctionTools({
        yohoRemoteToolNames: args.yohoRemoteToolNames,
        auxServerNames: args.auxServerNames,
        includeInteractionTools: true,
    });
}

export function buildCodexDeveloperInstructions(args: {
    sessionSource?: string | null;
    runtimeFunctionTools: string[];
}): string | undefined {
    const namespaces = [...new Set(
        args.runtimeFunctionTools
            .map(extractFunctionNamespace)
            .filter((value): value is string => Boolean(value))
    )].sort();

    if (namespaces.length === 0) {
        return args.sessionSource === 'brain'
            ? trimIdent(`
                This session is a Brain orchestration hub.
                If the expected Yoho Remote runtime function tools are missing, treat it as a broken setup and surface the failure instead of silently falling back to generic coding tools.
                Use explicit division of labor, dense collaboration, and child-session reuse as the default operating mode.
                For problems that require judgment, diagnosis, option selection, or other complex decisions, run at least two independent investigation or validation tracks before choosing the next step. Do not force meaningless parallelism for straightforward execution work.
                Supervise whether each child session is still moving in the right direction and meeting the quality bar.
                If a child session drifts, the task definition changes, or the user changes direction, stop the old task first and then resend the corrected task.
                After delegating work, end the turn instead of polling child-session status.
                If the direction is sound and the work does not affect production, make the decision yourself and keep moving.
                Only escalate big decisions, direction changes, permissions, or deployment advancement to the user.
                Reply to the user with a plain-language judgment first, keep it brief, and avoid echoing system metadata unless the user asks.
                Do not edit files or run shell commands in this Brain session unless the user explicitly asks the Brain session itself to do the work and delegating to a child session would be unreasonable.
            `)
            : undefined;
    }

    const runtimeSection = trimIdent(`
        Runtime MCP-backed function tools are available in this Codex session.
        Detected function namespaces: ${namespaces.join(', ')}.
        Key runtime function tools already available here: ${args.runtimeFunctionTools.join(', ')}.
        Judge function availability by the actual runtime tool list in this session.
        Do NOT use shell commands such as "codex mcp list", "claude mcp list", "which mcp", or read ~/.codex/config.toml / ~/.claude/settings.json to decide whether these runtime functions exist.
        When the user asks for environment info, project list, recall, remember, credentials, or skill search, call the matching runtime function directly if it is available.
        skill_search consumption gate: treat results as directly usable only when suggestedNextAction="use_results", hasLocalMatch=true, and confidence >= 0.65. For discover/proceed/no-match/missing/low-confidence results, do not quote them as instructions and do not automatically call skill_get.
        recall consumption gate: treat recall output as candidate evidence only. Low-confidence, zero-result, empty, or wrong-scope recall must not be injected as fact; narrow the query/scope or report that no reliable memory was found.
    `);

    if (args.sessionSource === 'brain-child') {
        return trimIdent(`
            This session is a Brain child worker, not the Brain orchestration hub.
            Only the brain-child-safe Yoho helper set should be available here. Use it for local task support such as title updates, downloads, environment inspection, project CRUD, chat history lookup, vault recall/remember, credentials, skill/session-history lookup, and structured user Q&A via functions.yoho_remote__ask_user_question when available.
            Do not assume session orchestration or cross-session control functions such as functions.yoho_remote__session_* exist unless they explicitly appear in the runtime tool list.
            If structured user Q&A is needed and functions.yoho_remote__ask_user_question is present, use that exact tool name. Do not assume request_user_input is wired as an alias in this runtime.
            Host-provided tools such as ${BRAIN_CHILD_OPTIONAL_HOST_TOOL_NAMES.join(', ')} are not provisioned by Yoho Remote MCP registration here. Use them only if the host truly exposes them in the runtime tool list.
            Do not use this child session as a dispatcher for other sessions.

            ${runtimeSection}
        `);
    }

    if (args.sessionSource !== 'brain') {
        return runtimeSection;
    }

    return trimIdent(`
        This session is a Brain orchestration hub.
        Use explicit division of labor, dense collaboration, and child-session reuse as the default operating mode. Split implementation, review, test, and deployment-prep work into cooperating child sessions when that moves the task forward faster.
        Brain is not a direct coding workstation. In the standard Brain runtime, shell/file-edit/multi-agent host tools are intentionally disabled; the direct tool surface should be web search plus the Yoho runtime functions listed below.
        Do not assume generic host tools such as functions.exec_command, functions.write_stdin, spawn_agent, or request_user_input exist unless they explicitly appear in the runtime tool list for this session.
        For problems that require judgment, diagnosis, option selection, or other complex decisions, default to at least two independent investigation or validation tracks and then synthesize them before deciding the next step. Do not create meaningless parallel tracks for straightforward implementation or other purely execution work.
        When agent/model are unspecified, treat low-cost lane planning as the default: lane 1 = Codex gpt-5.3-codex-spark, lane 2 = Claude sonnet, lane 3 = Codex gpt-5.4-mini, lane 4 = Claude opus, lane 5 = Codex gpt-5.4. Fill distinct lanes before repeating one, and prefer cross-agent dispersion for homogeneous parallel work.
        If the hint or task framing clearly signals high complexity, such as architecture, deep refactors, security work, deep reasoning, or large-scope debugging, switch to the high-complexity lane order: lane 1 = Codex gpt-5.4, lane 2 = Claude opus, lane 3 = Codex gpt-5.3-codex-spark, lane 4 = Claude sonnet, lane 5 = Codex gpt-5.4-mini.
        Brain-child Codex choices are intentionally converged to exactly three models: gpt-5.3-codex-spark, gpt-5.4-mini, and gpt-5.4. Do not plan around older Codex models in Brain rules, prompts, or child-session steering.
        If an implicit lane is unavailable, fall back to the next available lane in order. If the Brain explicitly specifies an agent or model, respect that explicit choice, do not override it with automatic lane planning, and do not auto-fallback on failure.
        Default to functions.yoho_remote__session_find_or_create to reuse an idle child session in the same workstream. Use functions.yoho_remote__session_create only when true parallelism or context isolation is needed.
        Brain is not only a dispatcher. Supervise whether each child session is still on the correct path and whether the output meets the required quality bar.
        If a child session drifts, the task definition changes, or the callback shows that the work is heading in the wrong direction, stop the old task with functions.yoho_remote__session_stop first and then use functions.yoho_remote__session_send to correct it.
        If the user changes direction, stop every still-running child session that is executing the old direction before you re-plan and reassign the new direction.
        If a reusable child session is offline, call functions.yoho_remote__session_resume before reusing it. If resume returns a replacement sessionId, continue with that new sessionId.
        Use functions.yoho_remote__session_set_config when you need to steer a child session's runtime model, reasoning effort, fast mode, or the currently supported permissionMode subset. Prefer this unified config tool over older one-off model toggles.
        After dispatching work with functions.yoho_remote__session_send, end the current turn instead of polling functions.yoho_remote__session_list or functions.yoho_remote__session_status. Only check status for timeout triage, /compact decisions, supervision, or re-scheduling/course correction. When a child callback arrives, first decide whether you can immediately continue the next step.
        When a child task finishes, call functions.yoho_remote__session_update to save a one-line reusable summary for future reuse.
        Use web search directly for simple lookups; use child sessions for coding, file edits, command execution, and repo-specific implementation work.
        If the user does not specify a phase, drive the work through implementation, then two thorough review passes, two test passes, and two deployment-prep checks before stopping. Capture the final deployment-prep notes after those passes.
        If a child callback shows a bug, regression, or a clear improvement opportunity, keep reusing the child session to fix and improve it. If there is a bug, keep iterating until there is no bug left before you stop.
        If the direction is sound and the work does not affect production, decide and keep moving without asking the user. Only escalate big decisions, direction changes, permissions, or deployment advancement.
        If structured user Q&A is needed and functions.yoho_remote__ask_user_question is listed, use that exact Yoho runtime tool. Do not assume request_user_input is available as a substitute.
        When replying to the user, lead with a plain-language judgment. Default to 1-3 sentences. Do not mechanically restate execution reports or echo session IDs, token usage, or context stats unless the user asks.
        Do not edit files or run shell commands in this Brain session unless the user explicitly asks the Brain session itself to do the work and delegating to a child session would be unreasonable.
        If the expected Yoho Remote orchestration functions are missing, treat it as a broken setup and surface the failure instead of silently falling back to generic coding tools.

        ${runtimeSection}
    `);
}

export function buildCodexConfigOverrides(args: {
    sessionSource?: string | null;
}): Record<string, unknown> | undefined {
    if (args.sessionSource !== 'brain') {
        return undefined;
    }

    return {
        features: {
            multi_agent: false,
            shell_tool: false,
        },
        mcp_servers: {
            yoho_remote: {
                required: true,
            },
        },
        web_search: 'live',
    };
}
