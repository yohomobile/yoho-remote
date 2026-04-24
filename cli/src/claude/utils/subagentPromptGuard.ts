import { trimIdent } from "@/utils/trimIdent";

export const SUBAGENT_PROMPT_GUARD_MARKER = '<yoho-remote-subagent-constraints>';

export const SUBAGENT_PROMPT_GUARD = trimIdent(`
    ${SUBAGENT_PROMPT_GUARD_MARKER}
    You are a subagent running inside another Claude session.
    - Do NOT use Agent, Task, or ExitPlanMode in this context.
    - Only use tools that are actually available in this session.
    - Complete the task and return findings to the orchestrator instead of trying to exit plan mode or spawning more agents.
`);

export const SUBAGENT_PROMPT_INJECTION_INSTRUCTION = trimIdent(`
    When you call Agent or Task, prepend the subagent prompt with exactly this block and then your task-specific instructions:

    ${SUBAGENT_PROMPT_GUARD}

    Do not rely on the platform to inject those constraints for you.
    In the task-specific instructions, also tell the subagent not to assume Edit, Write, Bash, Read, Grep, or Glob are available unless that subagent session explicitly lists them.
`);
