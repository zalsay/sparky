import { SessionManager } from './session-manager.js'
import type {
  ClaudeRuntimeStreamEvent,
  RunnerMessageResult,
  RunnerMessageStreamResult,
  RunnerSessionActionResult,
  RunnerSessionConnectionResult,
  RunnerSessionRecord,
} from './types.js'

async function run(): Promise<void> {
  const connectCalls: Array<string | undefined> = []

  const runtime = {
    async startSession(input: { workspaceId: string; name: string; channelId: string; modelId: string; runtimeConfig: { apiKey: string; baseUrl?: string; modelId: string } }): Promise<RunnerSessionRecord> {
      return {
        id: 'session-1',
        workspaceId: input.workspaceId,
        name: input.name,
        channelId: input.channelId,
        modelId: input.modelId,
        status: 'running',
        runnerId: 'default',
        transport: 'http',
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:00:00.000Z',
      }
    },
    async connectSession(session: { id: string }, _input: { conversationId?: string }): Promise<RunnerSessionConnectionResult> {
      connectCalls.push(session.id)
      return {
        session: {
          id: session.id,
          workspaceId: 'workspace-test',
          name: 'Default Agent',
          status: 'running',
          runnerId: 'default',
          transport: 'http',
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:01:00.000Z',
          connectedAt: '2026-03-24T00:01:00.000Z',
        },
        connection: {
          sessionId: session.id,
          connectedAt: '2026-03-24T00:01:00.000Z',
        },
      }
    },
    async sendMessage(session: { id: string }, input: { content: string }): Promise<RunnerMessageResult> {
      return {
        session: {
          id: session.id,
          workspaceId: 'workspace-test',
          name: 'Default Agent',
          status: 'running',
          runnerId: 'default',
          transport: 'http',
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:01:30.000Z',
          connectedAt: '2026-03-24T00:01:00.000Z',
        },
        message: {
          role: 'assistant',
          content: `reply:${input.content}`,
        },
      }
    },
    async streamMessage(session: { id: string }, input: { content: string }): Promise<RunnerMessageStreamResult> {
      return {
        session: {
          id: session.id,
          workspaceId: 'workspace-test',
          name: 'Default Agent',
          status: 'running',
          runnerId: 'default',
          transport: 'http',
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:01:45.000Z',
          connectedAt: '2026-03-24T00:01:00.000Z',
        },
        chunks: [
          { content: 'reply:', status: 'partial' },
          { content: input.content, status: 'done' },
        ],
      }
    },
    async *streamMessageEvents(session: { id: string }, input: { content: string }): AsyncGenerator<ClaudeRuntimeStreamEvent> {
      yield { chunk: { content: 'reply:', status: 'partial' } }
      yield { chunk: { content: input.content, status: 'done' } }
      yield { done: true, updatedAt: '2026-03-24T00:01:45.000Z' }
    },
    async stopSession(session: { id: string }): Promise<RunnerSessionRecord> {
      return {
        id: session.id,
        workspaceId: 'workspace-test',
        name: 'Default Agent',
        status: 'stopped',
        runnerId: 'default',
        transport: 'http',
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:02:00.000Z',
      }
    },
    async restartSession(session: { id: string }): Promise<RunnerSessionRecord> {
      return {
        id: session.id,
        workspaceId: 'workspace-test',
        name: 'Default Agent',
        status: 'running',
        runnerId: 'default',
        transport: 'http',
        createdAt: '2026-03-24T00:00:00.000Z',
        updatedAt: '2026-03-24T00:03:00.000Z',
      }
    },
  }

  const manager = new SessionManager(runtime)

  const created = await manager.createSession({
    workspaceId: 'workspace-test',
    name: 'Default Agent',
    channelId: 'channel-1',
    modelId: 'claude-sonnet-4-6',
    runtimeConfig: {
      apiKey: 'test-key',
      modelId: 'claude-sonnet-4-6',
    },
  })
  if (created.session.status !== 'running') {
    throw new Error('expected created session to be running')
  }

  const connected = await manager.connectSession(created.session.id, { conversationId: 'conversation-1' })
  if (connected.connection.sessionId !== created.session.id) {
    throw new Error('expected connect to keep session id')
  }

  const message = await manager.sendMessage(created.session.id, { content: 'hello' })
  if (message.message.content !== 'reply:hello') {
    throw new Error('expected sendMessage to return runtime reply')
  }

  const streamed = await manager.streamMessage(created.session.id, { content: 'hello' })
  if (streamed.chunks.length !== 2 || streamed.chunks[1]?.status !== 'done') {
    throw new Error('expected streamMessage to return partial and done chunks')
  }

  const streamedEvents: string[] = []
  for await (const event of manager.streamMessageEvents(created.session.id, { content: 'hello' })) {
    if (event.chunk) {
      streamedEvents.push(`${event.chunk.status}:${event.chunk.content}`)
    }
  }
  if (streamedEvents.join('|') !== 'partial:reply:|done:hello') {
    throw new Error(`expected streamMessageEvents to yield relayed chunks, got ${streamedEvents.join('|')}`)
  }

  const closed = await manager.closeSession(created.session.id)
  if (closed.session.status !== 'stopped') {
    throw new Error('expected closed session to be stopped')
  }

  const restarted = await manager.restartSession(created.session.id)
  if (restarted.session.status !== 'running') {
    throw new Error('expected restarted session to be running')
  }

  if (connectCalls.length !== 1 || connectCalls[0] !== created.session.id) {
    throw new Error('expected runtime connect to be called once')
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
