import { ClaudeRuntimeAdapter } from './claude-runtime.js'
import type {
  ConnectRunnerSessionInput,
  CreateRunnerSessionInput,
  ClaudeRuntimeStreamEvent,
  RunnerMessageInput,
  RunnerMessageResult,
  RunnerMessageStreamResult,
  RunnerSessionActionResult,
  RunnerSessionConnectionResult,
  RunnerSessionRecord,
} from './types.js'

type RuntimeAdapter = Pick<ClaudeRuntimeAdapter, 'startSession' | 'connectSession' | 'sendMessage' | 'streamMessage' | 'stopSession' | 'restartSession'> & {
  streamMessageEvents?: (session: RunnerSessionRecord, input: RunnerMessageInput) => AsyncGenerator<ClaudeRuntimeStreamEvent>
}

export class SessionManager {
  private readonly runtime: RuntimeAdapter
  private readonly sessions = new Map<string, RunnerSessionRecord>()

  constructor(runtime: RuntimeAdapter = new ClaudeRuntimeAdapter()) {
    this.runtime = runtime
  }

  async createSession(input: CreateRunnerSessionInput): Promise<RunnerSessionActionResult> {
    const session = await this.runtime.startSession(input)
    this.sessions.set(session.id, session)
    return { session }
  }

  getSession(id: string): RunnerSessionRecord | undefined {
    return this.sessions.get(id)
  }

  async connectSession(id: string, input: ConnectRunnerSessionInput): Promise<RunnerSessionConnectionResult> {
    const session = this.mustGetSession(id)
    if (session.status !== 'running') {
      throw new SessionActionError(409, 'agent session action is not allowed in current status')
    }
    const result = await this.runtime.connectSession(session, input)
    this.sessions.set(id, result.session)
    return result
  }

  async sendMessage(id: string, input: RunnerMessageInput): Promise<RunnerMessageResult> {
    const session = this.mustGetSession(id)
    if (session.status !== 'running') {
      throw new SessionActionError(409, 'agent session action is not allowed in current status')
    }
    const result = await this.runtime.sendMessage(session, input)
    this.sessions.set(id, result.session)
    return result
  }

  async streamMessage(id: string, input: RunnerMessageInput): Promise<RunnerMessageStreamResult> {
    const session = this.mustGetSession(id)
    if (session.status !== 'running') {
      throw new SessionActionError(409, 'agent session action is not allowed in current status')
    }
    const result = await this.runtime.streamMessage(session, input)
    this.sessions.set(id, result.session)
    return result
  }

  async *streamMessageEvents(id: string, input: RunnerMessageInput): AsyncGenerator<ClaudeRuntimeStreamEvent> {
    const session = this.mustGetSession(id)
    if (session.status !== 'running') {
      throw new SessionActionError(409, 'agent session action is not allowed in current status')
    }
    if (!this.runtime.streamMessageEvents) {
      const result = await this.runtime.streamMessage(session, input)
      this.sessions.set(id, result.session)
      for (const chunk of result.chunks) {
        yield { chunk }
      }
      yield { done: true, updatedAt: result.session.updatedAt }
      return
    }

    let updatedAt = session.updatedAt
    for await (const event of this.runtime.streamMessageEvents(session, input)) {
      if (event.updatedAt) {
        updatedAt = event.updatedAt
        this.sessions.set(id, { ...this.mustGetSession(id), updatedAt, lastError: undefined })
      }
      yield event
    }
  }

  async closeSession(id: string): Promise<RunnerSessionActionResult> {
    const session = this.mustGetSession(id)
    if (session.status !== 'running') {
      throw new SessionActionError(409, 'agent session action is not allowed in current status')
    }
    const updated = await this.runtime.stopSession(session)
    this.sessions.set(id, updated)
    return { session: updated }
  }

  async restartSession(id: string): Promise<RunnerSessionActionResult> {
    const session = this.mustGetSession(id)
    if (session.status !== 'stopped' && session.status !== 'error') {
      throw new SessionActionError(409, 'agent session action is not allowed in current status')
    }
    const updated = await this.runtime.restartSession(session)
    this.sessions.set(id, updated)
    return { session: updated }
  }

  private mustGetSession(id: string): RunnerSessionRecord {
    const session = this.sessions.get(id)
    if (!session) {
      throw new SessionActionError(404, 'agent session not found')
    }
    return session
  }
}

export class SessionActionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'SessionActionError'
  }
}
