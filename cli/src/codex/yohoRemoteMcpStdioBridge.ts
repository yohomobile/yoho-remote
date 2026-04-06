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
            return await client.callTool(params);
        }
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
            const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
            await client.connect(transport);
            httpClient = client;
            return client;
        }

        const handlers = createYohoRemoteMcpBridgeHandlers(ensureHttpClient);
        const server = new Server(
            { name: 'YR MCP Bridge', version: '1.0.0' },
            { capabilities: { tools: { listChanged: true } } }
        );

        server.setRequestHandler(ListToolsRequestSchema, async (request) => {
            return await handlers.listTools(request.params);
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return await handlers.callTool(request.params);
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
