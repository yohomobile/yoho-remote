import { Hono } from 'hono'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { configuration, getConfiguration } from '../../configuration'
import { safeCompareStrings } from '../../utils/crypto'
import { parseAccessToken } from '../../utils/accessToken'
import type { Machine, Session, SendMessageOutcome, SyncEngine } from '../../sync/syncEngine'
import type { SSEManager } from '../../sse/sseManager'
import { serializeMachine, sortMachinesForDisplay } from './machinePayload'
import { getLicenseService } from '../../license/licenseService'
import { buildInitPrompt } from '../prompts/initPrompt'
import { buildSessionContextBundle, renderSessionContextBundlePrompt } from '../prompts/contextBundle'
import {
    buildResumeContextMessage,
    RESUME_CONTEXT_MAX_LINES,
    RESUME_TIMEOUT_MS,
    resolveSpawnTarget,
    waitForSessionOnline,
} from './sessions'
import {
    extractResumeSpawnExtras,
    extractResumeSpawnMetadata,
    getInvalidResumeMetadataReason,
    resolveResumeTokenSourceSpawnOptions,
} from '../../resumeSpawnMetadata'
import {
    getAllowedBrainChildAgents,
    parseBrainSessionPreferences,
    resolveBrainSpawnPermissionMode,
} from '../../brain/brainSessionPreferences'
import { SESSION_PERMISSION_MODE_VALUES, normalizeSessionPermissionMode } from '../../sessionPermissionMode'
import { getLocalTokenSourceEnabledForOrg, resolveTokenSourceForAgent } from '../tokenSources'
import { validatePermissionModeForSessionFlavor } from './sessionConfigPolicy'
import {
    getSessionMetadataPersistenceError,
    getUnsupportedSessionSourceError,
    getSessionSourceFromMetadata,
    isSupportedSessionSource,
    normalizeSessionMetadataInvariants,
} from '../../sessionSourcePolicy'
import {
    getSessionOrchestrationParentSessionId,
    getSessionOrchestrationParentSourceForChildSource,
    isSessionOrchestrationChildForParentMetadata,
    isSessionOrchestrationChildSource,
    isSessionOrchestrationParentMetadata,
    isSessionOrchestrationParentSource,
} from '../../sessionOrchestrationPolicy'
import {
    aiTaskScheduleCancelSchema,
    aiTaskScheduleCreateSchema,
    aiTaskScheduleListSchema,
    parseCronOrDelay,
    serializeAiTaskScheduleRow,
} from './aiTaskScheduleShared'

/** Derive a PascalCase project name from an absolute path's basename. e.g. "yoho-remote" → "YohoRemote" */
function toPascalCase(path: string): string {
    return basename(path)
        .split(/[-_]+/)
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
        .join('')
}

const bearerSchema = z.string().regex(/^Bearer\s+(.+)$/i)

const createOrLoadSessionSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional()
})

const createOrLoadMachineSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    daemonState: z.unknown().nullable().optional()
})

const cliSendMessageSchema = z.object({
    text: z.string().min(1),
    sentFrom: z.string().optional(),
    localId: z.string().min(1).optional(),
})

type SessionSendResponse =
    | {
        ok: true
        status: 'delivered'
        sessionId: string
    }
    | {
        ok: true
        status: 'queued'
        sessionId: string
        queue: 'brain-child-init' | 'brain-session-inbox'
        queueDepth: number
    }
    | {
        ok: false
        status: 'busy' | 'offline' | 'not_found' | 'access_denied'
        sessionId: string
        retryable: boolean
        resumeRequired?: boolean
        error?: string
    }

const getMessagesQuerySchema = z.object({
    afterSeq: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional()
})

const brainChildScopeQuerySchema = z.object({
    mainSessionId: z.string().trim().min(1),
})

const optionalBrainChildScopeQuerySchema = z.object({
    mainSessionId: z.string().trim().min(1).optional(),
})

const booleanQuerySchema = z.union([z.literal('true'), z.literal('false')]).transform((value) => value === 'true')

const listSessionsQuerySchema = z.object({
    includeOffline: booleanQuerySchema.optional(),
    mainSessionId: z.string().trim().min(1).optional(),
})

const tailQuerySchema = z.object({
    mainSessionId: z.string().trim().min(1),
    limit: z.coerce.number().int().min(1).max(20).optional()
})

const sessionSearchQuerySchema = z.object({
    query: z.string().trim().min(1),
    limit: z.coerce.number().int().min(1).max(10).optional(),
    includeOffline: booleanQuerySchema.optional(),
    mainSessionId: z.string().trim().min(1).optional(),
    directory: z.string().trim().min(1).optional(),
    flavor: z.enum(['claude', 'codex']).optional(),
    source: z.string().trim().min(1).optional(),
})

const brainSpawnSchema = z.object({
    machineId: z.string().min(1),
    directory: z.string().min(1),
    agent: z.enum(['claude', 'codex']).default('claude'),
    modelMode: z.enum(['default', 'sonnet', 'opus', 'opus-4-7']).optional(),
    codexModel: z.string().min(1).optional(),
    source: z.string().default('brain-child'),
    mainSessionId: z.string().min(1).optional(),
    caller: z.string().min(1).optional(),
    brainPreferences: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
    if (isSessionOrchestrationChildSource(data.source) && !data.mainSessionId) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['mainSessionId'],
            message: getMainSessionIdRequiredErrorForChildSource(data.source),
        })
    }
})


type CliEnv = {
    Variables: {
        orgId: string
    }
}

const cliSessionConfigSchema = z.object({
    permissionMode: z.enum(SESSION_PERMISSION_MODE_VALUES).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    fastMode: z.boolean().optional(),
}).refine((value) =>
    value.permissionMode !== undefined
    || value.model !== undefined
    || value.reasoningEffort !== undefined
    || value.fastMode !== undefined,
{
    message: 'At least one config field is required',
})

type BrainSessionInspectPayload = {
    sessionId: string
    status: 'offline' | 'running' | 'idle'
    active: boolean
    thinking: boolean
    initDone: boolean
    activeAt: number
    updatedAt: number
    thinkingAt: number | null
    lastMessageAt: number | null
    messageCount: number
    pendingRequestsCount: number
    pendingRequests: Array<{
        id: string
        tool: string
        createdAt: number | null
    }>
    permissionMode?: Session['permissionMode']
    modelMode?: Session['modelMode']
    modelReasoningEffort?: Session['modelReasoningEffort']
    runtimeAgent: string | null
    runtimeModel: string | null
    runtimeModelReasoningEffort: string | null
    fastMode: boolean | null
    todoProgress: { completed: number; total: number } | null
    todos: Session['todos'] | null
    activeMonitors: Session['activeMonitors']
    terminationReason: string | null
    lastUsage: {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens?: number
        cache_creation_input_tokens?: number
        contextSize: number
    } | null
    contextWindow: {
        budgetTokens: number
        usedTokens: number
        remainingTokens: number
        remainingPercent: number
    } | null
    metadata: {
        path: string | null
        summary: { text: string; updatedAt: number } | null
        brainSummary: string | null
        source: string | null
        caller: string | null
        machineId: string | null
        flavor: string | null
        mainSessionId: string | null
        selfSystemEnabled: boolean | null
        selfProfileId: string | null
        selfProfileName: string | null
        selfProfileResolved: boolean | null
        selfMemoryProvider: 'yoho-memory' | 'none' | null
        selfMemoryAttached: boolean | null
        selfMemoryStatus: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error' | null
    }
}

type BrainSessionTailItem = {
    seq: number
    createdAt: number
    role: 'user' | 'assistant' | 'agent'
    kind: 'user' | 'assistant' | 'result' | 'tool-call' | 'tool-result' | 'tool-summary' | 'todo' | 'plan' | 'reasoning' | 'system' | 'message' | 'raw'
    subtype: string | null
    sentFrom: string | null
    snippet: string
}

type BrainSessionSearchPayload = {
    query: string
    returned: number
    results: Array<{
        sessionId: string
        score: number
        active: boolean
        thinking: boolean
        activeAt: number | null
        updatedAt: number
        lastMessageAt: number | null
        pendingRequestsCount: number
        permissionMode: string | null
        modelMode: string | null
        modelReasoningEffort: string | null
        fastMode: boolean | null
        metadata: {
            path: string | null
            summary: { text: string; updatedAt: number } | null
            brainSummary: string | null
            source: string | null
            caller: string | null
            machineId: string | null
            flavor: string | null
            mainSessionId: string | null
            selfSystemEnabled: boolean | null
            selfProfileId: string | null
            selfProfileName: string | null
            selfProfileResolved: boolean | null
            selfMemoryProvider: 'yoho-memory' | 'none' | null
            selfMemoryAttached: boolean | null
            selfMemoryStatus: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error' | null
        }
        match: {
            source: 'turn-summary' | 'brain-summary' | 'title' | 'path'
            text: string
            createdAt: number | null
            seqStart: number | null
            seqEnd: number | null
        }
    }>
}

type SpawnLogLike = {
    timestamp: number
    step: string
    message: string
    status: string
}

type SpawnPerfSummary = {
    daemonTotalMs: number | null
    daemonPrepMs: number | null
    daemonCliSpawnMs: number | null
    daemonWebhookMs: number | null
}

function getContextBudget(modelMode?: string): number {
    const HEADROOM = 10_000
    const windows: Record<string, number> = {
        default: 1_000_000,
        sonnet: 1_000_000,
        opus: 1_000_000,
        'gpt-5.4': 1_047_576,
        'gpt-5.4-mini': 1_047_576,
        'gpt-5.3-codex': 524_288,
        'gpt-5.3-codex-spark': 524_288,
    }
    return (windows[modelMode ?? 'default'] ?? 1_000_000) - HEADROOM
}

function getSelfSystemInspectMetadata(metadata: Record<string, unknown> | null | undefined): {
    selfSystemEnabled: boolean | null
    selfProfileId: string | null
    selfProfileName: string | null
    selfProfileResolved: boolean | null
    selfMemoryProvider: 'yoho-memory' | 'none' | null
    selfMemoryAttached: boolean | null
    selfMemoryStatus: 'disabled' | 'skipped' | 'attached' | 'empty' | 'error' | null
} {
    return {
        selfSystemEnabled: metadata?.selfSystemEnabled === true ? true : metadata?.selfSystemEnabled === false ? false : null,
        selfProfileId: asNonEmptyString(metadata?.selfProfileId) ?? null,
        selfProfileName: asNonEmptyString(metadata?.selfProfileName) ?? null,
        selfProfileResolved: metadata?.selfProfileResolved === true ? true : metadata?.selfProfileResolved === false ? false : null,
        selfMemoryProvider: metadata?.selfMemoryProvider === 'none'
            ? 'none'
            : metadata?.selfMemoryProvider === 'yoho-memory'
                ? 'yoho-memory'
                : null,
        selfMemoryAttached: metadata?.selfMemoryAttached === true ? true : metadata?.selfMemoryAttached === false ? false : null,
        selfMemoryStatus: metadata?.selfMemoryStatus === 'disabled'
            || metadata?.selfMemoryStatus === 'skipped'
            || metadata?.selfMemoryStatus === 'attached'
            || metadata?.selfMemoryStatus === 'empty'
            || metadata?.selfMemoryStatus === 'error'
            ? metadata.selfMemoryStatus
            : null,
    }
}

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }
    return { ...(value as Record<string, unknown>) }
}

