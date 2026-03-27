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

const NIM_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_API_KEY = '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';

type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

type NimSession = {
    id: string;
    config: AgentSessionConfig;
    messages: ChatMessage[];
    abortController: AbortController | null;
};

export class NimBackend implements AgentBackend {
    private readonly model: string;
    private readonly sessions = new Map<string, NimSession>();
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;

    constructor(model: string) {
        this.model = model;
    }

    async initialize(): Promise<void> {
        logger.debug(`[NIM] Initialized with model: ${this.model}`);
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        const sessionId = randomUUID();
        const session: NimSession = {
            id: sessionId,
            config,
            messages: [
                {
                    role: 'system',
                    content: `You are a helpful AI assistant. Current working directory: ${config.cwd}`
                }
            ],
            abortController: null
        };
        this.sessions.set(sessionId, session);
        logger.debug(`[NIM] Created session: ${sessionId}`);
        return sessionId;
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
            const response = await fetch(NIM_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${NIM_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'User-Agent': 'yoho-remote/nim'
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: session.messages,
                    max_tokens: 4096,
                    temperature: 0.7,
                    top_p: 0.95,
                    stream: true
                }),
                signal: session.abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`NIM API error: ${response.status} ${errorText}`);
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
                            }
                        } catch {
                            // Skip invalid JSON
                        }
                    }
                }
            }

            const finalContent = contentText.length > 0 ? contentText : reasoningText;
            if (reasoningText && contentText) {
                onUpdate({ type: 'reasoning', text: reasoningText });
            }
            if (finalContent) {
                onUpdate({ type: 'text', text: finalContent });
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
            logger.debug(`[NIM] Cancelled prompt for session: ${sessionId}`);
        }
    }

    async respondToPermission(
        _sessionId: string,
        _request: PermissionRequest,
        _response: PermissionResponse
    ): Promise<void> {
        // NIM API doesn't use permissions
    }

    onPermissionRequest(handler: (request: PermissionRequest) => void): void {
        this.permissionHandler = handler;
    }

    async disconnect(): Promise<void> {
        for (const session of this.sessions.values()) {
            if (session.abortController) {
                session.abortController.abort();
            }
        }
        this.sessions.clear();
        logger.debug('[NIM] Disconnected');
    }

    restoreHistory(sessionId: string, messages: HistoryMessage[]): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.debug(`[NIM] Cannot restore history: session not found: ${sessionId}`);
            return;
        }

        for (const msg of messages) {
            session.messages.push({
                role: msg.role,
                content: msg.content
            });
        }
        logger.debug(`[NIM] Restored ${messages.length} history messages for session: ${sessionId}`);
    }
}
