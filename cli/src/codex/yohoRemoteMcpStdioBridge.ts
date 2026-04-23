/**
 * YR MCP STDIO Bridge
 *
 * Proxies the full yoho-remote HTTP MCP server to a STDIO MCP server so Codex
 * can consume the same tool set as Claude.
 *
 * Configure the target HTTP MCP URL via env var `YR_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    type CallToolRequest,
    type ListToolsRequest,
    type ListToolsResult
} from '@modelcontextprotocol/sdk/types.js';

type YohoRemoteBridgeToolResult = Awaited<ReturnType<Client['callTool']>>

export interface YohoRemoteBridgeClient {
    listTools(params?: ListToolsRequest['params']): Promise<ListToolsResult>
    callTool(params: CallToolRequest['params']): Promise<YohoRemoteBridgeToolResult>
}

export function parseArgs(argv: string[]): { url: string | null } {
    let url: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--url' && i + 1 < argv.length) {
            url = argv[i + 1];
            i++;
        }
    }
    return { url };
}

function resolveHttpMcpAuthToken(): string | null {
    return process.env.YR_HTTP_MCP_AUTH_TOKEN?.trim()
        || process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN?.trim()
        || null;
}

export function createYohoRemoteMcpBridgeHandlers(
    ensureHttpClient: () => Promise<YohoRemoteBridgeClient>
): {
    listTools: (params?: ListToolsRequest['params']) => Promise<ListToolsResult>
    callTool: (params: CallToolRequest['params']) => Promise<YohoRemoteBridgeToolResult>
} {
    return {
        async listTools(params) {
            const client = await ensureHttpClient();
            return await client.listTools(params);
        },
        async callTool(params) {
            const client = await ensureHttpClient();
            const result = await client.callTool(params);
            return annotateYohoMcpToolResult(params.name, result);
        }
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function parseJsonText(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function unwrapResultPayload(result: YohoRemoteBridgeToolResult): unknown {
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    const textBlocks = content
        .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : null)
        .filter((text): text is string => Boolean(text));
    if (textBlocks.length === 0) return null;
    return parseJsonText(textBlocks.join('\n'));
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.flatMap(item => typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : [])
        : [];
}

function readConfidence(payload: Record<string, unknown>): number | null {
    const direct = readNumber(payload.confidence) ?? readNumber(payload.maxConfidence) ?? readNumber(payload.bestConfidence);
    if (direct !== null) return direct;
    for (const key of ['bestMatch', 'topMatch', 'match']) {
        const nested = payload[key];
        if (isRecord(nested)) {
            const nestedConfidence = readNumber(nested.confidence) ?? readNumber(nested.score);
            if (nestedConfidence !== null) return nestedConfidence;
        }
    }
    for (const key of ['matches', 'results', 'items']) {
        const values = payload[key];
        if (!Array.isArray(values)) continue;
        const confidences = values
            .map(item => isRecord(item) ? (readNumber(item.confidence) ?? readNumber(item.score)) : null)
            .filter((confidence): confidence is number => confidence !== null);
        if (confidences.length > 0) return Math.max(...confidences);
    }
    return null;
}

function readDeclaredResultCount(payload: Record<string, unknown>): number | null {
    return readNumber(payload.resultCount)
        ?? readNumber(payload.resultsCount)
        ?? readNumber(payload.count)
        ?? readNumber(payload.filesSearched)
        ?? readNumber(payload.files_searched);
}

function readScopeDecision(payload: Record<string, unknown>): { matched: boolean | null; unmatchedReasons: string[] } {
    const scope = isRecord(payload.scope) ? payload.scope : null;
    const matched = scope
        ? readBoolean(scope.matched) ?? readBoolean(scope.isMatched) ?? readBoolean(scope.is_match)
        : readBoolean(payload.scopeMatched) ?? readBoolean(payload.scope_matched);
    const unmatchedReasons = scope
        ? [
            ...readStringArray(scope.unmatchedReasons),
            ...readStringArray(scope.unmatched_reasons),
            ...readStringArray(scope.unmatched),
        ]
        : [
            ...readStringArray(payload.unmatchedScopeReasons),
            ...readStringArray(payload.unmatched_scope_reasons),
        ];
    return { matched, unmatchedReasons };
}

function buildConsumptionGate(toolName: string, payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload)) return null;

    if (toolName.endsWith('skill_search') || toolName === 'search') {
        const suggestedNextAction = readString(payload.suggestedNextAction) ?? readString(payload.suggested_next_action);
        const hasLocalMatch = readBoolean(payload.hasLocalMatch) ?? readBoolean(payload.has_local_match);
        const confidence = readConfidence(payload);
        const explicitDirectUseAllowed = readBoolean(payload.directUseAllowed) ?? readBoolean(payload.direct_use_allowed);
        const scope = readScopeDecision(payload);
        const directUseAllowed = explicitDirectUseAllowed === false
            ? false
            : scope.matched === false || scope.unmatchedReasons.length > 0
            ? false
            : (explicitDirectUseAllowed === true || suggestedNextAction === 'use_results')
            && hasLocalMatch === true
            && confidence !== null
            && confidence >= 0.65;
        return {
            kind: 'skill_search',
            directUseAllowed,
            suggestedNextAction,
            hasLocalMatch: hasLocalMatch ?? false,
            confidence,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
            reason: explicitDirectUseAllowed === false
                ? 'directUseAllowed=false，服务端明确禁止直接引用或自动 skill_get'
                : scope.matched === false
                ? 'skill_search scope.matched=false，不能直接引用或自动 skill_get'
                : scope.unmatchedReasons.length > 0
                ? `skill_search scope 不匹配：${scope.unmatchedReasons.join('；')}`
                : directUseAllowed
                ? 'use_results + hasLocalMatch + confidence 足够，可直接使用'
                : '不可直接引用，也不要自动 skill_get；请继续当前任务、换 query 或补 scope',
        };
    }

    if (toolName.endsWith('recall')) {
        const confidence = readConfidence(payload);
        const resultCount = readDeclaredResultCount(payload);
        const answer = readString(payload.answer) ?? readString(payload.summary) ?? readString(payload.content);
        const explicitDirectlyUsable = readBoolean(payload.isDirectlyUsable)
            ?? readBoolean(payload.is_directly_usable)
            ?? readBoolean(payload.directUseAllowed)
            ?? readBoolean(payload.direct_use_allowed);
        const scope = readScopeDecision(payload);
        const directUseAllowed = explicitDirectlyUsable !== false
            && scope.matched !== false
            && scope.unmatchedReasons.length === 0
            && Boolean(answer)
            && resultCount !== null
            && resultCount > 0
            && (confidence === null || confidence >= 0.5);
        return {
            kind: 'recall',
            directUseAllowed,
            confidence,
            resultCount,
            scopeMatched: scope.matched,
            unmatchedScopeReasons: scope.unmatchedReasons,
            reason: explicitDirectlyUsable === false
                ? 'isDirectlyUsable=false，服务端明确禁止直接注入为事实'
                : scope.matched === false
                ? 'recall scope.matched=false，不能自动注入为事实'
                : scope.unmatchedReasons.length > 0
                ? `recall scope 不匹配：${scope.unmatchedReasons.join('；')}`
                : resultCount === null
                ? 'recall 缺少 resultCount/filesSearched，不能确认结果数'
                : directUseAllowed
                ? 'recall 结果满足基础可靠性门槛；仍需按 scope 核对'
                : '低置信、0 结果或空 recall，不得自动注入为事实',
        };
    }

    return null;
}

function annotateYohoMcpToolResult(toolName: string, result: YohoRemoteBridgeToolResult): YohoRemoteBridgeToolResult {
    const payload = unwrapResultPayload(result);
    const gate = buildConsumptionGate(toolName, payload);
    if (!gate || !isRecord(result) || !Array.isArray(result.content)) {
        return result;
    }

    return {
        ...result,
        content: [
            ...result.content,
            {
                type: 'text' as const,
                text: JSON.stringify({ yohoConsumptionGate: gate }, null, 2),
            },
        ],
    };
}

export async function runYohoRemoteMcpStdioBridge(argv: string[]): Promise<void> {
    try {
        const { url: urlFromArgs } = parseArgs(argv);
        const baseUrl = urlFromArgs || process.env.YR_HTTP_MCP_URL || '';

        if (!baseUrl) {
            process.stderr.write(
                '[yr-mcp] Missing target URL. Set YR_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
            );
            process.exit(2);
        }

        let httpClient: Client | null = null;

        async function ensureHttpClient(): Promise<Client> {
            if (httpClient) {
                return httpClient;
            }

            const client = new Client(
                { name: 'yr-stdio-bridge', version: '1.0.0' },
                { capabilities: {} }
            );
            const orgId = process.env.YOHO_ORG_ID?.trim() || null;
            const authToken = resolveHttpMcpAuthToken();
            const headers: Record<string, string> = orgId ? { 'x-org-id': orgId } : {};
            if (authToken) {
                headers.authorization = `Bearer ${authToken}`;
            }
            const transport = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers } });
            await client.connect(transport);
            httpClient = client;
            return client;
        }

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient);
        const server = new Server(
            { name: 'YR MCP Bridge', version: '1.0.0' },
            { capabilities: { tools: { listChanged: true }, resources: {} } }
        );

        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            return await handlers.listTools(request.params);
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return await handlers.callTool(request.params);
        });

        // Return empty resources/templates to prevent Codex from hanging
        // on list_mcp_resources / list_mcp_resource_templates calls.
        // See https://github.com/openai/codex/issues/14242
        server.setRequestHandler(ListResourcesRequestSchema, async () => {
            return { resources: [] };
        });

        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
            return { resourceTemplates: [] };
        });

        const stdio = new StdioServerTransport();
        await server.connect(stdio);
    } catch (err) {
        try {
            process.stderr.write(`[yr-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
        } finally {
            process.exit(1);
        }
    }
}
