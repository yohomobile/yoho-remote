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
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getBrainSessionPreferencesFromMetadata, type BrainSessionPreferences } from '@/utils/brainSessionPreferences'

interface StartYohoRemoteServerOptions {
    sessionSource?: string
    sessionCaller?: string
    apiClient?: ApiClient
    machineId?: string
    yohoRemoteSessionId?: string
    workingDirectory?: string
    brainPreferences?: BrainSessionPreferences | null
}

export async function startYohoRemoteServer(client: ApiSessionClient, options?: StartYohoRemoteServerOptions) {
    const metadata = client.getMetadata()
    const apiClient = options?.apiClient
    const yohoRemoteSessionId = options?.yohoRemoteSessionId
    const resolvedSessionSource = options?.sessionSource ?? metadata?.source
    const resolvedSessionCaller = options?.sessionCaller ?? metadata?.caller
    const resolvedMachineId = options?.machineId ?? metadata?.machineId

    logger.debug(`[yrMCP] startYohoRemoteServer: sessionSource=${resolvedSessionSource}, sessionCaller=${resolvedSessionCaller}, clientSessionId=${client.sessionId}`)
    const workingDirectory = options?.workingDirectory ?? process.cwd()
    const brainPreferences = options?.brainPreferences ?? getBrainSessionPreferencesFromMetadata(metadata)
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
    if (resolvedSessionCaller !== 'feishu') {
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
    if (apiClient && yohoRemoteSessionId) {
        const { registerProjectTools } = await import('./projectTools');
        registerProjectTools(mcp, toolNames, {
            apiClient,
            sessionId: yohoRemoteSessionId,
        });

        const { registerSessionTools } = await import('./sessionTools');
        registerSessionTools(mcp, toolNames, {
            apiClient,
            sessionId: yohoRemoteSessionId,
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
                cwd: workingDirectory,
                nodeVersion: process.version,
                cliVersion: packageJson.version,
                sessionId: yohoRemoteSessionId ?? client.sessionId ?? null,
                sessionSource: resolvedSessionSource ?? null,
            }
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }],
            }
        })
        toolNames.push('environment_info')
    }

    // Register push_download tool when apiClient is available (not for Feishu — files go via <feishu-actions>)
    if (apiClient && yohoRemoteSessionId && resolvedSessionCaller !== 'feishu') {
        const api = apiClient
        const sessionId = yohoRemoteSessionId
        mcp.registerTool<any, any>('push_download', {
            title: 'Push Download File',
            description: 'Push a file to the remote frontend so the user can download it. Accepts either a disk file path or text content directly.',
            inputSchema: z.object({
                path: z.string().optional().describe('Absolute path to a file on disk. Takes priority over content if both are provided.'),
                filename: z.string().optional().describe('Filename shown to user (required when using content, optional when using path).'),
                content: z.string().optional().describe('Text content to push as a file (use with filename). Ignored if path is provided.'),
                mimeType: z.string().optional().describe('MIME type override. Auto-detected from extension if omitted.'),
            }),
        }, async (args: { path?: string; filename?: string; content?: string; mimeType?: string }) => {
            try {
                let base64: string
                let filename: string
                let mimeType = args.mimeType

                if (args.path) {
                    const buf = await readFile(args.path)
                    base64 = buf.toString('base64')
                    filename = args.filename || basename(args.path)
                } else if (args.content !== undefined && args.filename) {
                    base64 = Buffer.from(args.content).toString('base64')
                    filename = args.filename
                } else {
                    return {
                        content: [{ type: 'text' as const, text: 'Error: provide either path, or both filename and content.' }],
                        isError: true,
                    }
                }

                if (!mimeType) {
                    const ext = extname(filename).slice(1).toLowerCase()
                    const mimeMap: Record<string, string> = {
                        txt: 'text/plain', md: 'text/markdown', json: 'application/json',
                        csv: 'text/csv', html: 'text/html', xml: 'application/xml',
                        pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
                        jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
                        zip: 'application/zip', gz: 'application/gzip',
                        js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python',
                        sh: 'text/x-sh', yaml: 'text/yaml', yml: 'text/yaml',
                        toml: 'text/toml', sql: 'text/x-sql', log: 'text/plain',
                    }
                    mimeType = mimeMap[ext] ?? 'application/octet-stream'
                }

                const result = await api.pushDownloadFile(sessionId, { filename, content: base64, mimeType })
                return {
                    content: [{ type: 'text' as const, text: `File "${result.filename}" pushed successfully (${result.size} bytes, id: ${result.id}). The user can now download it from the interface.` }],
                }
            } catch (error: any) {
                logger.debug('[yrMCP] push_download error:', error.message)
                return {
                    content: [{ type: 'text' as const, text: `Failed to push file: ${error.response?.data?.error ?? error.message}` }],
                    isError: true,
                }
            }
        })
        toolNames.push('push_download')
    }

    // Register Brain tools when source is 'brain'
    if (resolvedSessionSource === 'brain' && apiClient && resolvedMachineId && yohoRemoteSessionId) {
        const { registerBrainTools } = await import('./brainTools');
        registerBrainTools(mcp, toolNames, {
            apiClient,
            machineId: resolvedMachineId,
            brainSessionId: yohoRemoteSessionId,
            brainPreferences,
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
