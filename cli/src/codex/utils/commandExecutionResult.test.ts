import { describe, expect, it } from 'vitest';
import { buildCommandExecutionResult, getCommandExecutionPreview } from './commandExecutionResult';

describe('commandExecutionResult', () => {
    it('preserves extra command execution fields from codex events', () => {
        const result = buildCommandExecutionResult({
            id: 'item-1',
            type: 'command_execution',
            status: 'completed',
            command: 'printf hello',
            exit_code: 0,
            aggregated_output: 'hello'
        });

        expect(result).toEqual({
            command: 'printf hello',
            exit_code: 0,
            aggregated_output: 'hello'
        });
    });

    it('uses aggregated output as preview when output is missing', () => {
        const preview = getCommandExecutionPreview({
            id: 'item-2',
            type: 'command_execution',
            command: 'printf hello',
            exit_code: 0,
            aggregated_output: 'hello-from-codex'
        });

        expect(preview).toBe('hello-from-codex');
    });

    it('extracts preview text from content blocks', () => {
        const preview = getCommandExecutionPreview({
            id: 'item-3',
            type: 'command_execution',
            command: 'printf hello',
            exit_code: 0,
            content: [{ type: 'text', text: 'hello-from-content' }]
        });

        expect(preview).toBe('hello-from-content');
    });
});
