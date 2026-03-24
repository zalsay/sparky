export type RunnerStatus = 'unknown' | 'healthy' | 'unreachable'

export type RunnerSessionStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'connecting'
  | 'stopped'
  | 'closing'
  | 'restarting'
  | 'error'

export interface RunnerSessionRecord {
  id: string
  workspaceId: string
  name: string
  channelId?: string
  modelId?: string
  status: RunnerSessionStatus
  runnerId: string
  transport: 'http'
  createdAt: string
  updatedAt: string
  connectedAt?: string
  lastError?: string
}

export interface RunnerClaudeRuntimeConfig {
  apiKey: string
  baseUrl?: string
  modelId: string
}

export interface CreateRunnerSessionInput {
  workspaceId: string
  name: string
  channelId: string
  modelId: string
  runtimeConfig: RunnerClaudeRuntimeConfig
}

export interface ConnectRunnerSessionInput {
  conversationId?: string
}

export interface RunnerStreamChunk {
  content: string
  status: 'partial' | 'done'
}

export interface RunnerMessageInput {
  content: string
}

export interface RunnerMessageResult {
  session: RunnerSessionRecord
  message: {
    role: 'assistant'
    content: string
  }
}

export interface RunnerMessageStreamResult {
  session: RunnerSessionRecord
  chunks: RunnerStreamChunk[]
}

export interface ClaudeRuntimeStreamEvent {
  chunk?: RunnerStreamChunk
  done?: boolean
  updatedAt?: string
}

export interface RunnerSessionActionResult {
  session: RunnerSessionRecord
}

export interface RunnerSessionConnectionResult {
  session: RunnerSessionRecord
  connection: {
    sessionId: string
    conversationId?: string
    connectedAt: string
  }
}

export interface RunnerHealthResponse {
  status: RunnerStatus
  service: string
  version: string
  sdkReady: boolean
  lastError?: string
  checkedAt: string
}

export interface ClaudeRuntimeSessionHandle {
  id: string
  workspaceId: string
  startedAt: string
  sdkSessionId?: string
  stop(): Promise<void>
  connect(input: ConnectRunnerSessionInput): Promise<{ connectedAt: string }>
  sendMessage(input: RunnerMessageInput): Promise<{ content: string; updatedAt: string }>
  streamMessage(input: RunnerMessageInput): Promise<{ chunks: RunnerStreamChunk[]; updatedAt: string }>
  streamMessageEvents?(input: RunnerMessageInput): AsyncGenerator<ClaudeRuntimeStreamEvent>
  restart(): Promise<void>
}
