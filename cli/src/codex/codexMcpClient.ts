/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { logger } from '@/ui/logger';
import { isProcessAlive, killProcess } from '@/utils/process';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { randomUUID } from 'node:crypto';
import { resolveCodexBinary } from './codexBinary';

type ElicitResponseValue = string | number | boolean | string[];
type ElicitContent = ElicitResponseValue | Record<string, ElicitResponseValue>;
type ElicitRequestedSchema = {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
};

export type CodexApprovalKind = 'mcp_tool_call' | 'exec_command' | 'unknown';

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function parseSchemaCandidate(raw: unknown): ElicitRequestedSchema | null {
    const candidate = (() => {
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw) as unknown;
            } catch {
                return null;
            }
        }
        return raw;
    })();

    if (!isObject(candidate)) return null;
    const properties = isObject(candidate.properties) ? (candidate.properties as Record<string, unknown>) : undefined;
    const required = Array.isArray(candidate.required) ? candidate.required.filter((item) => typeof item === 'string') : undefined;
    const type = typeof candidate.type === 'string' ? candidate.type : undefined;
    return { type, properties, required };
}

function extractRequestedSchema(params: Record<string, unknown>): ElicitRequestedSchema | null {
    const candidates = [
        params.requestedSchema,
        params.requested_schema,
        params.schema,
        params.jsonSchema,
        params.json_schema
    ];

    for (const candidate of candidates) {
        const parsed = parseSchemaCandidate(candidate);
        if (parsed) return parsed;
    }

    const nested = [params.request, params.payload, params.data];
    for (const candidate of nested) {
        if (!isObject(candidate)) continue;
        const parsed = extractRequestedSchema(candidate);
        if (parsed) return parsed;
    }

    return null;
}

function extractToolCallIdFromRecord(record: Record<string, unknown>): string | null {
    const candidateKeys = [
        'codex_call_id',
        'codex_mcp_tool_call_id',
        'codex_event_id',
        'request_id',
        'requestId',
        'call_id',
        'tool_call_id',
        'toolCallId',
        'mcp_tool_call_id',
        'mcpToolCallId',
        'id'
    ];

    for (const key of candidateKeys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }

    return null;
}

function extractToolCallId(params: Record<string, unknown>): string | null {
    const direct = extractToolCallIdFromRecord(params);
    if (direct) return direct;

    const nestedCandidates = [params.arguments, params.args, params.payload, params.data, params.request, params.input];
    for (const candidate of nestedCandidates) {
        if (!isObject(candidate)) continue;
        const nested = extractToolCallIdFromRecord(candidate);
        if (nested) return nested;
    }

    return null;
}

export function extractApprovalKind(params: Record<string, unknown>): CodexApprovalKind {
    const candidates: unknown[] = [params, params.request, params.payload, params.data];

    for (const candidate of candidates) {
        if (!isObject(candidate)) continue;
        const meta = isObject(candidate._meta) ? candidate._meta : null;
        const kind = meta && typeof meta.codex_approval_kind === 'string' ? meta.codex_approval_kind : null;
        if (kind === 'mcp_tool_call' || kind === 'exec_command') {
            return kind;
        }
    }

    return 'unknown';
}

export function extractApprovalToolDetails(params: Record<string, unknown>): { toolName: string | null; input: unknown } | null {
    const candidates: unknown[] = [params, params.request, params.payload, params.data];

    for (const candidate of candidates) {
        if (!isObject(candidate)) continue;

        const meta = isObject(candidate._meta) ? candidate._meta : null;
        if (!meta) {
            continue;
        }

        const toolTitle = normalizeText(meta.tool_title);
        const toolName = toolTitle ?? normalizeText(meta.tool_name) ?? normalizeText(meta.server_name);
        const toolParams = meta.tool_params ?? meta.arguments ?? meta.input;

        if (!toolName && toolParams === undefined) {
            continue;
        }

        return {
            toolName,
            input: toolParams ?? {}
        };
    }

    return null;
}

const COMMAND_KEYS = [
    'codex_command',
    'command',
    'cmd',
    'command_line',
    'commandLine',
    'shell_command',
    'shellCommand',
    'raw_command',
    'rawCommand',
    'argv',
    'args'
];

