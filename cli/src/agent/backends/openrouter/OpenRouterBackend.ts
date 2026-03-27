import type {
    AgentBackend,
    AgentMessage,
    AgentSessionConfig,
    HistoryMessage,
    PermissionRequest,
    PermissionResponse,
    PromptContent
} from '@/agent/types';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

type OpenRouterSession = {
    id: string;
    config: AgentSessionConfig;
    model: string;
    messages: ChatMessage[];
    abortController: AbortController | null;
};

export class OpenRouterBackend implements AgentBackend {
    private readonly defaultModel: string;
    private readonly apiKey: string;
    private readonly sessions = new Map<string, OpenRouterSession>();

    constructor(defaultModel: string, apiKey: string) {
        this.defaultModel = defaultModel;
        this.apiKey = apiKey;
    }

    async initialize(): Promise<void> {
        logger.debug(`[OpenRouter] Initialized with default model: ${this.defaultModel}`);
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        const sessionId = randomUUID();
        // Allow model override via config metadata
        const model = (config as { model?: string }).model || this.defaultModel;

        const session: OpenRouterSession = {
            id: sessionId,
            config,
            model,
            messages: [
                {
                    role: 'system',
                    content: this.buildSystemPrompt(config.cwd)
                }
            ],
            abortController: null
        };
        this.sessions.set(sessionId, session);
        logger.debug(`[OpenRouter] Created session: ${sessionId} with model: ${model}`);
        return sessionId;
    }

    private buildSystemPrompt(cwd: string): string {
        return `You are OpenRouter, an AI pair programming assistant. You help users with coding tasks.

Current working directory: ${cwd}

You are an expert programmer. You help the user with their coding tasks by:
1. Understanding their requirements
2. Suggesting code changes
3. Explaining technical concepts
4. Debugging issues
5. Writing new code

When suggesting code changes, be specific about file paths and show the exact changes needed.
Always explain your reasoning and approach.`;
    }

    async prompt(
        sessionId: string,
        content: PromptContent[],
        onUpdate: (msg: AgentMessage) => void
    ): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }

        const userMessage = content.map(c => c.text).join('\n');
        session.messages.push({ role: 'user', content: userMessage });

        session.abortController = new AbortController();

        try {
            const response = await fetch(OPENROUTER_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://yoho.run',
                    'X-Title': 'Yoho Remote OpenRouter'
                },
                body: JSON.stringify({
                    model: session.model,
                    messages: session.messages,
                    max_tokens: 8192,
                    temperature: 0.7,
                    stream: true
                }),
                signal: session.abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
            }

            if (!response.body) {
                throw new Error('No response body');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let contentText = '';
            let reasoningText = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6).trim();
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0]?.delta;
                            const contentDelta = typeof choice?.content === 'string' ? choice.content : '';
                            const reasoningDelta = typeof choice?.reasoning_content === 'string' ? choice.reasoning_content : '';

                            if (reasoningDelta) {
                                reasoningText += reasoningDelta;
                            }
                            if (contentDelta) {
                                contentText += contentDelta;
                                // Stream text updates
                                onUpdate({ type: 'text', text: contentDelta });
                            }
                        } catch {
                            // Skip invalid JSON
                        }
                    }
                }
            }

            if (reasoningText) {
                // Send reasoning at the end if present
                onUpdate({ type: 'reasoning', text: reasoningText });
            }

            const finalContent = contentText || reasoningText;
            if (finalContent) {
                session.messages.push({ role: 'assistant', content: finalContent });
            }
            onUpdate({ type: 'turn_complete', stopReason: 'end_turn' });

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                onUpdate({ type: 'turn_complete', stopReason: 'cancelled' });
                return;
            }
            const message = error instanceof Error ? error.message : 'Unknown error';
            onUpdate({ type: 'error', message });
            throw error;
        } finally {
            session.abortController = null;
        }
    }

    async cancelPrompt(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session?.abortController) {
            session.abortController.abort();
            logger.debug(`[OpenRouter] Cancelled prompt for session: ${sessionId}`);
        }
    }

    async respondToPermission(
        _sessionId: string,
        _request: PermissionRequest,
        _response: PermissionResponse
    ): Promise<void> {
        // OpenRouter API doesn't use permissions
    }

    onPermissionRequest(_handler: (request: PermissionRequest) => void): void {
        // OpenRouter API doesn't use permissions
    }

    async disconnect(): Promise<void> {
        for (const session of this.sessions.values()) {
            if (session.abortController) {
                session.abortController.abort();
            }
        }
        this.sessions.clear();
        logger.debug('[OpenRouter] Disconnected');
    }

    restoreHistory(sessionId: string, messages: HistoryMessage[]): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.debug(`[OpenRouter] Cannot restore history: session not found: ${sessionId}`);
            return;
        }

        for (const msg of messages) {
            session.messages.push({
                role: msg.role,
                content: msg.content
            });
        }
        logger.debug(`[OpenRouter] Restored ${messages.length} history messages for session: ${sessionId}`);
    }

    // Method to change model mid-session
    setModel(sessionId: string, model: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.model = model;
            logger.debug(`[OpenRouter] Changed model to ${model} for session: ${sessionId}`);
        }
    }

    // Get current model for a session
    getModel(sessionId: string): string | null {
        const session = this.sessions.get(sessionId);
        return session?.model ?? null;
    }

    // Get default model
    getDefaultModel(): string {
        return this.defaultModel;
    }
}
