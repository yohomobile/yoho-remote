import { AgentRegistry } from '@/agent/AgentRegistry';

export function registerOpenCodeAgent(): void {
    AgentRegistry.register('opencode', () => {
        throw new Error('OpenCode agent is not available in this build.');
    });
}