function extractCommandFromValue(value: unknown): string[] | null {
    if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value) {
            if (typeof item === 'string' && item.trim().length > 0) {
                parts.push(item);
                continue;
            }
            if (isObject(item)) {
                const candidate = normalizeText(item.text)
                    ?? normalizeText(item.value)
                    ?? normalizeText(item.arg)
                    ?? normalizeText(item.command)
                    ?? normalizeText(item.cmd);
                if (candidate) {
                    parts.push(candidate);
                }
            }
        }
        return parts.length > 0 ? parts : null;
    }

    const text = normalizeText(value);
    if (text) {
        return [text];
    }

    if (!isObject(value)) {
        return null;
    }

    for (const key of COMMAND_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            continue;
        }
        const extracted = extractCommandFromValue(value[key]);
        if (extracted) return extracted;
    }

    return null;
}

function extractCommand(params: Record<string, unknown>): string[] | null {
    const direct = extractCommandFromValue(params);
    if (direct) return direct;

    const nestedCandidates = [params.arguments, params.args, params.payload, params.data, params.request, params.input];
    for (const candidate of nestedCandidates) {
        const extracted = extractCommandFromValue(candidate);
        if (extracted) return extracted;
    }

    return null;
}

const CWD_KEYS = [
    'codex_cwd',
    'cwd',
    'workdir',
    'workDir',
    'working_directory',
    'workingDirectory'
];

function extractCwd(params: Record<string, unknown>): string | null {
    const direct = pickStringByKeys(params, CWD_KEYS);
    if (direct) return direct;

    const nestedCandidates = [params.arguments, params.args, params.payload, params.data, params.request, params.input];
    for (const candidate of nestedCandidates) {
        if (!isObject(candidate)) continue;
        const extracted = pickStringByKeys(candidate, CWD_KEYS);
        if (extracted) return extracted;
    }

    return null;
}

function pickStringByKeys(params: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(params, key)) {
            continue;
        }
        const value = normalizeText(params[key]);
        if (value) return value;
    }
    return null;
}

const PROMPT_KEYS = ['prompt', 'message', 'text'];
const DESCRIPTION_KEYS = ['title', 'description', 'label'];

function extractPrompt(params: Record<string, unknown>): { prompt: string | null; description: string | null } {
    const prompt = pickStringByKeys(params, PROMPT_KEYS);
    const description = pickStringByKeys(params, DESCRIPTION_KEYS);
    if (prompt || description) {
        return { prompt, description };
    }

    const nestedCandidates = [params.arguments, params.args, params.payload, params.data, params.request, params.input];
    for (const candidate of nestedCandidates) {
        if (!isObject(candidate)) continue;
        const nestedPrompt = pickStringByKeys(candidate, PROMPT_KEYS);
        const nestedDescription = pickStringByKeys(candidate, DESCRIPTION_KEYS);
        if (nestedPrompt || nestedDescription) {
            return { prompt: nestedPrompt, description: nestedDescription };
        }
    }

    return { prompt: null, description: null };
}

