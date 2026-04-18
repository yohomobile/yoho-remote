import type { NormalizedMessage } from '@/chat/types'

export type TracedMessage = NormalizedMessage & {
    sidechainId?: string
}

type TracerState = {
    promptToTaskId: Map<string, string>
    toolUseIdToTaskId: Map<string, string>
    messageUuidToTaskId: Map<string, string>
    uuidToSidechainId: Map<string, string>
    orphanMessages: Map<string, NormalizedMessage[]>
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function getMessageUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const first = message.content[0] as unknown as Record<string, unknown>
        return typeof first.uuid === 'string' ? first.uuid : null
    }
    return null
}

function getParentUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const first = message.content[0] as unknown as Record<string, unknown>
        return typeof first.parentUUID === 'string' ? first.parentUUID : null
    }
    return null
}

function processOrphans(state: TracerState, parentUuid: string, sidechainId: string): TracedMessage[] {
    const results: TracedMessage[] = []
    const orphans = state.orphanMessages.get(parentUuid)
    if (!orphans) return results
    state.orphanMessages.delete(parentUuid)

    for (const orphan of orphans) {
        const uuid = getMessageUuid(orphan)
        if (uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId)
        }

        results.push({ ...orphan, sidechainId })

        if (uuid) {
            results.push(...processOrphans(state, uuid, sidechainId))
        }
    }

    return results
}

function resolveSidechainId(
    message: NormalizedMessage,
    state: TracerState,
    parentUuid: string | null
): string | undefined {
    let promptFallback: string | undefined

    if (message.role !== 'agent') {
        return undefined
    }

    for (const content of message.content) {
        if (content.type === 'tool-call') {
            const taskId = state.toolUseIdToTaskId.get(content.id)
            if (taskId) {
                return taskId
            }
        }

        if (content.type === 'tool-result') {
            const taskId = state.toolUseIdToTaskId.get(content.tool_use_id)
            if (taskId) {
                return taskId
            }
        }

        if (content.type === 'sidechain') {
            const taskId = state.messageUuidToTaskId.get(content.uuid)
            if (taskId) {
                return taskId
            }

            const promptTaskId = state.promptToTaskId.get(content.prompt)
            if (promptTaskId) {
                return promptTaskId
            }

            promptFallback ??= content.prompt
        }

        if (content.type === 'text' && !parentUuid) {
            promptFallback ??= content.text
        }
    }

    if (parentUuid) {
        const parentSidechainId = state.uuidToSidechainId.get(parentUuid)
        if (parentSidechainId) {
            return parentSidechainId
        }

        const parentTaskId = state.messageUuidToTaskId.get(parentUuid)
        if (parentTaskId) {
            return parentTaskId
        }
    }

    if (promptFallback) {
        return state.promptToTaskId.get(promptFallback)
    }

    return undefined
}

export function traceMessages(messages: NormalizedMessage[]): TracedMessage[] {
    const state: TracerState = {
        promptToTaskId: new Map(),
        toolUseIdToTaskId: new Map(),
        messageUuidToTaskId: new Map(),
        uuidToSidechainId: new Map(),
        orphanMessages: new Map()
    }

    const results: TracedMessage[] = []

    // Index Task prompts (including those inside sidechains).
    for (const message of messages) {
        if (message.role !== 'agent') continue
        const uuid = getMessageUuid(message)
        let hasTaskToolCall = false
        for (const content of message.content) {
            if (content.type !== 'tool-call' || (content.name !== 'Task' && content.name !== 'Agent')) continue
            if (!state.toolUseIdToTaskId.has(content.id)) {
                state.toolUseIdToTaskId.set(content.id, message.id)
            }
            hasTaskToolCall = true
            const input = content.input
            if (isObject(input) && typeof input.prompt === 'string') {
                if (!state.promptToTaskId.has(input.prompt)) {
                    state.promptToTaskId.set(input.prompt, message.id)
                }
            }
        }
        if (hasTaskToolCall && uuid) {
            if (!state.messageUuidToTaskId.has(uuid)) {
                state.messageUuidToTaskId.set(uuid, message.id)
            }
        }
    }

    for (const message of messages) {
        if (!message.isSidechain) {
            results.push({ ...message })
            continue
        }

        const parentUuid = getParentUuid(message)
        const uuid = getMessageUuid(message)
        const sidechainId = resolveSidechainId(message, state, parentUuid)

        if (sidechainId && uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId)
            results.push({ ...message, sidechainId })
            results.push(...processOrphans(state, uuid, sidechainId))
            continue
        }

        if (parentUuid) {
            const parentSidechainId = state.uuidToSidechainId.get(parentUuid)
            if (parentSidechainId) {
                if (uuid) {
                    state.uuidToSidechainId.set(uuid, parentSidechainId)
                }
                results.push({ ...message, sidechainId: parentSidechainId })
                if (uuid) {
                    results.push(...processOrphans(state, uuid, parentSidechainId))
                }
            } else {
                const orphans = state.orphanMessages.get(parentUuid) ?? []
                orphans.push(message)
                state.orphanMessages.set(parentUuid, orphans)
            }
            continue
        }

        results.push({ ...message })
    }

    return results
}
