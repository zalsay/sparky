import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
class AgentSdkSessionHandle {
    id;
    workspaceId;
    channelId;
    modelId;
    apiKey;
    baseUrl;
    startedAt;
    sdkSessionId;
    constructor(id, workspaceId, channelId, modelId, apiKey, baseUrl, startedAt) {
        this.id = id;
        this.workspaceId = workspaceId;
        this.channelId = channelId;
        this.modelId = modelId;
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.startedAt = startedAt;
    }
    async initialize(name) {
        const result = await runAgentQuery({
            prompt: `Initialize agent session \"${name}\" for workspace ${this.workspaceId}. Stay ready for future work.`,
            workspaceId: this.workspaceId,
            modelId: this.modelId,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
        });
        this.sdkSessionId = result.sessionId;
    }
    async stop() {
        return;
    }
    async connect(_input) {
        if (this.sdkSessionId) {
            const result = await runAgentQuery({
                prompt: 'Reconnect to the existing agent runtime session and stay ready for future work.',
                workspaceId: this.workspaceId,
                modelId: this.modelId,
                apiKey: this.apiKey,
                baseUrl: this.baseUrl,
                sessionId: this.sdkSessionId,
            });
            this.sdkSessionId = result.sessionId ?? this.sdkSessionId;
        }
        return { connectedAt: new Date().toISOString() };
    }
    async sendMessage(input) {
        const result = await runAgentQuery({
            prompt: input.content,
            workspaceId: this.workspaceId,
            modelId: this.modelId,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            sessionId: this.sdkSessionId,
        });
        this.sdkSessionId = result.sessionId ?? this.sdkSessionId;
        return {
            content: result.assistantText || '',
            updatedAt: new Date().toISOString(),
        };
    }
    async streamMessage(input) {
        const result = await runAgentQuery({
            prompt: input.content,
            workspaceId: this.workspaceId,
            modelId: this.modelId,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            sessionId: this.sdkSessionId,
        });
        this.sdkSessionId = result.sessionId ?? this.sdkSessionId;
        return {
            chunks: result.chunks,
            updatedAt: new Date().toISOString(),
        };
    }
    async *streamMessageEvents(input) {
        let updatedAt = new Date().toISOString();
        const result = await runAgentQuery({
            prompt: input.content,
            workspaceId: this.workspaceId,
            modelId: this.modelId,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
            sessionId: this.sdkSessionId,
            onStreamEvent: async (event) => {
                if (event.updatedAt) {
                    updatedAt = event.updatedAt;
                }
                await Promise.resolve();
            },
        });
        this.sdkSessionId = result.sessionId ?? this.sdkSessionId;
        for (const chunk of result.chunks) {
            yield { chunk };
        }
        yield { done: true, updatedAt };
    }
    async restart() {
        const result = await runAgentQuery({
            prompt: 'Restart the agent runtime session and stay ready for future work.',
            workspaceId: this.workspaceId,
            modelId: this.modelId,
            apiKey: this.apiKey,
            baseUrl: this.baseUrl,
        });
        this.sdkSessionId = result.sessionId;
    }
}
function getWorkspaceRoot(workspaceId) {
    const baseRoot = process.env.PROMA_WORKSPACE_ROOT || process.cwd();
    return path.resolve(baseRoot, workspaceId);
}
function getRunnerId() {
    return process.env.PROMA_AGENT_RUNNER_ID || 'default';
}
async function runAgentQuery(input) {
    const cwd = getWorkspaceRoot(input.workspaceId);
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousBaseURL = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_API_KEY = input.apiKey;
    if (input.baseUrl) {
        process.env.ANTHROPIC_BASE_URL = input.baseUrl;
    }
    else {
        delete process.env.ANTHROPIC_BASE_URL;
    }
    const stream = query({
        prompt: input.prompt,
        options: {
            cwd,
            model: input.modelId,
            permissionMode: 'bypassPermissions',
            allowedTools: ['Read', 'Glob', 'Grep'],
            maxTurns: 1,
            resume: input.sessionId,
        },
    });
    let discoveredSessionID = input.sessionId;
    let assistantText = '';
    const chunks = [];
    try {
        for await (const message of stream) {
            if (!discoveredSessionID && message && typeof message === 'object' && 'session_id' in message && typeof message.session_id === 'string') {
                discoveredSessionID = message.session_id;
            }
            if (!discoveredSessionID && message && typeof message === 'object' && 'sessionId' in message && typeof message.sessionId === 'string') {
                discoveredSessionID = message.sessionId;
            }
            if (message && typeof message === 'object' && 'type' in message && message.type === 'assistant' && 'message' in message) {
                const text = extractAssistantText(message.message);
                if (text) {
                    assistantText += text;
                    const chunk = { content: text, status: 'partial' };
                    chunks.push(chunk);
                    await input.onStreamEvent?.({ chunk });
                }
            }
            if (message && typeof message === 'object' && 'type' in message && message.type === 'result' && 'result' in message && typeof message.result === 'string') {
                assistantText += message.result;
                if (message.result) {
                    const chunk = { content: message.result, status: 'partial' };
                    chunks.push(chunk);
                    await input.onStreamEvent?.({ chunk });
                }
            }
        }
    }
    catch (error) {
        throw new Error(error instanceof Error ? error.message : 'failed to initialize Claude Agent SDK session');
    }
    finally {
        if (previousApiKey === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
        }
        else {
            process.env.ANTHROPIC_API_KEY = previousApiKey;
        }
        if (previousBaseURL === undefined) {
            delete process.env.ANTHROPIC_BASE_URL;
        }
        else {
            process.env.ANTHROPIC_BASE_URL = previousBaseURL;
        }
    }
    const normalizedText = assistantText.trim();
    const normalizedChunks = chunks.length === 0
        ? [{ content: normalizedText, status: 'done' }]
        : chunks.map((chunk, index) => ({
            ...chunk,
            status: index === chunks.length - 1 ? 'done' : 'partial',
        }));
    if (input.onStreamEvent) {
        if (chunks.length === 0) {
            await input.onStreamEvent({ chunk: normalizedChunks[0] });
        }
        else {
            const lastChunk = normalizedChunks[normalizedChunks.length - 1];
            if (lastChunk) {
                lastChunk.status = 'done';
            }
        }
        await input.onStreamEvent({ done: true, updatedAt: new Date().toISOString() });
    }
    return { sessionId: discoveredSessionID, assistantText: normalizedText, chunks: normalizedChunks };
}
function extractAssistantText(message) {
    if (!message || typeof message !== 'object' || !("content" in message)) {
        return '';
    }
    const content = message.content;
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((item) => {
        if (!item || typeof item !== 'object') {
            return '';
        }
        if ('text' in item && typeof item.text === 'string') {
            return item.text;
        }
        return '';
    })
        .filter(Boolean)
        .join('');
}
export class ClaudeRuntimeAdapter {
    handles = new Map();
    async startSession(input) {
        const sessionId = randomUUID();
        const now = new Date().toISOString();
        const handle = new AgentSdkSessionHandle(sessionId, input.workspaceId, input.channelId, input.modelId, input.runtimeConfig.apiKey, input.runtimeConfig.baseUrl, now);
        await handle.initialize(input.name);
        this.handles.set(sessionId, handle);
        return {
            id: sessionId,
            workspaceId: input.workspaceId,
            name: input.name,
            status: 'running',
            runnerId: getRunnerId(),
            transport: 'http',
            createdAt: now,
            updatedAt: now,
        };
    }
    async connectSession(session, input) {
        const handle = this.mustGetHandle(session.id);
        const { connectedAt } = await handle.connect(input);
        return {
            session: {
                ...session,
                status: 'running',
                connectedAt,
                updatedAt: connectedAt,
                lastError: undefined,
            },
            connection: {
                sessionId: session.id,
                conversationId: input.conversationId,
                connectedAt,
            },
        };
    }
    async sendMessage(session, input) {
        const handle = this.mustGetHandle(session.id);
        const { content, updatedAt } = await handle.sendMessage(input);
        return {
            session: {
                ...session,
                status: 'running',
                updatedAt,
                lastError: undefined,
            },
            message: {
                role: 'assistant',
                content,
            },
        };
    }
    async streamMessage(session, input) {
        const handle = this.mustGetHandle(session.id);
        const { chunks, updatedAt } = await handle.streamMessage(input);
        return {
            session: {
                ...session,
                status: 'running',
                updatedAt,
                lastError: undefined,
            },
            chunks,
        };
    }
    async *streamMessageEvents(session, input) {
        const handle = this.mustGetHandle(session.id);
        if (!handle.streamMessageEvents) {
            const result = await this.streamMessage(session, input);
            for (const chunk of result.chunks) {
                yield { chunk };
            }
            yield { done: true, updatedAt: result.session.updatedAt };
            return;
        }
        for await (const event of handle.streamMessageEvents(input)) {
            yield event;
        }
    }
    async stopSession(session) {
        const handle = this.mustGetHandle(session.id);
        await handle.stop();
        this.handles.delete(session.id);
        return {
            ...session,
            status: 'stopped',
            updatedAt: new Date().toISOString(),
            lastError: undefined,
        };
    }
    async restartSession(session) {
        const handle = this.mustGetHandle(session.id);
        await handle.restart();
        return {
            ...session,
            status: 'running',
            updatedAt: new Date().toISOString(),
            lastError: undefined,
        };
    }
    hasActiveHandles() {
        return this.handles.size > 0;
    }
    mustGetHandle(sessionId) {
        const handle = this.handles.get(sessionId);
        if (!handle) {
            throw new Error('runner session handle not found');
        }
        return handle;
    }
}
