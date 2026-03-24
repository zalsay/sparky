import { ClaudeRuntimeAdapter } from './claude-runtime.js';
export class SessionManager {
    runtime;
    sessions = new Map();
    constructor(runtime = new ClaudeRuntimeAdapter()) {
        this.runtime = runtime;
    }
    async createSession(input) {
        const session = await this.runtime.startSession(input);
        this.sessions.set(session.id, session);
        return { session };
    }
    getSession(id) {
        return this.sessions.get(id);
    }
    async connectSession(id, input) {
        const session = this.mustGetSession(id);
        if (session.status !== 'running') {
            throw new SessionActionError(409, 'agent session action is not allowed in current status');
        }
        const result = await this.runtime.connectSession(session, input);
        this.sessions.set(id, result.session);
        return result;
    }
    async sendMessage(id, input) {
        const session = this.mustGetSession(id);
        if (session.status !== 'running') {
            throw new SessionActionError(409, 'agent session action is not allowed in current status');
        }
        const result = await this.runtime.sendMessage(session, input);
        this.sessions.set(id, result.session);
        return result;
    }
    async streamMessage(id, input) {
        const session = this.mustGetSession(id);
        if (session.status !== 'running') {
            throw new SessionActionError(409, 'agent session action is not allowed in current status');
        }
        const result = await this.runtime.streamMessage(session, input);
        this.sessions.set(id, result.session);
        return result;
    }
    async *streamMessageEvents(id, input) {
        const session = this.mustGetSession(id);
        if (session.status !== 'running') {
            throw new SessionActionError(409, 'agent session action is not allowed in current status');
        }
        if (!this.runtime.streamMessageEvents) {
            const result = await this.runtime.streamMessage(session, input);
            this.sessions.set(id, result.session);
            for (const chunk of result.chunks) {
                yield { chunk };
            }
            yield { done: true, updatedAt: result.session.updatedAt };
            return;
        }
        let updatedAt = session.updatedAt;
        for await (const event of this.runtime.streamMessageEvents(session, input)) {
            if (event.updatedAt) {
                updatedAt = event.updatedAt;
                this.sessions.set(id, { ...this.mustGetSession(id), updatedAt, lastError: undefined });
            }
            yield event;
        }
    }
    async closeSession(id) {
        const session = this.mustGetSession(id);
        if (session.status !== 'running') {
            throw new SessionActionError(409, 'agent session action is not allowed in current status');
        }
        const updated = await this.runtime.stopSession(session);
        this.sessions.set(id, updated);
        return { session: updated };
    }
    async restartSession(id) {
        const session = this.mustGetSession(id);
        if (session.status !== 'stopped' && session.status !== 'error') {
            throw new SessionActionError(409, 'agent session action is not allowed in current status');
        }
        const updated = await this.runtime.restartSession(session);
        this.sessions.set(id, updated);
        return { session: updated };
    }
    mustGetSession(id) {
        const session = this.sessions.get(id);
        if (!session) {
            throw new SessionActionError(404, 'agent session not found');
        }
        return session;
    }
}
export class SessionActionError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'SessionActionError';
    }
}
