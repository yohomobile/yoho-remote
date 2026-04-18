import { describe, expect, it } from 'vitest'

import { __testOnly, extractApprovalKind, extractApprovalToolDetails } from './codexMcpClient'

describe('codexMcpClient approval helpers', () => {
    it('extracts mcp tool approval metadata', () => {
        const params = {
            _meta: {
                codex_approval_kind: 'mcp_tool_call',
                tool_title: 'Recall',
                tool_params: {
                    input: 'query',
                    maxFiles: 5
                }
            }
        }

        expect(extractApprovalKind(params)).toBe('mcp_tool_call')
        expect(extractApprovalToolDetails(params)).toEqual({
            toolName: 'Recall',
            input: {
                input: 'query',
                maxFiles: 5
            }
        })
    })

    it('falls back to unknown when approval kind is missing', () => {
        expect(extractApprovalKind({})).toBe('unknown')
        expect(extractApprovalToolDetails({})).toBeNull()
    })

    it('extracts approval metadata from nested elicitation request payload', () => {
        const params = {
            request: {
                mode: 'form',
                _meta: {
                    codex_approval_kind: 'mcp_tool_call',
                    tool_title: 'Recall',
                    tool_params: {
                        input: 'nested query',
                        maxFiles: 10
                    }
                }
            }
        }

        expect(extractApprovalKind(params)).toBe('mcp_tool_call')
        expect(extractApprovalToolDetails(params)).toEqual({
            toolName: 'Recall',
            input: {
                input: 'nested query',
                maxFiles: 10
            }
        })
    })

    it('builds elicitation content from structured ask_user_question answers', () => {
        const result = __testOnly.buildElicitationResult(
            'approved',
            {
                type: 'object',
                properties: {
                    '0': { type: 'string' },
                    '1': { type: 'array', items: { type: 'string' } },
                },
                required: ['0', '1'],
            },
            undefined,
            {
                '0': ['A'],
                '1': ['X', 'Y'],
            }
        )

        expect(result).toEqual({
            action: 'accept',
            content: {
                '0': 'A',
                '1': ['X', 'Y'],
            },
            decision: 'approved',
        })
    })
})