function truncateText(value: string, maxLen: number): string {
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen)}...`;
}

function stringifyForLog(value: unknown, maxLen = 2000): string {
    try {
        return truncateText(JSON.stringify(value), maxLen);
    } catch {
        return truncateText(String(value), maxLen);
    }
}

function pickEnumValue(
    values: string[],
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    approved: boolean
): string {
    const normalizedDecision = decision.toLowerCase();
    if (values.includes(decision)) {
        return decision;
    }
    if (values.includes(normalizedDecision)) {
        return normalizedDecision;
    }

    const normalizedValues = values.map((value) => value.toLowerCase());
    const approvedNeedles = ['allow', 'approve', 'approved', 'yes', 'true', 'accept', 'ok', 'confirm'];
    const deniedNeedles = ['deny', 'denied', 'no', 'false', 'reject', 'abort', 'cancel'];

    const matchNeedle = (needles: string[]) => {
        for (const needle of needles) {
            const idx = normalizedValues.findIndex((value) => value.includes(needle));
            if (idx >= 0) return values[idx];
        }
        return null;
    };

    const matched = approved ? matchNeedle(approvedNeedles) : matchNeedle(deniedNeedles);
    if (matched) return matched;

    return approved ? values[0] : values[values.length - 1];
}

function extractEnumValues(schema: Record<string, unknown>): string[] | null {
    if (Array.isArray(schema.enum)) {
        const values = schema.enum.filter((value) => typeof value === 'string' && value.length > 0);
        if (values.length > 0) return values;
    }

    const collectConsts = (options: unknown): string[] | null => {
        if (!Array.isArray(options)) return null;
        const values = options
            .map((opt) => (isObject(opt) && typeof opt.const === 'string' ? opt.const : null))
            .filter((value): value is string => Boolean(value));
        return values.length > 0 ? values : null;
    };

    const oneOfValues = collectConsts(schema.oneOf);
    if (oneOfValues) return oneOfValues;

    const anyOfValues = collectConsts(schema.anyOf);
    if (anyOfValues) return anyOfValues;

    return null;
}

function coerceValueForSchema(
    schema: unknown,
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    approved: boolean
): ElicitResponseValue | null {
    if (!isObject(schema)) {
        return null;
    }

    const enumValues = extractEnumValues(schema);
    if (enumValues) {
        return pickEnumValue(enumValues, decision, approved);
    }

    const schemaType = typeof schema.type === 'string' ? schema.type : null;
    if (schemaType === 'boolean') return approved;
    if (schemaType === 'number' || schemaType === 'integer') return approved ? 1 : 0;
    if (schemaType === 'string') return decision;
    if (schemaType === 'array') {
        const items = isObject(schema.items) ? schema.items : null;
        if (items) {
            const itemEnum = extractEnumValues(items);
            if (itemEnum) {
                return [pickEnumValue(itemEnum, decision, approved)];
            }
        }
        return [decision];
    }

    return null;
}

function buildElicitationContent(
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    requestedSchema: ElicitRequestedSchema | null,
    reason?: string
): ElicitContent {
    const approved = decision === 'approved' || decision === 'approved_for_session';

    if (requestedSchema?.properties && Object.keys(requestedSchema.properties).length > 0) {
        const content: Record<string, ElicitResponseValue> = {};
        const properties = requestedSchema.properties;
        const required = requestedSchema.required ?? [];

        for (const [key, schema] of Object.entries(properties)) {
            const isRequired = required.includes(key);
            const preferred = (() => {
                if (key === 'decision') return decision;
                if (key === 'approved' || key === 'allow' || key === 'confirm') return approved;
                if (key === 'reason' && reason) return reason;
                return null;
            })();

            if (preferred !== null) {
                const value = coerceValueForSchema(schema, decision, approved);
                content[key] = value ?? preferred;
                continue;
            }

            if (isRequired) {
                const value = coerceValueForSchema(schema, decision, approved);
                if (value !== null) {
                    content[key] = value;
                }
            }
        }

        for (const key of required) {
            if (Object.prototype.hasOwnProperty.call(content, key)) {
                continue;
            }
            const value = coerceValueForSchema(properties[key], decision, approved);
            if (value !== null) {
                content[key] = value;
            }
        }

        if (Object.keys(content).length === 0) {
            const fallbackKey = required[0] ?? Object.keys(properties)[0];
            if (fallbackKey) {
                const value = coerceValueForSchema(properties[fallbackKey], decision, approved);
                content[fallbackKey] = value ?? decision;
            }
        }

        return content;
    }

    const schemaType = requestedSchema?.type;
    if (schemaType === 'boolean') return approved;
    if (schemaType === 'string') return decision;
    if (schemaType === 'array') return [decision];
    if (schemaType === 'number' || schemaType === 'integer') return approved ? 1 : 0;

    const fallback: Record<string, ElicitResponseValue> = {
        decision,
        approved,
        allow: approved
    };
    if (reason) {
        fallback.reason = reason;
    }
    return fallback;
}

function buildElicitationResult(
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    requestedSchema: ElicitRequestedSchema | null,
    reason?: string
): {
    action: 'accept' | 'decline' | 'cancel';
    content?: ElicitContent;
    decision?: string;
    reason?: string;
} {
    const action: 'accept' | 'decline' | 'cancel' =
        decision === 'approved' || decision === 'approved_for_session'
            ? 'accept'
            : decision === 'abort'
                ? 'cancel'
                : 'decline';

    const content = buildElicitationContent(decision, requestedSchema, reason);
    return reason ? { action, content, decision, reason } : { action, content, decision };
}

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 */
function getCodexMcpCommand(): string {
    try {
        const resolvedCodex = resolveCodexBinary(process.env);
        const version = resolvedCodex.version ? `codex-cli ${resolvedCodex.version}` : '';
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) return 'mcp-server'; // Default to newer command if we can't parse

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        // Version >= 0.43.0-alpha.5 has mcp-server
        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            // Check for alpha version
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server'; // 0.43.0 stable has mcp-server
        }
        return 'mcp'; // Older versions use mcp
    } catch (error) {
        logger.debug('[CodexMCP] Error detecting codex version, defaulting to mcp-server:', error);
        return 'mcp-server'; // Default to newer command
    }
}

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;

    constructor() {
        this.client = new Client(
            { name: 'yoho-remote-codex-client', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        this.client.onerror = (error) => {
            logger.debug('[CodexMCP] Client error:', stringifyForLog({
                message: error.message,
                stack: error.stack
            }));
        };

        this.client.fallbackRequestHandler = async (request, _extra) => {
            logger.debug('[CodexMCP] Fallback request handler invoked:', stringifyForLog({
                method: request.method,
                id: request.id,
                params: request.params
            }));

            if (request.method === 'elicitation/create') {
                return this.handleElicitationRequest({
                    method: request.method,
                    params: (request.params ?? {}) as Record<string, unknown>
                });
            }

            throw new Error(`Unhandled MCP request method: ${request.method}`);
        };

        // Avoid TS instantiation depth issues by widening the schema type.
        const codexNotificationSchema: z.ZodTypeAny = z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough();

        const setNotificationHandler =
            this.client.setNotificationHandler.bind(this.client) as (
                schema: unknown,
                handler: (notification: { params: { msg: any } }) => void
            ) => void;

        setNotificationHandler(codexNotificationSchema, (data) => {
            const msg = data.params.msg;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const resolvedCodex = resolveCodexBinary(process.env);
        const mcpCommand = getCodexMcpCommand();
        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: ${resolvedCodex.command} ${mcpCommand}`);

        this.transport = new StdioClientTransport({
            command: resolvedCodex.command,
            args: [mcpCommand],
            env: Object.keys(resolvedCodex.env).reduce((acc, key) => {
                const value = resolvedCodex.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private registerPermissionHandlers(): void {
        const codexElicitationRequestSchema = z.object({
            method: z.literal('elicitation/create'),
            params: z.record(z.string(), z.unknown())
        }).passthrough();

        // Register handler for exec command approval requests
        (Protocol.prototype.setRequestHandler as unknown as (
            this: Client,
            requestSchema: z.ZodTypeAny,
            handler: (request: { method: 'elicitation/create'; params: Record<string, unknown> }) => Promise<unknown>
        ) => void).call(
            this.client,
            codexElicitationRequestSchema,
            async (request) => this.handleElicitationRequest(request)
        );

        const requestHandlerKeys = Array.from((((this.client as unknown as { _requestHandlers?: Map<string, unknown> })._requestHandlers) ?? new Map()).keys());
        logger.debug('[CodexMCP] Registered request handlers:', stringifyForLog(requestHandlerKeys));
        logger.debug('[CodexMCP] Permission handlers registered');
    }

    private async handleElicitationRequest(
        request: { method: 'elicitation/create'; params: Record<string, unknown> }
    ): Promise<ReturnType<typeof buildElicitationResult>> {
        const params = request.params as Record<string, unknown>;
        const requestedSchema = extractRequestedSchema(params);
        const approvalKind = extractApprovalKind(params);
        const toolDetails = extractApprovalToolDetails(params);

        logger.debug(
            '[CodexMCP] Elicitation request received:',
            stringifyForLog({
                method: request.method,
                paramsKeys: Object.keys(params),
                nestedRequestKeys: isObject(params.request) ? Object.keys(params.request) : [],
                approvalKind,
                requestedSchema,
                toolDetails
            })
        );

        const toolCallId = extractToolCallId(params) ?? randomUUID();
        const command = extractCommand(params);
        const cwd = extractCwd(params);
        const prompt = extractPrompt(params);
        const toolName = toolDetails?.toolName ?? 'CodexBash';

        if (!this.permissionHandler) {
            logger.debug('[CodexMCP] No permission handler set, denying by default');
            return buildElicitationResult('denied', requestedSchema, 'Permission handler not configured');
        }

        try {
            const input: Record<string, unknown> = approvalKind === 'mcp_tool_call'
                ? (isObject(toolDetails?.input) ? toolDetails.input as Record<string, unknown> : { input: toolDetails?.input ?? {} })
                : {
                    command: command ?? (prompt.prompt ? prompt.prompt : []),
                    cwd: cwd ?? ''
                };
            if (approvalKind !== 'mcp_tool_call') {
                if (prompt.prompt) {
                    input.prompt = prompt.prompt;
                }
                if (prompt.description) {
                    input.description = prompt.description;
                }
            }

            logger.debug(
                '[CodexMCP] Elicitation approval request prepared:',
                stringifyForLog({
                    toolCallId,
                    toolName,
                    approvalKind,
                    input
                })
            );

            const result = await this.permissionHandler.handleToolCall(
                toolCallId,
                toolName,
                input,
                { approvalKind }
            );

            logger.debug(
                '[CodexMCP] Permission result:',
                stringifyForLog({
                    toolCallId,
                    toolName,
                    approvalKind,
                    result
                })
            );

            const elicitationResult = buildElicitationResult(result.decision, requestedSchema, result.reason);
            logger.debug(
                '[CodexMCP] Elicitation response payload:',
                stringifyForLog({
                    toolCallId,
                    elicitationResult
                })
            );
            return elicitationResult;
        } catch (error) {
            logger.debug(
                '[CodexMCP] Error handling permission request:',
                stringifyForLog({
                    toolCallId,
                    toolName,
                    approvalKind,
                    error: error instanceof Error ? { message: error.message, stack: error.stack } : error
                })
            );
            const reason = error instanceof Error ? error.message : 'Permission request failed';
            const elicitationResult = buildElicitationResult('denied', requestedSchema, reason);
            logger.debug(
                '[CodexMCP] Elicitation denied payload after error:',
                stringifyForLog({
                    toolCallId,
                    elicitationResult
                })
            );
            return elicitationResult;
        }
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        // Ensure we have a valid connection
        await this.ensureConnected();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    private async ensureConnected(): Promise<void> {
        if (!this.connected) {
            await this.connect();
            return;
        }

        // Check if the transport is still alive
        if (this.transport) {
            const pid = this.transport.pid;
            if (pid && !isProcessAlive(pid)) {
                logger.warn('[CodexMCP] Transport process died, reconnecting...');
                this.connected = false;
                this.transport = null;
                await this.connect();
            }
        }
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        // Ensure we have a valid connection
        await this.ensureConnected();

        if (!this.sessionId) {
            throw new Error('No active session. Call startSession first.');
        }

        if (!this.conversationId) {
            // Some Codex deployments reuse the session ID as the conversation identifier
            this.conversationId = this.sessionId;
            logger.debug('[CodexMCP] conversationId missing, defaulting to sessionId:', this.conversationId);
        }

        const args = { sessionId: this.sessionId, conversationId: this.conversationId, prompt };
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }


    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const eventRecord = event as Record<string, unknown>;
        const eventType = typeof eventRecord.type === 'string' ? eventRecord.type : null;
        const payload = eventRecord.payload;

        const candidates: any[] = [eventRecord];
        if (eventRecord.data && typeof eventRecord.data === 'object') {
            candidates.push(eventRecord.data);
        }
        if (payload && typeof payload === 'object') {
            candidates.push(payload);
        }

        for (const candidate of candidates) {
            const sessionId = candidate.session_id
                ?? candidate.sessionId
                ?? (eventType === 'session_meta' ? candidate.id : null);
            if (sessionId) {
                this.sessionId = sessionId;
                logger.debug('[CodexMCP] Session ID extracted from event:', this.sessionId);
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (conversationId) {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
            }
        }
    }
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (meta.sessionId) {
            this.sessionId = meta.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        }

        if (meta.conversationId) {
            this.conversationId = meta.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        } else if (response?.conversationId) {
            this.conversationId = response.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.sessionId && item?.sessionId) {
                    this.sessionId = item.sessionId;
                    logger.debug('[CodexMCP] Session ID extracted from content:', this.sessionId);
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && item.conversationId) {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                }
            }
        }
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    hasActiveSession(): boolean {
        return this.sessionId !== null;
    }

    clearSession(): void {
        // Store the previous session ID before clearing for potential resume
        const previousSessionId = this.sessionId;
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous sessionId:', previousSessionId);
    }

    /**
     * Store the current session ID without clearing it, useful for abort handling
     */
    storeSessionForResume(): string | null {
        logger.debug('[CodexMCP] Storing session for potential resume:', this.sessionId);
        return this.sessionId;
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        // Capture pid in case we need to force-kill
        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            // Ask client to close the transport
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try { 
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.(); 
                logger.debug('[CodexMCP] transport.close done');
            } catch {}
        }

        // As a last resort, if child still exists, send SIGKILL
        if (pid) {
            if (isProcessAlive(pid)) {
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                await killProcess(pid, true);
            }
        }

        this.transport = null;
        this.connected = false;
        this.sessionId = null;
        this.conversationId = null;

        logger.debug('[CodexMCP] Disconnected');
    }
}
