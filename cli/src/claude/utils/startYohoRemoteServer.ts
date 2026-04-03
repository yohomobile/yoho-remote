/**
 * YR MCP server
 * Provides yoho-remote CLI specific tools including chat session title management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import os from "node:os";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { ApiClient } from "@/api/api";
import { randomUUID } from "node:crypto";
import { configuration } from "@/configuration";
import packageJson from "../../../package.json";

interface StartYohoRemoteServerOptions {
    sessionSource?: string
    sessionCaller?: string
    apiClient?: ApiClient
    machineId?: string
    yohoRemoteSessionId?: string
}

export async function startYohoRemoteServer(client: ApiSessionClient, options?: StartYohoRemoteServerOptions) {
    logger.debug(`[yrMCP] startYohoRemoteServer: sessionSource=${options?.sessionSource}, clientSessionId=${client.sessionId}`)
    // Handler that sends title updates via the client
    const handler = async (title: string) => {
        logger.debug('[yrMCP] Changing title to:', title);
        try {
            // Send title as a summary message, similar to title generator
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    //
    // Create the MCP server
    //

    const mcp = new McpServer({
        name: "YR MCP",
        version: "1.0.0",
    });

    const toolNames: string[] = []

    // Feishu Brain sessions don't need change_title (title is set server-side)
    if (options?.sessionCaller !== 'feishu') {
        const changeTitleInputSchema: z.ZodTypeAny = z.object({
            title: z.string().describe('The new title for the chat session'),
        });

        mcp.registerTool<any, any>('change_title', {
            description: 'Change the title of the current chat session',
            title: 'Change Chat Title',
            inputSchema: changeTitleInputSchema,
        }, async (args: { title: string }) => {
            const response = await handler(args.title);
            logger.debug('[yrMCP] Response:', response);

            if (response.success) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Successfully changed chat title to: "${args.title}"`,
                        },
                    ],
                    isError: false,
                };
            } else {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                        },
                    ],
                    isError: true,
                };
            }
        });
        toolNames.push('change_title')
    }

    // Register Project + Session tools for all sessions with apiClient
    if (options?.apiClient && options.yohoRemoteSessionId) {
        const { registerProjectTools } = await import('./projectTools');
        registerProjectTools(mcp, toolNames, {
            apiClient: options.apiClient,
            sessionId: options.yohoRemoteSessionId,
            machineId: options.machineId,
        });

        const { registerSessionTools } = await import('./sessionTools');
        registerSessionTools(mcp, toolNames, {
            apiClient: options.apiClient,
            sessionId: options.yohoRemoteSessionId,
        });

        logger.debug('[yrMCP] Project + Session tools registered');
    }

    // Register environment_info tool (local info, no API call needed)
    {
        mcp.registerTool<any, any>('environment_info', {
            title: 'Environment Info',
            description: 'Get current execution environment information: machine name, public IP, alias, platform, session ID, working directory, and more.',
            inputSchema: z.object({}),
        }, async () => {
            const info = {
                machineId: options?.machineId ?? null,
                hostname: os.hostname(),
                displayName: process.env.YOHO_MACHINE_NAME ?? null,
                publicIp: process.env.YOHO_MACHINE_IP ?? null,
                platform: os.platform(),
                arch: os.arch(),
                user: process.env.USER ?? null,
                shell: process.env.SHELL ?? null,
                homeDir: os.homedir(),
                yohoRemoteHomeDir: configuration.yohoRemoteHomeDir,
                serverUrl: configuration.serverUrl,
                cwd: process.cwd(),
                nodeVersion: process.version,
                cliVersion: packageJson.version,
                sessionId: options?.yohoRemoteSessionId ?? client.sessionId ?? null,
                sessionSource: options?.sessionSource ?? null,
            }
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
            }
        })
        toolNames.push('environment_info')
    }

    // Register Brain tools when source is 'brain'
    if (options?.sessionSource === 'brain' && options.apiClient && options.machineId && options.yohoRemoteSessionId) {
        const { registerBrainTools } = await import('./brainTools');
        registerBrainTools(mcp, toolNames, {
            apiClient: options.apiClient,
            machineId: options.machineId,
            brainSessionId: options.yohoRemoteSessionId,
        });
        logger.debug('[yrMCP] Brain tools registered');
    }

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });
    await mcp.connect(transport);

    //
    // Create the HTTP server
    //

    const server = createServer(async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    return {
        url: baseUrl.toString(),
        toolNames,
        stop: () => {
            logger.debug('[yrMCP] Stopping server');
            mcp.close();
            server.close();
        }
    }
}
