import { z } from 'zod'

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']),
    id: z.string()
}).passthrough()

export type TodoItem = z.infer<typeof TodoItemSchema>

export const TodosSchema = z.array(TodoItemSchema)

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed'])
const TODO_PRIORITIES = new Set<TodoItem['priority']>(['high', 'medium', 'low'])

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

function extractStringCandidate(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function parseTodoStatus(value: unknown): TodoItem['status'] | null {
    return typeof value === 'string' && TODO_STATUSES.has(value as TodoItem['status'])
        ? value as TodoItem['status']
        : null
}

function parseTodoPriority(value: unknown): TodoItem['priority'] | null {
    return typeof value === 'string' && TODO_PRIORITIES.has(value as TodoItem['priority'])
        ? value as TodoItem['priority']
        : null
}

function extractTodosFromPlanEntries(entries: unknown): TodoItem[] | null {
    if (!Array.isArray(entries) || entries.length === 0) return null

    const todos: TodoItem[] = []
    entries.forEach((entry, index) => {
        if (!isObject(entry)) return

        const contentValue = extractStringCandidate(entry.step)
            ?? extractStringCandidate(entry.content)
            ?? extractStringCandidate(entry.text)
        if (!contentValue) return

        const statusValue = parseTodoStatus(entry.status) ?? 'pending'
        const priorityValue = parseTodoPriority(entry.priority) ?? 'medium'
        const idValue = extractStringCandidate(entry.id) ?? `plan-${index + 1}`

        todos.push({
            content: contentValue,
            status: statusValue,
            priority: priorityValue,
            id: idValue,
        })
    })

    const parsed = TodosSchema.safeParse(todos)
    return parsed.success && parsed.data.length > 0 ? parsed.data : null
}

function extractTodosFromClaudeOutput(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'output') return null

    const data = isObject(content.data) ? content.data : null
    if (!data) return null

    if (data.type === 'attachment') {
        const attachment = isObject(data.attachment) ? data.attachment : null
        if (!attachment || attachment.type !== 'todo_reminder') return null

        const rawItems = Array.isArray(attachment.content) ? attachment.content : []
        const todos: TodoItem[] = []

        rawItems.forEach((item, index) => {
            if (!isObject(item)) return
            const contentValue = typeof item.content === 'string' ? item.content.trim() : ''
            const statusValue = typeof item.status === 'string' ? item.status : null
            if (!contentValue) return
            if (statusValue !== 'pending' && statusValue !== 'in_progress' && statusValue !== 'completed') return

            todos.push({
                content: contentValue,
                status: statusValue,
                priority: 'medium',
                id: `claude-plan-${index + 1}`
            })
        })

        const parsed = TodosSchema.safeParse(todos)
        return parsed.success && parsed.data.length > 0 ? parsed.data : null
    }

    if (data.type !== 'assistant') return null

    const message = isObject(data.message) ? data.message : null
    if (!message) return null

    const modelContent = message.content
    if (!Array.isArray(modelContent)) return null

    for (const block of modelContent) {
        if (!isObject(block) || block.type !== 'tool_use') continue
        const name = typeof block.name === 'string' ? block.name : null
        if (name !== 'TodoWrite') continue
        const input = 'input' in block ? (block as Record<string, unknown>).input : null
        if (!isObject(input)) continue

        const todosCandidate = input.todos
        const parsed = TodosSchema.safeParse(todosCandidate)
        if (parsed.success) {
            return parsed.data
        }
    }

    return null
}

function extractTodosFromTodoWritePayload(payload: unknown): TodoItem[] | null {
    if (!isObject(payload)) return null

    const parsed = TodosSchema.safeParse(payload.todos)
    return parsed.success ? parsed.data : null
}

function extractTodosFromPlanLikePayload(payload: unknown): TodoItem[] | null {
    if (!isObject(payload)) return null

    const entries = Array.isArray(payload.plan)
        ? payload.plan
        : Array.isArray(payload.entries)
            ? payload.entries
            : null

    return extractTodosFromPlanEntries(entries)
}

function extractTodosFromCodexMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || typeof data.type !== 'string') return null

    if (data.type === 'tool-call' || data.type === 'tool-call-result') {
        const name = typeof data.name === 'string' ? data.name : null
        if (!name) return null

        const payload = data.type === 'tool-call'
            ? ('input' in data ? (data as Record<string, unknown>).input : null)
            : ('output' in data ? (data as Record<string, unknown>).output : null)

        if (name === 'TodoWrite') {
            return extractTodosFromTodoWritePayload(payload)
        }

        if (name === 'CodexPlan') {
            return extractTodosFromPlanLikePayload(payload)
        }
    }

    if (data.type === 'plan') {
        return extractTodosFromPlanLikePayload(data)
    }

    return null
}

function extractTodosFromAcpMessage(content: Record<string, unknown>): TodoItem[] | null {
    if (content.type !== 'codex') return null

    const data = isObject(content.data) ? content.data : null
    if (!data || data.type !== 'plan') return null

    return extractTodosFromPlanEntries(data.entries ?? data.plan)
}

export function extractTodoWriteTodosFromMessageContent(messageContent: unknown): TodoItem[] | null {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (!record) return null

    if (record.role !== 'agent' && record.role !== 'assistant') return null

    if (!isObject(record.content) || typeof record.content.type !== 'string') return null

    return extractTodosFromClaudeOutput(record.content)
        ?? extractTodosFromCodexMessage(record.content)
        ?? extractTodosFromAcpMessage(record.content)
}