function asSpawnLogs(value: unknown): SpawnLogLike[] {
    if (!Array.isArray(value)) {
        return []
    }
    return value.flatMap((item) => {
        const entry = asRecord(item)
        if (!entry) {
            return []
        }
        const timestamp = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
            ? entry.timestamp
            : null
        const step = asNonEmptyString(entry.step) ?? null
        const message = asNonEmptyString(entry.message) ?? null
        const status = asNonEmptyString(entry.status) ?? null
        if (timestamp === null || !step || !message || !status) {
            return []
        }
        return [{ timestamp, step, message, status }]
    })
}

function summarizeSpawnLogs(value: unknown): SpawnPerfSummary {
    const logs = asSpawnLogs(value)
    if (logs.length === 0) {
        return {
            daemonTotalMs: null,
            daemonPrepMs: null,
            daemonCliSpawnMs: null,
            daemonWebhookMs: null,
        }
    }

    const first = logs[0]
    const last = logs[logs.length - 1]
    const spawnStart = logs.find((entry) => entry.step === 'spawn' && entry.status === 'running')
    const spawnEnd = logs.find((entry) => entry.step === 'spawn' && entry.status !== 'running')
    const webhookStart = logs.find((entry) => entry.step === 'webhook' && entry.status === 'running')
    const webhookEnd = logs.find((entry) => entry.step === 'webhook' && entry.status !== 'running')

    return {
        daemonTotalMs: Math.max(0, last.timestamp - first.timestamp),
        daemonPrepMs: spawnStart ? Math.max(0, spawnStart.timestamp - first.timestamp) : null,
        daemonCliSpawnMs: spawnStart && spawnEnd ? Math.max(0, spawnEnd.timestamp - spawnStart.timestamp) : null,
        daemonWebhookMs: webhookStart && webhookEnd ? Math.max(0, webhookEnd.timestamp - webhookStart.timestamp) : null,
    }
}

function formatPerfMs(value: number | null): string {
    return value === null ? 'n/a' : `${value}ms`
}

function clipText(value: string, maxChars: number = 600): string {
    const normalized = value.replace(/\r\n?/g, '\n').trim()
    if (normalized.length <= maxChars) {
        return normalized
    }
    return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

function stringifyPreview(value: unknown, maxChars: number = 220): string | null {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        return trimmed ? clipText(trimmed, maxChars) : null
    }
    try {
        return clipText(JSON.stringify(value), maxChars)
    } catch {
        return null
    }
}

function getMessageSentFrom(content: unknown): string | null {
    const record = asRecord(content)
    const meta = asRecord(record?.meta)
    return asNonEmptyString(meta?.sentFrom) ?? null
}

function summarizeTodoProgress(todos: Session['todos'] | undefined): { completed: number; total: number } | null {
    if (!todos?.length) {
        return null
    }
    return {
        completed: todos.filter((todo) => todo.status === 'completed').length,
        total: todos.length,
    }
}

function summarizePendingRequests(agentState: Session['agentState'] | null | undefined): Array<{ id: string; tool: string; createdAt: number | null }> {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    return Object.entries(requests).map(([id, request]) => ({
        id,
        tool: request.tool,
        createdAt: typeof request.createdAt === 'number' ? request.createdAt : null,
    }))
}

function extractAssistantTextBlocks(value: unknown): string | null {
    if (!Array.isArray(value)) {
        return null
    }
    const texts = value
        .map((item) => {
            const record = asRecord(item)
            if (record?.type === 'text') {
                return asNonEmptyString(record.text) ?? null
            }
            return null
        })
        .filter((text): text is string => Boolean(text))

    if (texts.length === 0) {
        return null
    }
    return texts.join('\n')
}

function summarizeToolUseBlocks(value: unknown): string | null {
    if (!Array.isArray(value)) {
        return null
    }

    const parts = value
        .map((item) => {
            const record = asRecord(item)
            if (!record) {
                return null
            }
            if (record.type !== 'tool_use' && record.type !== 'server_tool_use') {
                return null
            }
            const name = asNonEmptyString(record.name)
            if (!name) {
                return null
            }
            const input = asRecord(record.input)
            const command = asNonEmptyString(input?.command)
            if (command) {
                return `${name}: ${command}`
            }
            const todos = Array.isArray(input?.todos) ? input.todos.length : null
            if (todos !== null) {
                return `${name}: ${todos} todos`
            }
            const path = asNonEmptyString(input?.path) ?? asNonEmptyString(input?.file_path)
            if (path) {
                return `${name}: ${path}`
            }
            return name
        })
        .filter((part): part is string => Boolean(part))

    if (parts.length === 0) {
        return null
    }

    return `工具调用：${parts.join(' | ')}`
}

function summarizeToolResultBlocks(value: unknown): string | null {
    if (!Array.isArray(value)) {
        return null
    }

    const parts = value
        .map((item) => {
            const record = asRecord(item)
            if (!record || record.type !== 'tool_result') {
                return null
            }
            const prefix = Boolean(record.is_error) ? '工具结果错误' : '工具结果'
            const contentPreview = stringifyPreview(record.content)
            const toolUseId = asNonEmptyString(record.tool_use_id)
            if (contentPreview) {
                return toolUseId
                    ? `${prefix}(${toolUseId}): ${contentPreview}`
                    : `${prefix}: ${contentPreview}`
            }
            return toolUseId ? `${prefix}(${toolUseId})` : prefix
        })
        .filter((part): part is string => Boolean(part))

    if (parts.length === 0) {
        return null
    }

    return parts.join('\n')
}

function extractTodoReminderSummary(content: unknown): string | null {
    if (!Array.isArray(content)) {
        return null
    }

    const lines = content
        .map((item) => {
            const record = asRecord(item)
            const text = asNonEmptyString(record?.content)
            const status = asNonEmptyString(record?.status) ?? 'pending'
            return text ? `- [${status}] ${text}` : null
        })
        .filter((line): line is string => Boolean(line))

    if (lines.length === 0) {
        return null
    }
    return `当前待办：\n${lines.join('\n')}`
}

function extractAttachmentSummary(dataRecord: Record<string, unknown>): { kind: BrainSessionTailItem['kind']; subtype: string | null; snippet: string } | null {
    if (dataRecord.type !== 'attachment') {
        return null
    }

    const attachment = asRecord(dataRecord.attachment)
    const attachmentType = asNonEmptyString(attachment?.type) ?? null
    if (!attachment || !attachmentType) {
        return null
    }

    if (attachmentType === 'todo_reminder') {
        const snippet = extractTodoReminderSummary(attachment.content)
        return snippet ? { kind: 'todo', subtype: attachmentType, snippet } : null
    }

    if (attachmentType === 'plan_mode') {
        const planFilePath = asNonEmptyString(attachment.planFilePath)
        return {
            kind: 'plan',
            subtype: attachmentType,
            snippet: planFilePath ? `当前处于计划模式（计划文件：${planFilePath}）` : '当前处于计划模式',
        }
    }

    if (attachmentType === 'plan_file_reference') {
        const planFilePath = asNonEmptyString(attachment.planFilePath)
        const planContent = asNonEmptyString(attachment.planContent)
        if (planContent) {
            return {
                kind: 'plan',
                subtype: attachmentType,
                snippet: planFilePath ? `当前计划文件（${planFilePath}）：\n${planContent}` : `当前计划文件：\n${planContent}`,
            }
        }
        if (planFilePath) {
            return {
                kind: 'plan',
                subtype: attachmentType,
                snippet: `当前计划文件：${planFilePath}`,
            }
        }
        return null
    }

    if (attachmentType === 'queued_command') {
        const prompt = asNonEmptyString(attachment.prompt)
        if (!prompt) {
            return null
        }
        return {
            kind: 'system',
            subtype: attachmentType,
            snippet: attachment.commandMode === 'prompt' ? `排队命令：${prompt}` : prompt,
        }
    }

    if (attachmentType === 'edited_text_file') {
        const filename = asNonEmptyString(attachment.filename)
        const snippet = asNonEmptyString(attachment.snippet)
        if (!filename || !snippet) {
            return null
        }
        return {
            kind: 'tool-result',
            subtype: attachmentType,
            snippet: `已编辑文件 ${filename}：\n${snippet}`,
        }
    }

    return null
}

