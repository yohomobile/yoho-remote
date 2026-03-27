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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';

// Try to load API key from credentials file or environment variable
function loadGrokApiKey(): string {
    // First check environment variable
    if (process.env.GROK_API_KEY) {
        return process.env.GROK_API_KEY;
    }

    // Try to load from credentials file
    const credentialPaths = [
        join(homedir(), 'happy/yoho-task-v2/data/credentials/grok/default.json'),
        join(homedir(), '.config/grok/credentials.json'),
        join(homedir(), '.grok/credentials.json')
    ];

    for (const credPath of credentialPaths) {
        try {
            if (existsSync(credPath)) {
                const content = readFileSync(credPath, 'utf-8');
                const creds = JSON.parse(content);
                if (creds.apiKey) {
                    logger.debug(`[Grok] Loaded API key from ${credPath}`);
                    return creds.apiKey;
                }
            }
        } catch (error) {
            logger.debug(`[Grok] Failed to load credentials from ${credPath}:`, error);
        }
    }

    logger.debug('[Grok] No API key found in environment or credentials files');
    return '';
}

// Load model from credentials file or environment variable
function loadGrokModel(): string {
    // First check environment variable
    if (process.env.GROK_MODEL) {
        return process.env.GROK_MODEL;
    }

    // Try to load from credentials file
    const credPath = join(homedir(), 'happy/yoho-task-v2/data/credentials/grok/default.json');
    try {
        if (existsSync(credPath)) {
            const content = readFileSync(credPath, 'utf-8');
            const creds = JSON.parse(content);
            if (creds.model) {
                return creds.model;
            }
        }
    } catch {
        // Ignore errors
    }

    return 'grok-code-fast-1';
}

const GROK_API_KEY = loadGrokApiKey();
const DEFAULT_MODEL = loadGrokModel();

type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

type GrokSession = {
    id: string;
    config: AgentSessionConfig;
    messages: ChatMessage[];
    abortController: AbortController | null;
};

export class GrokBackend implements AgentBackend {
    private readonly model: string;
    private readonly sessions = new Map<string, GrokSession>();
    private permissionHandler: ((request: PermissionRequest) => void) | null = null;

    constructor(model: string = DEFAULT_MODEL) {
        this.model = model;
    }

    async initialize(): Promise<void> {
        if (!GROK_API_KEY) {
            throw new Error('Grok API key not configured. Set GROK_API_KEY environment variable or create credentials file at ~/happy/yoho-task-v2/data/credentials/grok/default.json');
        }
        logger.debug(`[Grok] Initialized with model: ${this.model}`);
    }

    async newSession(config: AgentSessionConfig): Promise<string> {
        const sessionId = randomUUID();
        const session: GrokSession = {
            id: sessionId,
            config,
            messages: [
                {
                    role: 'system',
                    content: `You are a helpful AI coding assistant powered by Grok. Current working directory: ${config.cwd}

You help users with software engineering tasks including:
- Writing and reviewing code
- Debugging issues
- Explaining code and concepts
- Refactoring and optimizing code
- Answering technical questions

Be concise, accurate, and helpful.`
                }
            ],
            abortController: null
        };
        this.sessions.set(sessionId, session);
        logger.debug(`[Grok] Created session: ${sessionId}`);
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
            const response = await fetch(GROK_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GROK_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'User-Agent': 'yoho-remote/grok'
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: session.messages,
                    max_tokens: 8192,
                    temperature: 0.7,
                    stream: true
                }),
                signal: session.abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Grok API error: ${response.status} ${errorText}`);
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
                            // Grok reasoning models may include reasoning_content
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
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`[Grok] Prompt error: ${message}`, error instanceof Error ? error.stack : '');
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
            logger.debug(`[Grok] Cancelled prompt for session: ${sessionId}`);
        }
    }

    async respondToPermission(
        _sessionId: string,
        _request: PermissionRequest,
        _response: PermissionResponse
    ): Promise<void> {
        // Grok API doesn't use permissions
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
        logger.debug('[Grok] Disconnected');
    }

    restoreHistory(sessionId: string, messages: HistoryMessage[]): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            logger.debug(`[Grok] Cannot restore history: session not found: ${sessionId}`);
            return;
        }

        for (const msg of messages) {
            session.messages.push({
                role: msg.role,
                content: msg.content
            });
        }
        logger.debug(`[Grok] Restored ${messages.length} history messages for session: ${sessionId}`);
    }
}
