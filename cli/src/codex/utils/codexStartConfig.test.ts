import { describe, expect, it } from 'vitest';
import { buildCodexStartConfig } from './codexStartConfig';

describe('buildCodexStartConfig', () => {
    const mcpServers = { yoho_remote: { command: 'node', args: ['mcp'] } };

    it('applies CLI overrides when permission mode is default', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'default' },
            first: true,
            mcpServers,
            cliOverrides: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
        });

        expect(config.sandbox).toBe('danger-full-access');
        expect(config['approval-policy']).toBe('never');
        expect(config.config).toEqual({ mcp_servers: mcpServers });
    });

    it('ignores CLI overrides when permission mode is not default', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'yolo' },
            first: false,
            mcpServers,
            cliOverrides: { sandbox: 'read-only', approvalPolicy: 'never' }
        });

        expect(config.sandbox).toBe('danger-full-access');
        expect(config['approval-policy']).toBe('on-failure');
    });

    it('passes model when provided', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'default', model: 'o3' },
            first: false,
            mcpServers
        });

        expect(config.model).toBe('o3');
    });

    it('defaults service tier to fast', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'default' },
            first: false,
            mcpServers
        });

        expect(config.service_tier).toBe('fast');
    });

    it('applies explicit service tier overrides even outside default permission mode', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'yolo' },
            first: false,
            mcpServers,
            cliOverrides: { serviceTier: 'flex' }
        });

        expect(config.service_tier).toBe('flex');
    });

    it('normalizes Yoho MCP tool names for Codex prompts', () => {
        const config = buildCodexStartConfig({
            message: '先调用 `mcp__yoho_remote__environment_info`，再看 `mcp__yoho_remote__project_list`，必要时调用 `mcp__yoho-memory__recall` 和 `mcp__yoho-credentials__get_credential`',
            mode: { permissionMode: 'default' },
            first: false,
            mcpServers
        });

        expect(config.prompt).toContain('functions.yoho_remote__environment_info');
        expect(config.prompt).toContain('functions.yoho_remote__project_list');
        expect(config.prompt).toContain('functions.yoho_memory__recall');
        expect(config.prompt).toContain('functions.yoho_credentials__get_credential');
    });

    it('merges extra config overrides into the exec config payload', () => {
        const config = buildCodexStartConfig({
            message: 'hello',
            mode: { permissionMode: 'yolo' },
            first: false,
            mcpServers,
            developerInstructions: 'Brain session only',
            configOverrides: {
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
            },
        });

        expect(config.config).toEqual({
            mcp_servers: {
                yoho_remote: {
                    command: 'node',
                    args: ['mcp'],
                    required: true,
                },
            },
            developer_instructions: 'Brain session only',
            features: {
                multi_agent: false,
                shell_tool: false,
            },
            web_search: 'live',
        });
    });
});