function extractTailItem(content: unknown): Omit<BrainSessionTailItem, 'seq' | 'createdAt'> | null {
    const record = asRecord(content)
    if (!record) {
        return null
    }

    const role = asNonEmptyString(record.role)
    if (role === 'user') {
        const body = record.content
        if (typeof body === 'string') {
            return {
                role: 'user',
                kind: 'user',
                subtype: 'text',
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(body),
            }
        }
        const bodyRecord = asRecord(body)
        if (bodyRecord?.type === 'text') {
            const text = asNonEmptyString(bodyRecord.text)
            if (!text) {
                return null
            }
            return {
                role: 'user',
                kind: 'user',
                subtype: 'text',
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(text),
            }
        }
    }

    if (role === 'assistant') {
        const body = asRecord(record.content)
        const text = asNonEmptyString(body?.text) ?? (typeof record.content === 'string' ? asNonEmptyString(record.content) : undefined)
        if (!text) {
            return null
        }
        return {
            role: 'assistant',
            kind: 'assistant',
            subtype: body?.type === 'text' ? 'text' : null,
            sentFrom: getMessageSentFrom(content),
            snippet: clipText(text),
        }
    }

    if (role !== 'agent') {
        return null
    }

    const payload = asRecord(record.content)
    if (!payload) {
        return null
    }

    if (payload.type === 'codex') {
        const data = asRecord(payload.data)
        const dataType = asNonEmptyString(data?.type)
        if (!data || !dataType) {
            return null
        }

        if (dataType === 'message') {
            const message = asNonEmptyString(data.message)
            return message ? {
                role: 'agent',
                kind: 'message',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(message),
            } : null
        }

        if (dataType === 'reasoning') {
            const message = asNonEmptyString(data.message)
            return message ? {
                role: 'agent',
                kind: 'reasoning',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(message),
            } : null
        }

        if (dataType === 'tool-call') {
            const name = asNonEmptyString(data.name) ?? 'unknown'
            const inputPreview = stringifyPreview(data.input)
            return {
                role: 'agent',
                kind: 'tool-call',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(inputPreview ? `工具调用 ${name}: ${inputPreview}` : `工具调用 ${name}`),
            }
        }

        if (dataType === 'tool-call-result') {
            const outputPreview = stringifyPreview(data.output)
            if (!outputPreview) {
                return null
            }
            return {
                role: 'agent',
                kind: 'tool-result',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(`工具结果: ${outputPreview}`),
            }
        }

        return null
    }

    if (payload.type === 'event') {
        const event = asNonEmptyString(payload.event)
        return event ? {
            role: 'agent',
            kind: 'system',
            subtype: 'event',
            sentFrom: getMessageSentFrom(content),
            snippet: `事件：${event}`,
        } : null
    }

    if (payload.type !== 'output') {
        return null
    }

    const data = payload.data
    if (typeof data === 'string') {
        const text = asNonEmptyString(data)
        return text ? {
            role: 'agent',
            kind: 'message',
            subtype: 'raw-string',
            sentFrom: getMessageSentFrom(content),
            snippet: clipText(text),
        } : null
    }

    const dataRecord = asRecord(data)
    const dataType = asNonEmptyString(dataRecord?.type) ?? null
    if (!dataRecord || !dataType) {
        return null
    }

    if (dataType === 'result') {
        const resultText = asNonEmptyString(dataRecord.result)
        return resultText ? {
            role: 'agent',
            kind: 'result',
            subtype: dataType,
            sentFrom: getMessageSentFrom(content),
            snippet: clipText(resultText),
        } : null
    }

    if (dataType === 'tool_use_summary') {
        const summary = asNonEmptyString(dataRecord.summary)
        return summary ? {
            role: 'agent',
            kind: 'tool-summary',
            subtype: dataType,
            sentFrom: getMessageSentFrom(content),
            snippet: clipText(summary),
        } : null
    }

    if (dataType === 'message') {
        const message = asNonEmptyString(dataRecord.message)
        return message ? {
            role: 'agent',
            kind: 'message',
            subtype: dataType,
            sentFrom: getMessageSentFrom(content),
            snippet: clipText(message),
        } : null
    }

    if (dataType === 'assistant') {
        const message = asRecord(dataRecord.message)
        const blockText = extractAssistantTextBlocks(message?.content)
        if (blockText) {
            return {
                role: 'agent',
                kind: 'assistant',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(blockText),
            }
        }
        const toolSummary = summarizeToolUseBlocks(message?.content)
        if (toolSummary) {
            return {
                role: 'agent',
                kind: 'tool-call',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(toolSummary),
            }
        }
        return null
    }

    if (dataType === 'user') {
        const message = asRecord(dataRecord.message)
        const toolResultSummary = summarizeToolResultBlocks(message?.content)
        if (toolResultSummary) {
            return {
                role: 'agent',
                kind: 'tool-result',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(toolResultSummary),
            }
        }
        const blockText = extractAssistantTextBlocks(message?.content)
        if (blockText) {
            return {
                role: 'agent',
                kind: 'user',
                subtype: dataType,
                sentFrom: getMessageSentFrom(content),
                snippet: clipText(blockText),
            }
        }
        return null
    }

    if (dataType === 'system') {
        const subtype = asNonEmptyString(dataRecord.subtype) ?? 'system'
        const toolUseId = asNonEmptyString(dataRecord.tool_use_id)
        const status = asNonEmptyString(dataRecord.status)
        const taskId = asNonEmptyString(dataRecord.task_id)
        const parts = [subtype]
        if (status) parts.push(`status=${status}`)
        if (taskId) parts.push(`taskId=${taskId}`)
        if (toolUseId) parts.push(`toolUseId=${toolUseId}`)
        return {
            role: 'agent',
            kind: 'system',
            subtype,
            sentFrom: getMessageSentFrom(content),
            snippet: `系统事件：${parts.join(' ')}`,
        }
    }

    const attachmentSummary = extractAttachmentSummary(dataRecord)
    if (attachmentSummary) {
        return {
            role: 'agent',
            kind: attachmentSummary.kind,
            subtype: attachmentSummary.subtype,
            sentFrom: getMessageSentFrom(content),
            snippet: clipText(attachmentSummary.snippet),
        }
    }

    const rawPreview = stringifyPreview(dataRecord)
    if (!rawPreview) {
        return null
    }

    return {
        role: 'agent',
        kind: 'raw',
        subtype: dataType,
        sentFrom: getMessageSentFrom(content),
        snippet: clipText(rawPreview),
    }
}

async function buildBrainSessionInspectPayload(engine: SyncEngine, session: Session): Promise<BrainSessionInspectPayload> {
    const messageCount = await engine.getMessageCount(session.id)
    const lastUsage = await engine.getLastUsageForSession(session.id)
    const pendingRequests = summarizePendingRequests(session.agentState)
    const contextBudget = lastUsage ? getContextBudget(session.modelMode) : null
    const contextWindow = lastUsage && contextBudget
        ? {
            budgetTokens: contextBudget,
            usedTokens: lastUsage.contextSize,
            remainingTokens: Math.max(0, contextBudget - lastUsage.contextSize),
            remainingPercent: Math.max(0, Math.round((1 - lastUsage.contextSize / contextBudget) * 100)),
        }
        : null
    const metadataRecord = asRecord(session.metadata)

    return {
        sessionId: session.id,
        status: !session.active ? 'offline' : session.thinking ? 'running' : 'idle',
        active: session.active,
        thinking: session.thinking ?? false,
        initDone: engine.isBrainChildInitDone(session.id),
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        thinkingAt: typeof session.thinkingAt === 'number' ? session.thinkingAt : null,
        lastMessageAt: session.lastMessageAt,
        messageCount,
        pendingRequestsCount: pendingRequests.length,
        pendingRequests,
        permissionMode: normalizeSessionPermissionMode({
            flavor: session.metadata?.flavor,
            permissionMode: session.permissionMode,
            metadata: session.metadata,
        }),
        modelMode: session.modelMode,
        modelReasoningEffort: session.modelReasoningEffort,
        runtimeAgent: asNonEmptyString(session.metadata?.runtimeAgent) ?? asNonEmptyString(session.metadata?.flavor) ?? null,
        runtimeModel: asNonEmptyString(session.metadata?.runtimeModel) ?? null,
        runtimeModelReasoningEffort: asNonEmptyString(session.metadata?.runtimeModelReasoningEffort) ?? null,
        fastMode: typeof session.fastMode === 'boolean' ? session.fastMode : null,
        todoProgress: summarizeTodoProgress(session.todos),
        todos: session.todos ?? null,
        activeMonitors: session.activeMonitors,
        terminationReason: session.terminationReason ?? null,
        lastUsage,
        contextWindow,
        metadata: {
            path: asNonEmptyString(session.metadata?.path) ?? null,
            summary: session.metadata?.summary ?? null,
            brainSummary: asNonEmptyString(metadataRecord?.brainSummary) ?? null,
            source: asNonEmptyString(session.metadata?.source) ?? null,
            caller: asNonEmptyString(metadataRecord?.caller) ?? null,
            machineId: asNonEmptyString(session.metadata?.machineId) ?? null,
            flavor: asNonEmptyString(session.metadata?.flavor) ?? null,
            mainSessionId: getSessionOrchestrationParentSessionId(metadataRecord) ?? null,
            ...getSelfSystemInspectMetadata(metadataRecord),
        },
    }
}

function buildBrainSessionSearchPayload(args: {
    storedResults: Array<{
        session: {
            id: string
            active: boolean
            thinking: boolean
            activeAt: number | null
            updatedAt: number
            lastMessageAt: number | null
            permissionMode: string | null
            modelMode: string | null
            modelReasoningEffort: string | null
            fastMode: boolean | null
            metadata: unknown | null
        }
        score: number
        match: {
            source: 'turn-summary' | 'brain-summary' | 'title' | 'path'
            text: string
            createdAt: number | null
            seqStart: number | null
            seqEnd: number | null
        }
    }>
    engine: SyncEngine | null
    orgId: string
    query: string
}): BrainSessionSearchPayload {
    return {
        query: args.query,
        returned: args.storedResults.length,
        results: args.storedResults.map((item) => {
            const memorySession = args.engine
                ? (typeof args.engine.getSessionByOrg === 'function'
                    ? args.engine.getSessionByOrg(item.session.id, args.orgId)
                    : args.engine.getSessionByNamespace(item.session.id, args.orgId))
                : undefined
            const metadata = asRecord(memorySession?.metadata ?? item.session.metadata)
            const summaryRecord = asRecord(metadata?.summary)
            const requests = memorySession?.agentState?.requests

            return {
                sessionId: item.session.id,
                score: item.score,
                active: memorySession?.active ?? item.session.active,
                thinking: memorySession?.thinking ?? item.session.thinking,
                activeAt: memorySession?.activeAt ?? item.session.activeAt,
                updatedAt: memorySession?.updatedAt ?? item.session.updatedAt,
                lastMessageAt: memorySession?.lastMessageAt ?? item.session.lastMessageAt,
                pendingRequestsCount: requests ? Object.keys(requests).length : 0,
                permissionMode: normalizeSessionPermissionMode({
                    flavor: metadata?.flavor,
                    permissionMode: memorySession?.permissionMode ?? item.session.permissionMode,
                    metadata,
                }) ?? null,
                modelMode: memorySession?.modelMode ?? item.session.modelMode ?? null,
                modelReasoningEffort: memorySession?.modelReasoningEffort ?? item.session.modelReasoningEffort ?? null,
                fastMode: memorySession?.fastMode ?? item.session.fastMode ?? null,
                metadata: {
                    path: asNonEmptyString(metadata?.path) ?? null,
                    summary: summaryRecord && typeof summaryRecord.text === 'string'
                        ? {
                            text: summaryRecord.text,
                            updatedAt: typeof summaryRecord.updatedAt === 'number' ? summaryRecord.updatedAt : 0,
                        }
                        : null,
                    brainSummary: asNonEmptyString(metadata?.brainSummary) ?? null,
                    source: asNonEmptyString(metadata?.source) ?? null,
                    caller: asNonEmptyString(metadata?.caller) ?? null,
                    machineId: asNonEmptyString(metadata?.machineId) ?? null,
                    flavor: asNonEmptyString(metadata?.flavor) ?? null,
                    mainSessionId: getSessionOrchestrationParentSessionId(metadata) ?? null,
                    ...getSelfSystemInspectMetadata(metadata),
                },
                match: {
                    source: item.match.source,
                    text: clipText(item.match.text, 280),
                    createdAt: item.match.createdAt,
                    seqStart: item.match.seqStart,
                    seqEnd: item.match.seqEnd,
                },
            }
        }),
    }
}

async function checkCliSessionLicense(c: { json: (data: any, status: number) => any }, orgId: string | null | undefined): Promise<Response | null> {
    if (!orgId) return null
    try {
        const licenseService = getLicenseService()
        const licenseCheck = await licenseService.canCreateSession(orgId)
        if (!licenseCheck.valid) {
            return c.json({ type: 'error', message: licenseCheck.message, code: licenseCheck.code }, 403)
        }
    } catch { /* LicenseService not initialized */ }
    return null
}

type CliSessionConfigInput = z.infer<typeof cliSessionConfigSchema>

type CliSessionConfig = {
    permissionMode?: typeof SESSION_PERMISSION_MODE_VALUES[number]
    modelMode?: 'default' | 'sonnet' | 'opus' | 'opus-4-7' | 'glm-5.1' | 'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-codex' | 'gpt-5.3-codex-spark' | 'gpt-5.2-codex' | 'gpt-5.2' | 'gpt-5.1-codex-max' | 'gpt-5.1-codex-mini'
    modelReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh'
    fastMode?: boolean
}

const CLAUDE_CONFIG_MODELS = new Set(['sonnet', 'opus', 'opus-4-7', 'glm-5.1'])
const CODEX_CONFIG_MODELS = new Set(['default', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'])

function validateCliSessionConfig(
    session: Session,
    input: CliSessionConfigInput
): { ok: true; config: CliSessionConfig } | { ok: false; error: string } {
    const flavor = session.metadata?.flavor ?? 'claude'
    const config: CliSessionConfig = {}

    if (input.permissionMode !== undefined) {
        const permissionModeValidation = validatePermissionModeForSessionFlavor(flavor, input.permissionMode)
        if (!permissionModeValidation.ok) {
            return permissionModeValidation
        }
        config.permissionMode = input.permissionMode
    }

    if (flavor === 'claude') {
        if (input.model !== undefined) {
            if (!CLAUDE_CONFIG_MODELS.has(input.model)) {
                return { ok: false, error: 'Invalid model for Claude sessions' }
            }
            config.modelMode = input.model as CliSessionConfig['modelMode']
        }
        if (input.reasoningEffort !== undefined) {
            return { ok: false, error: 'Claude sessions do not support reasoningEffort runtime steering' }
        }
        if (input.fastMode !== undefined) {
            config.fastMode = input.fastMode
        }
        return { ok: true, config }
    }

    if (flavor === 'codex') {
        if (input.model !== undefined) {
            if (!CODEX_CONFIG_MODELS.has(input.model)) {
                return { ok: false, error: 'Invalid model for Codex sessions' }
            }
            config.modelMode = input.model as CliSessionConfig['modelMode']
        }
        if (input.reasoningEffort !== undefined) {
            config.modelReasoningEffort = input.reasoningEffort
        }
        if (input.fastMode !== undefined) {
            return { ok: false, error: 'Codex sessions do not support fastMode' }
        }
        return { ok: true, config }
    }

    return { ok: false, error: `Session config currently only supports Claude/Codex sessions; current flavor is ${flavor}` }
}

async function applyCliSessionConfig(
    c: { json: (data: any, status?: number) => Response },
    engine: SyncEngine,
    sessionId: string,
    session: Session,
    input: CliSessionConfigInput,
): Promise<Response> {
    if (!session.active) {
        return c.json({ error: 'Session is offline; resume it before changing runtime config' }, 409)
    }

    const validated = validateCliSessionConfig(session, input)
    if (!validated.ok) {
        return c.json({ error: validated.error }, 400)
    }

    try {
        const applied = await engine.applySessionConfig(sessionId, validated.config)
        return c.json({
            ok: true,
            applied: {
                ...(applied.permissionMode !== undefined ? { permissionMode: applied.permissionMode } : {}),
                ...(applied.modelMode !== undefined ? { model: applied.modelMode } : {}),
                ...(applied.modelReasoningEffort !== undefined ? { reasoningEffort: applied.modelReasoningEffort } : {}),
                ...(applied.fastMode !== undefined ? { fastMode: applied.fastMode } : {}),
            },
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to apply session config'
        return c.json({ error: message }, 409)
    }
}

function resolveSessionForOrg(
    engine: SyncEngine,
    sessionId: string,
    orgId: string
): { ok: true; session: Session } | { ok: false; status: 403 | 404; error: string } {
    const session = typeof engine.getSessionByOrg === 'function'
        ? engine.getSessionByOrg(sessionId, orgId)
        : engine.getSessionByNamespace(sessionId, orgId)
    if (session) {
        return { ok: true, session }
    }
    if (engine.getSession(sessionId)) {
        return { ok: false, status: 403, error: 'Session access denied' }
    }
    return { ok: false, status: 404, error: 'Session not found' }
}

function resolveMachineForOrg(
    engine: SyncEngine,
    machineId: string,
    orgId: string
): { ok: true; machine: Machine } | { ok: false; status: 403 | 404; error: string } {
    const machine = typeof engine.getMachineByOrg === 'function'
        ? engine.getMachineByOrg(machineId, orgId)
        : engine.getMachineByNamespace(machineId, orgId)
    if (machine) {
        return { ok: true, machine }
    }
    if (engine.getMachine(machineId)) {
        return { ok: false, status: 403, error: 'Machine access denied' }
    }
    return { ok: false, status: 404, error: 'Machine not found' }
}

function getMainSessionIdRequiredErrorForChildSource(childSource: string): string {
    return `${childSource} sessions require mainSessionId`
}

function getMainSessionReferenceErrorForChildSource(childSource: string): string {
    const parentSource = getSessionOrchestrationParentSourceForChildSource(childSource)
    if (parentSource === 'brain') {
        return 'mainSessionId must reference a brain session'
    }
    if (parentSource) {
        return `mainSessionId must reference a ${parentSource} session`
    }
    return 'mainSessionId must reference an orchestration parent session'
}

function resolveBrainChildSessionForMain(
    engine: SyncEngine,
    sessionId: string,
    orgId: string,
    mainSessionId: string,
    childSource: string,
): { ok: true; session: Session } | { ok: false; status: 403 | 404; error: string } {
    const resolved = resolveSessionForOrg(engine, sessionId, orgId)
    if (!resolved.ok) {
        return resolved
    }

    const mainResolved = resolveSessionForOrg(engine, mainSessionId, orgId)
    if (!mainResolved.ok) {
        return mainResolved
    }

    const expectedParentSource = getSessionOrchestrationParentSourceForChildSource(childSource)
    if (!isSessionOrchestrationParentMetadata(mainResolved.session.metadata, expectedParentSource)) {
        return { ok: false, status: 403, error: getMainSessionReferenceErrorForChildSource(childSource) }
    }

    if (!isSessionOrchestrationChildForParentMetadata(resolved.session.metadata, mainResolved.session.metadata, mainSessionId)) {
        return { ok: false, status: 403, error: 'Session access denied' }
    }

    return resolved
}

function resolveSessionForMutationScope(
    engine: SyncEngine,
    sessionId: string,
    orgId: string,
    mainSessionId?: string,
): { ok: true; session: Session } | { ok: false; status: 400 | 403 | 404; error: string } {
    const resolved = resolveSessionForOrg(engine, sessionId, orgId)
    if (!resolved.ok) {
        return resolved
    }

    const childSource = getSessionSourceFromMetadata(resolved.session.metadata)
    if (!childSource || !isSessionOrchestrationChildSource(childSource)) {
        return resolved
    }

    if (!mainSessionId) {
        return { ok: false, status: 400, error: getMainSessionIdRequiredErrorForChildSource(childSource) }
    }

    return resolveBrainChildSessionForMain(engine, sessionId, orgId, mainSessionId, childSource)
}

function resolveSessionForReadScope(
    engine: SyncEngine,
    sessionId: string,
    orgId: string,
    mainSessionId?: string,
): { ok: true; session: Session } | { ok: false; status: 400 | 403 | 404; error: string } {
    const resolved = resolveSessionForOrg(engine, sessionId, orgId)
    if (!resolved.ok) {
        return resolved
    }

    const childSource = getSessionSourceFromMetadata(resolved.session.metadata)
    if (!childSource || !isSessionOrchestrationChildSource(childSource)) {
        return resolved
    }

    if (!mainSessionId) {
        return { ok: false, status: 400, error: getMainSessionIdRequiredErrorForChildSource(childSource) }
    }

    return resolveBrainChildSessionForMain(engine, sessionId, orgId, mainSessionId, childSource)
}

function toSessionSendResponse(sessionId: string, outcome: SendMessageOutcome): SessionSendResponse {
    if (outcome.status === 'queued') {
        return {
            ok: true,
            status: 'queued',
            sessionId,
            queue: outcome.queue,
            queueDepth: outcome.queueDepth,
        }
    }

    return {
        ok: true,
        status: 'delivered',
        sessionId,
    }
}

export function createCliRoutes(
    getSyncEngine: () => SyncEngine | null,
    getSseManager?: () => SSEManager | null,
    store?: import('../../store/interface').IStore,
): Hono<CliEnv> {
    const app = new Hono<CliEnv>()

    const getStoredSessionForOrg = async (sessionId: string, orgId: string) => {
        if (!store) {
            return null
        }
        if (typeof store.getSessionByOrg === 'function') {
            return await store.getSessionByOrg(sessionId, orgId)
        }
        return await store.getSessionByNamespace?.(sessionId, orgId) ?? null
    }

    app.use('*', async (c, next) => {
        const raw = c.req.header('authorization')
        if (!raw) {
            return c.json({ error: 'Missing Authorization header' }, 401)
        }

        const parsed = bearerSchema.safeParse(raw)
        if (!parsed.success) {
            return c.json({ error: 'Invalid Authorization header' }, 401)
        }

        const token = parsed.data.replace(/^Bearer\s+/i, '')
        const parsedToken = parseAccessToken(token)
        if (!parsedToken || !safeCompareStrings(parsedToken.baseToken, configuration.cliApiToken)) {
            return c.json({ error: 'Invalid token' }, 401)
        }

        const orgId = c.req.header('x-org-id')?.trim()
        if (!orgId) {
            return c.json({ error: 'Missing x-org-id header' }, 401)
        }

        c.set('orgId', orgId)
        return await next()
    })

    app.post('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadSessionSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const source = getSessionSourceFromMetadata(parsed.data.metadata)
        if (!isSupportedSessionSource(source)) {
            return c.json({ error: getUnsupportedSessionSourceError(source) }, 400)
        }
        const metadataError = getSessionMetadataPersistenceError(parsed.data.metadata)
        if (metadataError) {
            return c.json({ error: metadataError }, 400)
        }

        const orgId = c.get('orgId')
        const normalizedMetadata = normalizeSessionMetadataInvariants(parsed.data.metadata)
        const session = await engine.getOrCreateSession(parsed.data.tag, normalizedMetadata, parsed.data.agentState ?? null, orgId)
        return c.json({ session })
    })

    app.get('/sessions/search', async (c) => {
        const parsed = sessionSearchQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }
        if (!store) {
            return c.json({ error: 'Store not available' }, 503)
        }
        const requestedSource = parsed.data.source ? getSessionSourceFromMetadata({ source: parsed.data.source }) : null
        if (parsed.data.mainSessionId && requestedSource && !isSessionOrchestrationChildSource(requestedSource)) {
            return c.json({ error: 'mainSessionId filter requires an orchestration child source when source is provided' }, 400)
        }

        const orgId = c.get('orgId')
        const engine = getSyncEngine()
        const limit = parsed.data.limit ?? 5
        const storedResults = await store.searchSessionHistory({
            orgId,
            query: parsed.data.query,
            limit,
            includeOffline: parsed.data.includeOffline ?? true,
            mainSessionId: parsed.data.mainSessionId,
            directory: parsed.data.directory,
            flavor: parsed.data.flavor,
            source: parsed.data.source,
        })

        return c.json(buildBrainSessionSearchPayload({
            storedResults,
            engine,
            orgId,
            query: parsed.data.query,
        }))
    })

    app.get('/sessions/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const queryParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!queryParsed.success) {
            return c.json({ error: 'Invalid query', details: queryParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForReadScope(engine, sessionId, orgId, queryParsed.data.mainSessionId)
        if (!resolved.ok) {
            console.warn(`[cli/read] GET /cli/sessions/${sessionId} rejected: ${resolved.error} (mainSessionId=${queryParsed.data.mainSessionId ?? 'NONE'})`)
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ session: resolved.session })
    })

    app.get('/sessions/:id/messages', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const scopeParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!scopeParsed.success) {
            return c.json({ error: 'Invalid query', details: scopeParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForReadScope(engine, sessionId, orgId, scopeParsed.data.mainSessionId)
        if (!resolved.ok) {
            console.warn(`[cli/read] GET /cli/sessions/${sessionId}/messages rejected: ${resolved.error} (mainSessionId=${scopeParsed.data.mainSessionId ?? 'NONE'})`)
            return c.json({ error: resolved.error }, resolved.status)
        }

        const parsed = getMessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const limit = parsed.data.limit ?? 200
        const afterSeq = parsed.data.afterSeq ?? 0
        const messages = await engine.getMessagesAfter(sessionId, { afterSeq, limit })
        return c.json({ messages })
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const scopeParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!scopeParsed.success) {
            return c.json({ error: 'Invalid query', details: scopeParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, scopeParsed.data.mainSessionId)
        if (!resolved.ok) {
            if (resolved.status === 400) {
                return c.json({ error: resolved.error }, 400)
            }
            const status = resolved.status === 403 ? 'access_denied' : 'not_found'
            const body: SessionSendResponse = {
                ok: false,
                status,
                sessionId,
                retryable: false,
                error: resolved.error,
            }
            return c.json(body, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = cliSendMessageSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        if (!resolved.session.active) {
            const offline: SessionSendResponse = {
                ok: false,
                status: 'offline',
                sessionId,
                retryable: true,
                resumeRequired: true,
            }
            return c.json(offline)
        }

        const sessionSource = getSessionSourceFromMetadata(resolved.session.metadata)
        const allowBrainInboxQueue = sessionSource === 'brain'

        const idempotencyKey = c.req.header('idempotency-key')?.trim()
            || c.req.header('x-idempotency-key')?.trim()
            || undefined
        const requestLocalId = parsed.data.localId ?? idempotencyKey

        if (resolved.session.thinking && !allowBrainInboxQueue) {
            if (requestLocalId) {
                const duplicateOutcome = engine.getSendOutcomeForCachedLocalId(sessionId, requestLocalId)
                if (duplicateOutcome) {
                    return c.json(toSessionSendResponse(sessionId, duplicateOutcome))
                }
            }
            const busy: SessionSendResponse = {
                ok: false,
                status: 'busy',
                sessionId,
                retryable: true,
            }
            return c.json(busy)
        }

        const outcome = await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: requestLocalId,
            sentFrom: parsed.data.sentFrom || 'webapp'
        })
        const response: SessionSendResponse = toSessionSendResponse(sessionId, outcome)
        return c.json(response)
    })

    app.post('/sessions/:id/abort', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const queryParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!queryParsed.success) {
            return c.json({ error: 'Invalid query', details: queryParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, queryParsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        await engine.abortSession(sessionId)
        return c.json({ ok: true })
    })

    app.post('/sessions/:id/resume', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        if (!store) {
            return c.json({ error: 'Store not available' }, 503)
        }

        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const parsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, parsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const session = resolved.session
        if (session.active) {
            if (session.metadata?.lifecycleState === 'archived') {
                const unarchiveResult = await engine.unarchiveSession(sessionId, { actor: 'cli-resume-already-active' })
                if (!unarchiveResult.ok) {
                    console.warn(`[cli/resume] Failed to clear archive metadata for already-active session ${sessionId}: ${unarchiveResult.error}`)
                }
            }
            return c.json({ type: 'already-active', sessionId })
        }

        const storedSession = await getStoredSessionForOrg(sessionId, orgId)
        const licenseError = await checkCliSessionLicense(c, storedSession?.orgId)
        if (licenseError) {
            return licenseError
        }

        const flavor = session.metadata?.flavor ?? 'claude'
        if (flavor !== 'claude' && flavor !== 'codex') {
            return c.json({ error: 'Resume not supported for this session flavor' }, 400)
        }

        const machineId = session.metadata?.machineId?.trim()
        if (!machineId) {
            return c.json({ error: 'Session machine not found' }, 409)
        }

        const machineResolved = resolveMachineForOrg(engine, machineId, orgId)
        if (!machineResolved.ok) {
            return c.json({ error: machineResolved.error }, machineResolved.status)
        }
        if (!machineResolved.machine.active) {
            return c.json({ error: 'Machine is offline' }, 409)
        }

        const spawnTarget = await resolveSpawnTarget(engine, machineId, session)
        if (!spawnTarget.ok) {
            return c.json({ error: spawnTarget.error }, 409)
        }

        const modeSettings = {
            permissionMode: normalizeSessionPermissionMode({
                flavor: session.metadata?.flavor,
                permissionMode: session.permissionMode,
                metadata: session.metadata,
            }),
            modelMode: session.modelMode,
            modelReasoningEffort: session.modelReasoningEffort,
        }
        const invalidResumeMetadataReason = getInvalidResumeMetadataReason(session.metadata)
        if (invalidResumeMetadataReason) {
            return c.json({ error: invalidResumeMetadataReason }, 409)
        }
        const resumeMetadata = extractResumeSpawnMetadata(session.metadata)
        const { yolo: resumeYolo, ...resumeExtras } = extractResumeSpawnExtras(session.metadata)
        const tokenSourceSpawnOptions = await resolveResumeTokenSourceSpawnOptions(
            store, storedSession?.orgId ?? null, session.metadata, flavor
        )
        const resumeSessionId = (() => {
            const value = flavor === 'claude'
                ? session.metadata?.claudeSessionId
                : session.metadata?.codexSessionId
            return typeof value === 'string' && value.trim() ? value : undefined
        })()

        console.log(
            `[cli/resume] Begin resume session=${sessionId} source=${getSessionSourceFromMetadata(session.metadata) ?? 'unknown'} ` +
            `mainSessionId=${getSessionOrchestrationParentSessionId(session.metadata) ?? 'NONE'} flavor=${flavor} ` +
            `machineId=${machineId} resumeSessionId=${resumeSessionId ?? 'NONE'}`
        )

        const now = Date.now()
        await store.setSessionActive(sessionId, true, now, orgId)
        session.active = true
        session.activeAt = now
        session.thinking = false
        session.resumingUntil = now + RESUME_TIMEOUT_MS

        const resumeAttempt = await engine.spawnSession(
            machineId,
            spawnTarget.directory,
            flavor,
            resumeYolo,
            { sessionId, resumeSessionId, ...modeSettings, ...resumeMetadata, ...resumeExtras, ...(tokenSourceSpawnOptions ?? {}) }
        )

        if (resumeAttempt.type === 'success') {
            const online = await waitForSessionOnline(engine, sessionId, RESUME_TIMEOUT_MS)
            if (online) {
                if (session.metadata?.lifecycleState === 'archived') {
                    const unarchiveResult = await engine.unarchiveSession(sessionId, { actor: 'cli-resume' })
                    if (!unarchiveResult.ok) {
                        console.warn(`[cli/resume] Failed to clear archive metadata for ${sessionId}: ${unarchiveResult.error}`)
                    }
                }
                console.log(`[cli/resume] In-place resume succeeded for session=${sessionId}`)
                return c.json({ type: 'resumed', sessionId })
            }
        }

        await engine.terminateSessionProcess(sessionId)
        session.active = false
        session.thinking = false
        session.resumingUntil = undefined
        await store.setSessionActive(sessionId, false, Date.now(), orgId)

        const fallbackResult = await engine.spawnSession(
            machineId,
            spawnTarget.directory,
            flavor,
            resumeYolo,
            { resumeSessionId, ...modeSettings, ...resumeMetadata, ...resumeExtras, ...(tokenSourceSpawnOptions ?? {}) }
        )

        if (fallbackResult.type !== 'success') {
            return c.json({ error: fallbackResult.message }, 409)
        }

        const newSessionId = fallbackResult.sessionId
        const online = await waitForSessionOnline(engine, newSessionId, RESUME_TIMEOUT_MS)
        if (!online) {
            return c.json({ error: 'Session resume timed out' }, 409)
        }

        console.warn(
            `[cli/resume] Fallback created replacement session old=${sessionId} new=${newSessionId} ` +
            `source=${getSessionSourceFromMetadata(session.metadata) ?? 'unknown'} ` +
            `mainSessionId=${getSessionOrchestrationParentSessionId(session.metadata) ?? 'NONE'}`
        )

        if (storedSession?.orgId) {
            await store.setSessionOrgId(newSessionId, storedSession.orgId).catch(() => {})
        }

        const resumedSource = getSessionSourceFromMetadata(session.metadata)
        if (isSessionOrchestrationParentSource(resumedSource) && newSessionId !== sessionId) {
            const childSessions = engine.getSessionsByOrg(orgId).filter((candidate) => {
                return isSessionOrchestrationChildForParentMetadata(candidate.metadata, session.metadata, sessionId)
            })

            for (const child of childSessions) {
                const patchResult = await engine.patchSessionMetadata(child.id, { mainSessionId: newSessionId })
                if (!patchResult.ok) {
                    console.warn(`[cli/resume] Failed to rebind child ${child.id} to resumed parent session ${newSessionId}: ${patchResult.error}`)
                }
            }
        }

        const resumedSession = engine.getSession(newSessionId)
        const projectRoot = resumedSession?.metadata?.path?.trim() || null
        const contextBundlePrompt = renderSessionContextBundlePrompt(await buildSessionContextBundle(store, {
            orgId,
            sessionId: newSessionId,
            projectRoot,
        }))
        const initPrompt = await buildInitPrompt('developer', { projectRoot, contextBundlePrompt })
        if (initPrompt.trim()) {
            await engine.sendMessage(newSessionId, { text: initPrompt, sentFrom: 'webapp' })
        }

        if (!resumeSessionId) {
            const page = await engine.getMessagesPage(sessionId, { limit: RESUME_CONTEXT_MAX_LINES * 2, beforeSeq: null })
            const contextMessage = buildResumeContextMessage(session, page.messages)
            if (contextMessage) {
                await engine.sendMessage(newSessionId, { text: contextMessage, sentFrom: 'webapp' })
            }
        }

        return c.json({
            type: 'created',
            sessionId: newSessionId,
            resumedFrom: sessionId,
            usedResume: Boolean(resumeSessionId),
        })
    })

    app.post('/sessions/:id/config', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const queryParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!queryParsed.success) {
            return c.json({ error: 'Invalid query', details: queryParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, queryParsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const bodyParsed = cliSessionConfigSchema.safeParse(body)
        if (!bodyParsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        return await applyCliSessionConfig(c, engine, sessionId, resolved.session, bodyParsed.data)
    })

    // List online machines
    app.get('/machines', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const orgId = c.get('orgId')
        const machines = sortMachinesForDisplay(
            typeof engine.getMachinesByOrg === 'function'
                ? engine.getMachinesByOrg(orgId)
                : engine.getMachinesByNamespace(orgId)
        )
        return c.json({
            machines: machines.map(serializeMachine)
        })
    })

    app.post('/machines', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const json = await c.req.json().catch(() => null)
        const parsed = createOrLoadMachineSchema.safeParse(json)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const orgId = c.get('orgId')
        const existing = engine.getMachine(parsed.data.id)
        if (existing && existing.orgId !== orgId) {
            return c.json({ error: 'Machine access denied' }, 403)
        }
        const machine = await engine.getOrCreateMachine(parsed.data.id, parsed.data.metadata, parsed.data.daemonState ?? null, orgId)
        return c.json({ machine })
    })

    app.get('/machines/:id', (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const machineId = c.req.param('id')
        const orgId = c.get('orgId')
        const resolved = resolveMachineForOrg(engine, machineId, orgId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        return c.json({ machine: resolved.machine })
    })

    // Server uploads - allow CLI to fetch images uploaded via web
    app.get('/server-uploads/:sessionId/:filename', (c) => {
        const sessionId = c.req.param('sessionId')
        const filename = c.req.param('filename')

        // Reject params containing path separators (guards against %2F traversal after decoding)
        if (sessionId.includes('/') || sessionId.includes('\\') || filename.includes('/') || filename.includes('\\')) {
            return c.json({ error: 'Invalid path' }, 400)
        }

        try {
            const config = getConfiguration()
            const uploadsBase = resolve(config.dataDir, 'uploads')
            const filePath = resolve(uploadsBase, sessionId, filename)

            // Prevent path traversal: resolved path must stay within uploads directory
            if (!filePath.startsWith(uploadsBase + '/')) {
                return c.json({ error: 'Invalid path' }, 400)
            }

            if (!existsSync(filePath)) {
                return c.json({ error: 'File not found' }, 404)
            }

            const buffer = readFileSync(filePath)

            // Infer MIME type from filename
            const ext = filename.split('.').pop()?.toLowerCase() ?? ''
            const imageMimeTypes: Record<string, string> = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml',
                'bmp': 'image/bmp',
                'ico': 'image/x-icon',
                'heic': 'image/heic',
                'heif': 'image/heif'
            }
            const contentType = imageMimeTypes[ext] ?? 'application/octet-stream'

            return new Response(buffer, {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length.toString(),
                    'Cache-Control': 'public, max-age=31536000, immutable'
                }
            })
        } catch (error) {
            console.error('[cli/server-uploads] read error:', error)
            return c.json({ error: 'Failed to read file' }, 500)
        }
    })

    // Feishu chat messages: query persisted messages for a chat
    app.get('/feishu/chat-messages', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const chatId = c.req.query('chatId')
        if (!chatId) {
            return c.json({ error: 'chatId is required' }, 400)
        }
        const limit = Math.min(Number(c.req.query('limit') || '50'), 200)
        const before = c.req.query('before') ? Number(c.req.query('before')) : undefined

        try {
            const messages = await store.getFeishuChatMessages(chatId, limit, before)
            return c.json({ messages })
        } catch (err: any) {
            return c.json({ error: err.message || 'Failed to query messages' }, 500)
        }
    })

    // Spawn an orchestration child session. Brain keeps using this route unchanged.
    app.post('/brain/spawn', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = brainSpawnSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', details: parsed.error.issues }, 400)
        }

        const orgId = c.get('orgId')
        let mainSession: Awaited<ReturnType<typeof getStoredSessionForOrg>> = null
        let liveMainSession: Session | null = null
        const machineResolved = resolveMachineForOrg(engine, parsed.data.machineId, orgId)
        if (!machineResolved.ok) {
            return c.json({ error: machineResolved.error }, machineResolved.status)
        }
        if (!machineResolved.machine.active) {
            return c.json({ error: 'Machine is offline' }, 503)
        }

        if (isSessionOrchestrationChildSource(parsed.data.source)) {
            const mainSessionId = parsed.data.mainSessionId
            if (!mainSessionId) {
                return c.json({ error: getMainSessionIdRequiredErrorForChildSource(parsed.data.source) }, 400)
            }
            const mainResolved = resolveSessionForOrg(engine, mainSessionId, orgId)
            if (!mainResolved.ok) {
                return c.json({ error: mainResolved.error }, mainResolved.status)
            }
            const expectedParentSource = getSessionOrchestrationParentSourceForChildSource(parsed.data.source)
            if (!isSessionOrchestrationParentMetadata(mainResolved.session.metadata, expectedParentSource)) {
                return c.json({ error: getMainSessionReferenceErrorForChildSource(parsed.data.source) }, 400)
            }
            liveMainSession = mainResolved.session
        }

        // License check: 从 mainSession 继承 orgId 进行校验
        if (parsed.data.mainSessionId && store) {
            mainSession = await getStoredSessionForOrg(parsed.data.mainSessionId, orgId)
            const brainOrgId = mainSession?.orgId || machineResolved.machine.orgId
            if (brainOrgId) {
                try {
                    const licenseService = getLicenseService()
                    const licenseCheck = await licenseService.canCreateSession(brainOrgId)
                    if (!licenseCheck.valid) {
                        return c.json({ type: 'error', message: licenseCheck.message, code: licenseCheck.code }, 403)
                    }
                } catch { /* LicenseService not initialized */ }
            }
        }

        // For codex sessions, store codexModel as modelMode so session_find_or_create can match by model tier
        let effectiveModelMode: string | undefined = parsed.data.modelMode
        if (!effectiveModelMode && parsed.data.codexModel) {
            effectiveModelMode = parsed.data.codexModel
        }
        if (!isSupportedSessionSource(parsed.data.source)) {
            return c.json({ error: getUnsupportedSessionSourceError(parsed.data.source) }, 400)
        }
        const mainSessionMetadata = asRecord(mainSession?.metadata) ?? asRecord(liveMainSession?.metadata)
        const effectiveCaller = asNonEmptyString(parsed.data.caller) ?? asNonEmptyString(mainSessionMetadata?.caller)
        const requestedBrainPreferences = parsed.data.brainPreferences === undefined
            ? undefined
            : parseBrainSessionPreferences(parsed.data.brainPreferences)
        if (parsed.data.brainPreferences !== undefined && !requestedBrainPreferences) {
            return c.json({ error: 'Invalid brainPreferences in request body' }, 400)
        }
        const inheritedBrainPreferences = mainSessionMetadata?.brainPreferences === undefined
            ? undefined
            : parseBrainSessionPreferences(mainSessionMetadata.brainPreferences)
        if (requestedBrainPreferences === undefined && mainSessionMetadata?.brainPreferences !== undefined && !inheritedBrainPreferences) {
            return c.json({ error: 'Parent brain session has invalid brainPreferences metadata; repair it before spawning children' }, 409)
        }
        const effectiveBrainPreferences = (requestedBrainPreferences ?? inheritedBrainPreferences) ?? undefined
        const parsedBrainPreferences = effectiveBrainPreferences

        const childAgent: 'claude' | 'codex' = parsed.data.agent ?? 'claude'
        const brainOrgId = mainSession?.orgId ?? machineResolved.machine.orgId ?? null

        // brain-child only: spawned with `source: 'brain-child'`. Non-Brain callers skip token-source inheritance and Local-disabled checks.
        const isBrainChildSpawn = parsed.data.source === 'brain-child'
        if (isBrainChildSpawn && parsedBrainPreferences) {
            const allowedChildAgents = getAllowedBrainChildAgents(parsedBrainPreferences)
            if (!allowedChildAgents.includes(childAgent)) {
                return c.json({ error: `Brain does not allow child agent "${childAgent}"` }, 400)
            }
        }

        // Machine-agent compatibility guard: validate here rather than letting spawnSession fail late.
        // Even for non-brain-child flows this protects against inherited/selected agent mismatches.
        const machineSupportedAgents = machineResolved.machine.supportedAgents
        if (machineSupportedAgents && machineSupportedAgents.length > 0 && !machineSupportedAgents.includes(childAgent)) {
            return c.json({ error: `Machine does not support agent "${childAgent}"` }, 400)
        }

        let inheritedTokenSource: Awaited<ReturnType<typeof resolveTokenSourceForAgent>> | null = null
        if (isBrainChildSpawn && store && brainOrgId) {
            const brainTokenSourceIds = asRecord(mainSessionMetadata?.brainTokenSourceIds)
            const hasNewConfig = brainTokenSourceIds !== undefined
            let inheritedId = asNonEmptyString(brainTokenSourceIds?.[childAgent])
            if (!inheritedId) {
                const legacyType = asNonEmptyString(mainSessionMetadata?.tokenSourceType)
                const legacyId = asNonEmptyString(mainSessionMetadata?.tokenSourceId)
                if (legacyId && legacyType === childAgent) {
                    inheritedId = legacyId
                }
            }
            if (inheritedId) {
                const resolved = await resolveTokenSourceForAgent(store, brainOrgId, inheritedId, childAgent)
                if ('error' in resolved) {
                    return c.json({ error: `Brain Token Source unavailable for ${childAgent}: ${resolved.error}` }, resolved.status as 400 | 404)
                }
                inheritedTokenSource = resolved
            } else if (hasNewConfig) {
                // Brain was created via the dual-source flow (opt-in): admin explicitly chose its TS config,
                // so enforce the Local-disabled guard strictly.
                const localEnabled = await getLocalTokenSourceEnabledForOrg(store, brainOrgId)
                if (!localEnabled) {
                    return c.json({ error: `Brain does not have a ${childAgent} Token Source configured, and Local is disabled for this organization` }, 400)
                }
            }
            // Legacy Brain (no brainTokenSourceIds) with no matching legacy TS: grandfathered — child falls back to Local.
        }

        const spawnStartedAt = Date.now()
        const result = await engine.spawnSession(
            parsed.data.machineId,
            parsed.data.directory,
            parsed.data.agent as any,
            true,     // yolo
            {
                source: parsed.data.source,
                mainSessionId: parsed.data.mainSessionId,
                caller: effectiveCaller,
                brainPreferences: effectiveBrainPreferences ?? undefined,
                permissionMode: resolveBrainSpawnPermissionMode(childAgent),
                modelMode: effectiveModelMode as any,
                codexModel: parsed.data.codexModel,
                tokenSourceId: inheritedTokenSource && 'tokenSource' in inheritedTokenSource ? inheritedTokenSource.tokenSource.id : undefined,
                tokenSourceName: inheritedTokenSource && 'tokenSource' in inheritedTokenSource ? inheritedTokenSource.tokenSource.name : undefined,
                tokenSourceType: inheritedTokenSource && 'tokenSource' in inheritedTokenSource ? childAgent : undefined,
                tokenSourceBaseUrl: inheritedTokenSource && 'tokenSource' in inheritedTokenSource ? inheritedTokenSource.tokenSource.baseUrl : undefined,
                tokenSourceApiKey: inheritedTokenSource && 'tokenSource' in inheritedTokenSource ? inheritedTokenSource.tokenSource.apiKey : undefined,
            }
        )
        const engineSpawnMs = Date.now() - spawnStartedAt
        const perf = summarizeSpawnLogs('logs' in result ? result.logs : undefined)
        const rpcOverheadMs = perf.daemonTotalMs === null
            ? null
            : Math.max(0, engineSpawnMs - perf.daemonTotalMs)

        if (result.type === 'success') {
            console.log(
                `[brain/spawn-perf] session=${result.sessionId} machine=${parsed.data.machineId.slice(0, 8)} ` +
                `agent=${childAgent} engine=${engineSpawnMs}ms rpc_overhead=${formatPerfMs(rpcOverheadMs)} ` +
                `daemon_total=${formatPerfMs(perf.daemonTotalMs)} daemon_prep=${formatPerfMs(perf.daemonPrepMs)} ` +
                `daemon_cli_spawn=${formatPerfMs(perf.daemonCliSpawnMs)} daemon_webhook=${formatPerfMs(perf.daemonWebhookMs)}`
            )
        } else {
            console.warn(
                `[brain/spawn-perf] machine=${parsed.data.machineId.slice(0, 8)} agent=${childAgent} ` +
                `outcome=${result.type} engine=${engineSpawnMs}ms rpc_overhead=${formatPerfMs(rpcOverheadMs)} ` +
                `daemon_total=${formatPerfMs(perf.daemonTotalMs)} daemon_prep=${formatPerfMs(perf.daemonPrepMs)} ` +
                `daemon_cli_spawn=${formatPerfMs(perf.daemonCliSpawnMs)} daemon_webhook=${formatPerfMs(perf.daemonWebhookMs)}`
            )
        }

        // Inherit org_id from main (brain) session
        if (result.type === 'success' && parsed.data.mainSessionId && store) {
            mainSession = mainSession ?? await getStoredSessionForOrg(parsed.data.mainSessionId, orgId)
            if (mainSession?.orgId) {
                await store.setSessionOrgId(result.sessionId, mainSession.orgId)
            }
        }

        // Send init prompt to the spawned orchestration child session (fire-and-forget)
        if (result.type === 'success') {
            void (async () => {
                try {
                    // Wait for session to come online
                    const isOnline = await new Promise<boolean>((resolve) => {
                        const existing = engine.getSession(result.sessionId)
                        if (existing?.active) return resolve(true)
                        const timer = setTimeout(() => resolve(false), 60_000)
                        const unsub = engine.subscribe((event) => {
                            if (event.sessionId !== result.sessionId) return
                            if (event.type !== 'session-added' && event.type !== 'session-updated') return
                            const s = engine.getSession(result.sessionId)
                            if (s?.active) { clearTimeout(timer); unsub(); resolve(true) }
                        })
                        // Re-check after subscribing
                        const current = engine.getSession(result.sessionId)
                        if (current?.active) { clearTimeout(timer); unsub(); resolve(true) }
                    })
                    if (!isOnline) {
                        console.warn(`[brain/spawn] Session ${result.sessionId} did not come online within 60s, skipping init prompt`)
                        return
                    }
                    // Wait for socket to join room
                    await engine.waitForSocketInRoom(result.sessionId, 5000)
                    // Build and send init prompt
                    const session = engine.getSession(result.sessionId)
                    const projectRoot = session?.metadata?.path?.trim() || null
                    const contextBundlePrompt = store
                        ? renderSessionContextBundlePrompt(await buildSessionContextBundle(store, {
                            orgId,
                            sessionId: result.sessionId,
                            projectRoot,
                        }))
                        : ''
                    const prompt = await buildInitPrompt('developer', { projectRoot, contextBundlePrompt })
                    if (prompt.trim()) {
                        await engine.sendMessage(result.sessionId, { text: prompt, sentFrom: 'webapp' })
                        console.log(`[brain/spawn] Sent init prompt to ${parsed.data.source} session ${result.sessionId}`)
                    }
                } catch (err) {
                    console.error(`[brain/spawn] Failed to send init prompt to ${result.sessionId}:`, err)
                }
            })()
        }

        return c.json(result)
    })

    // Brain: list sessions, optionally scoped to one main Brain's child sessions
    app.get('/sessions', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const orgId = c.get('orgId')
        const parsed = listSessionsQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }

        const allSessions = typeof engine.getSessionsByOrg === 'function'
            ? engine.getSessionsByOrg(orgId)
            : engine.getSessionsByNamespace(orgId)
        let scopedSessions = allSessions

        if (parsed.data.mainSessionId) {
            const mainResolved = resolveSessionForOrg(engine, parsed.data.mainSessionId, orgId)
            if (!mainResolved.ok) {
                return c.json({ error: mainResolved.error }, mainResolved.status)
            }
            if (!isSessionOrchestrationParentMetadata(mainResolved.session.metadata)) {
                return c.json({ error: 'mainSessionId must reference an orchestration parent session' }, 403)
            }
            scopedSessions = allSessions.filter((session) =>
                isSessionOrchestrationChildForParentMetadata(session.metadata, mainResolved.session.metadata, parsed.data.mainSessionId!)
            )
        }

        const sessions = parsed.data.includeOffline ? scopedSessions : scopedSessions.filter(s => s.active)
        const summaries = sessions.map(s => ({
            id: s.id,
            active: s.active,
            activeAt: s.activeAt,
            thinking: s.thinking ?? false,
            initDone: isSessionOrchestrationChildSource(s.metadata?.source) ? engine.isBrainChildInitDone(s.id) : true,
            modelMode: s.modelMode ?? 'default',
            pendingRequestsCount: s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0,
            metadata: s.metadata ? {
                path: s.metadata.path,
                source: s.metadata.source,
                machineId: s.metadata.machineId,
                flavor: s.metadata.flavor,
                summary: s.metadata.summary,
                mainSessionId: getSessionOrchestrationParentSessionId(s.metadata),
                brainSummary: (s.metadata as any).brainSummary,
            } : null,
        }))
        return c.json({ sessions: summaries })
    })

    // Brain: delete a session
    app.delete('/sessions/:id', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const parsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, parsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }
        const purgeParam = c.req.query('purge')
        const purge = purgeParam === '1' || purgeParam === 'true'
        const archivedByParam = c.req.query('archivedBy')
        const archiveReasonParam = c.req.query('archiveReason')
        const terminateParam = c.req.query('terminateSession')
        const terminateSession = terminateParam === '0' || terminateParam === 'false' ? false : true
        const ok = purge
            ? await engine.deleteSession(sessionId, { terminateSession, force: true })
            : await engine.archiveSession(sessionId, {
                terminateSession,
                force: true,
                archivedBy: archivedByParam || 'brain',
                archiveReason: archiveReasonParam || 'Brain closed session',
            })
        return c.json({ ok })
    })

    // Brain: patch metadata on a child session
    const patchMetadataSchema = z.object({
        brainSummary: z.string().max(2000).optional(),
        summary: z.object({
            text: z.string().max(500),
            updatedAt: z.number().optional(),
        }).optional(),
    })

    app.patch('/sessions/:id/metadata', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const queryParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!queryParsed.success) {
            return c.json({ error: 'Invalid query', details: queryParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, queryParsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = patchMetadataSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        const result = await engine.patchSessionMetadata(sessionId, parsed.data)
        if (!result.ok) {
            return c.json({ error: result.error }, 500)
        }

        return c.json({ ok: true })
    })

    // Brain: legacy model-only alias for shared session config
    const setModelModeSchema = z.object({
        modelMode: z.string().min(1),
    })

    app.patch('/sessions/:id/model-mode', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const queryParsed = optionalBrainChildScopeQuerySchema.safeParse(c.req.query())
        if (!queryParsed.success) {
            return c.json({ error: 'Invalid query', details: queryParsed.error.issues }, 400)
        }
        const resolved = resolveSessionForMutationScope(engine, sessionId, orgId, queryParsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const body = await c.req.json().catch(() => null)
        const parsed = setModelModeSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body' }, 400)
        }

        return await applyCliSessionConfig(c, engine, sessionId, resolved.session, {
            model: parsed.data.modelMode,
        })
    })

    // Brain: inspect a session with orchestration-focused diagnostics
    app.get('/sessions/:id/inspect', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const parsed = brainChildScopeQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }
        const resolved = resolveSessionForReadScope(engine, sessionId, orgId, parsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        return c.json(await buildBrainSessionInspectPayload(engine, resolved.session))
    })

    // Brain: return recent meaningful output/event fragments instead of weak counters
    app.get('/sessions/:id/tail', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const parsed = tailQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }

        const resolved = resolveSessionForReadScope(engine, sessionId, orgId, parsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const limit = parsed.data.limit ?? 6
        const inspectLimit = Math.min(Math.max(limit * 8, 24), 120)
        const page = await engine.getMessagesPage(sessionId, { limit: inspectLimit, beforeSeq: null })
        const selected: BrainSessionTailItem[] = []

        for (let index = page.messages.length - 1; index >= 0 && selected.length < limit; index -= 1) {
            const message = page.messages[index]
            const item = extractTailItem(message?.content)
            if (!item) {
                continue
            }
            selected.push({
                seq: message.seq,
                createdAt: message.createdAt,
                role: item.role,
                kind: item.kind,
                subtype: item.subtype,
                sentFrom: item.sentFrom,
                snippet: item.snippet,
            })
        }

        selected.reverse()

        return c.json({
            sessionId,
            items: selected,
            returned: selected.length,
            inspectedMessages: page.messages.length,
            newestSeq: page.messages.length > 0 ? page.messages[page.messages.length - 1]?.seq ?? null : null,
            oldestSeq: page.messages.length > 0 ? page.messages[0]?.seq ?? null : null,
            hasMoreHistory: page.page.hasMore,
        })
    })

    // ==================== Project CRUD ====================

    const addProjectSchema = z.object({
        name: z.string().min(1).max(100).optional(),
        path: z.string().min(1).max(500),
        description: z.string().max(500).optional(),
    })

    const updateProjectSchema = z.object({
        name: z.string().min(1).max(100).optional(),
        path: z.string().min(1).max(500).optional(),
        description: z.string().max(500).nullable().optional(),
    })

    async function resolveProjectContext(
        sessionId: string | undefined,
        orgId: string
    ): Promise<
        | { ok: true; orgId: string | null; machineId: string | null }
        | { ok: false; status: 400 | 404 | 503; error: string }
    > {
        if (!store) {
            return { ok: false, status: 503, error: 'Store not available' }
        }
        if (!sessionId) {
            return { ok: false, status: 400, error: 'sessionId is required' }
        }

        const session = await getStoredSessionForOrg(sessionId, orgId)
        if (!session) {
            return { ok: false, status: 404, error: 'Session not found' }
        }

        const metadataMachineId = typeof session.metadata === 'object' && session.metadata !== null
            ? (session.metadata as Record<string, unknown>).machineId as string | undefined
            : undefined
        return {
            ok: true,
            orgId: session.orgId ?? null,
            machineId: session.machineId?.trim() || metadataMachineId?.trim() || null,
        }
    }

    function ensureMachineBoundProjectContext(
        context: { orgId: string | null; machineId: string | null }
    ): { ok: true; machineId: string } | { ok: false; status: 400; error: string } {
        if (!context.machineId) {
            return { ok: false, status: 400, error: 'Project operations require a machine-bound session' }
        }
        return { ok: true, machineId: context.machineId }
    }

    type QueryablePool = {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
    }

    function resolveAiTaskPool(): { ok: true; pool: QueryablePool } | { ok: false; status: 503; error: string } {
        const pool = (store as { getPool?: () => QueryablePool } | undefined)?.getPool?.()
        if (!pool) {
            return { ok: false, status: 503, error: 'Store pool not available' }
        }
        return { ok: true, pool }
    }

    // List projects visible to the current session's machine.
    app.get('/projects', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }

        const projects = await store.getProjects(machineContext.machineId, context.orgId)
        return c.json({ projects })
    })

    app.post('/projects', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const json = await c.req.json().catch(() => null)
        const parsed = addProjectSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid project data' }, 400)

        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }

        const name = parsed.data.name ?? toPascalCase(parsed.data.path)
        const project = await store.addProject(
            name,
            parsed.data.path,
            parsed.data.description,
            machineContext.machineId,
            context.orgId,
        )
        if (!project) return c.json({ error: 'Failed to add project. Path may already exist.' }, 400)

        const projects = await store.getProjects(machineContext.machineId, context.orgId)
        return c.json({ ok: true, project, projects })
    })

    app.put('/projects/:id', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const id = c.req.param('id')
        const json = await c.req.json().catch(() => null)
        const parsed = updateProjectSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid project data' }, 400)
        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }

        const existing = await store.getProject(id)
        if (!existing) return c.json({ error: 'Project not found or path already exists' }, 404)
        if (existing.orgId !== null && existing.orgId !== context.orgId) {
            return c.json({ error: 'Project not found or path already exists' }, 404)
        }
        if (existing.machineId !== machineContext.machineId) {
            return c.json({ error: 'Project not found or path already exists' }, 404)
        }

        const project = await store.updateProject(id, {
            name: parsed.data.name,
            path: parsed.data.path,
            description: parsed.data.description,
            orgId: context.orgId,
        })
        if (!project) return c.json({ error: 'Project not found or path already exists' }, 404)

        const projects = await store.getProjects(machineContext.machineId, context.orgId)
        return c.json({ ok: true, project, projects })
    })

    // Delete project (param: id, query: sessionId)
    app.delete('/projects/:id', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const id = c.req.param('id')
        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }

        // Verify caller owns this project before deleting
        const existing = await store.getProject(id)
        if (!existing) return c.json({ error: 'Project not found' }, 404)
        if (existing.orgId !== null && existing.orgId !== context.orgId) {
            return c.json({ error: 'Project not found' }, 404)
        }
        if (existing.machineId !== machineContext.machineId) {
            return c.json({ error: 'Project not found' }, 404)
        }

        const success = await store.removeProject(id)
        if (!success) return c.json({ error: 'Project not found' }, 404)

        const projects = await store.getProjects(machineContext.machineId, context.orgId)
        return c.json({ ok: true, projects })
    })

    // ==================== AI Task Schedules ====================

    app.get('/worker/schedules', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const parsed = aiTaskScheduleListSchema.safeParse({
            includeDisabled: c.req.query('includeDisabled') === 'true'
                ? true
                : c.req.query('includeDisabled') === 'false'
                    ? false
                    : undefined,
        })
        if (!parsed.success) return c.json({ error: 'Invalid schedule query' }, 400)

        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }
        const poolResult = resolveAiTaskPool()
        if (!poolResult.ok) {
            return c.json({ error: poolResult.error }, poolResult.status)
        }

        const conditions = ['machine_id = $1']
        const params: unknown[] = [machineContext.machineId]
        if (!parsed.data.includeDisabled) {
            conditions.push('enabled = true')
        }

        const result = await poolResult.pool.query(
            `SELECT id, machine_id, label, cron_expr, payload_prompt, recurring, directory, agent, mode, enabled, created_at, next_fire_at, last_fire_at, last_run_status
             FROM ai_task_schedules
             WHERE ${conditions.join(' AND ')}
             ORDER BY created_at DESC`,
            params
        )

        return c.json({
            schedules: (result.rows as Record<string, unknown>[]).map(serializeAiTaskScheduleRow),
        })
    })

    app.post('/worker/schedules', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const json = await c.req.json().catch(() => null)
        const parsed = aiTaskScheduleCreateSchema.safeParse(json)
        if (!parsed.success) return c.json({ error: 'Invalid schedule data' }, 400)

        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }
        const poolResult = resolveAiTaskPool()
        if (!poolResult.ok) {
            return c.json({ error: poolResult.error }, poolResult.status)
        }

        const cronResult = parseCronOrDelay(parsed.data.cronOrDelay)
        if (!cronResult.ok) return c.json({ error: cronResult.error }, 400)
        if (cronResult.kind === 'delay' && parsed.data.recurring) {
            return c.json({ error: 'delay_requires_non_recurring' }, 400)
        }

        const projects = await store.getProjects(machineContext.machineId, context.orgId)
        const project = projects.find((item) => item.path === parsed.data.directory)
        if (!project) {
            return c.json({ error: 'directory_not_registered' }, 400)
        }

        const countResult = await poolResult.pool.query(
            'SELECT COUNT(*)::int AS count FROM ai_task_schedules WHERE machine_id = $1 AND enabled = true',
            [machineContext.machineId]
        )
        const enabledCount = Number(countResult.rows[0]?.count ?? 0)
        if (enabledCount >= 20) {
            return c.json({ error: 'quota_exceeded' }, 429)
        }

        const id = randomUUID()
        const now = Date.now()
        // Persist the caller's sessionId so the dispatcher can thread it through
        // aiTask.mainSessionId and the worker session shows up as an
        // orchestrator-child under the creator brain/session UI.
        const createdBySessionId = c.req.query('sessionId') ?? null
        await poolResult.pool.query(
            `INSERT INTO ai_task_schedules
                (id, namespace, machine_id, label, cron_expr, payload_prompt, directory, agent, mode, recurring, enabled, created_at, next_fire_at, created_by_session_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
                id,
                c.get('orgId'),
                machineContext.machineId,
                parsed.data.label ?? null,
                cronResult.normalizedCron,
                parsed.data.prompt,
                parsed.data.directory,
                parsed.data.agent,
                parsed.data.mode ?? null,
                parsed.data.recurring,
                true,
                now,
                cronResult.nextFireAt ?? null,
                createdBySessionId,
            ]
        )

        return c.json({
            scheduleId: id,
            nextFireAt: cronResult.nextFireAt != null ? new Date(cronResult.nextFireAt).toISOString() : null,
            status: 'registered',
        })
    })

    app.post('/worker/schedules/:id/cancel', async (c) => {
        if (!store) return c.json({ error: 'Store not available' }, 503)
        const parsed = aiTaskScheduleCancelSchema.safeParse({
            scheduleId: c.req.param('id'),
        })
        if (!parsed.success) return c.json({ error: 'Invalid schedule id' }, 400)

        const context = await resolveProjectContext(c.req.query('sessionId'), c.get('orgId'))
        if (!context.ok) {
            return c.json({ error: context.error }, context.status)
        }
        const machineContext = ensureMachineBoundProjectContext(context)
        if (!machineContext.ok) {
            return c.json({ error: machineContext.error }, machineContext.status)
        }
        const poolResult = resolveAiTaskPool()
        if (!poolResult.ok) {
            return c.json({ error: poolResult.error }, poolResult.status)
        }

        const result = await poolResult.pool.query(
            'UPDATE ai_task_schedules SET enabled = false WHERE id = $1 AND machine_id = $2 RETURNING id',
            [parsed.data.scheduleId, machineContext.machineId]
        )
        if (result.rows.length === 0) {
            return c.json({ error: 'schedule_not_found' }, 404)
        }

        return c.json({ ok: true })
    })

    // Brain: get session status with token stats
    app.get('/sessions/:id/status', async (c) => {
        const engine = getSyncEngine()
        if (!engine) {
            return c.json({ error: 'Not ready' }, 503)
        }
        const sessionId = c.req.param('id')
        const orgId = c.get('orgId')
        const parsed = brainChildScopeQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', details: parsed.error.issues }, 400)
        }
        const resolved = resolveSessionForReadScope(engine, sessionId, orgId, parsed.data.mainSessionId)
        if (!resolved.ok) {
            return c.json({ error: resolved.error }, resolved.status)
        }

        const inspect = await buildBrainSessionInspectPayload(engine, resolved.session)
        const metadata = inspect.metadata.path || inspect.metadata.summary || inspect.metadata.brainSummary
            ? {
                path: inspect.metadata.path ?? undefined,
                summary: inspect.metadata.summary ?? undefined,
                brainSummary: inspect.metadata.brainSummary ?? undefined,
            }
            : null

        return c.json({
            active: inspect.active,
            thinking: inspect.thinking,
            initDone: inspect.initDone,
            messageCount: inspect.messageCount,
            lastUsage: inspect.lastUsage,
            modelMode: inspect.modelMode ?? 'default',
            metadata,
        })
    })

    return app
}
