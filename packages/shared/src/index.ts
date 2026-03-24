export type ThemeMode = 'light' | 'dark' | 'system'

export type ProviderType = 'anthropic' | 'openai' | 'deepseek' | 'google' | 'moonshot' | 'zhipu' | 'minimax' | 'doubao' | 'qwen' | 'custom'

export interface ChannelModel {
  id: string
  name: string
  enabled: boolean
}

export interface Channel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  apiKey?: string
  models: ChannelModel[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ChannelCreateInput {
  name: string
  provider: ProviderType
  baseUrl: string
  apiKey: string
  models: ChannelModel[]
  enabled?: boolean
}

export interface ChannelUpdateInput {
  name?: string
  provider?: ProviderType
  baseUrl?: string
  apiKey?: string
  models?: ChannelModel[]
  enabled?: boolean
}

export interface ConversationModelSelection {
  channelId: string
  modelId: string
}

export interface PlatformRequestErrorDetails {
  error?: string
  message?: string
  code?: string
  details?: unknown
}

export class PlatformRequestError extends Error {
  status: number
  statusText: string
  path: string
  body?: PlatformRequestErrorDetails | string
  code?: string
  details?: unknown

  constructor(input: {
    message: string
    status: number
    statusText: string
    path: string
    body?: PlatformRequestErrorDetails | string
  }) {
    super(input.message)
    this.name = 'PlatformRequestError'
    this.status = input.status
    this.statusText = input.statusText
    this.path = input.path
    this.body = input.body
    if (input.body && typeof input.body === 'object') {
      this.code = input.body.code
      this.details = input.body.details
    }
  }
}

export interface AppSettings {
  themeMode: ThemeMode
  onboardingCompleted: boolean
  environmentCheckSkipped: boolean
  notificationsEnabled: boolean
  agentChannelId?: string
  agentModelId?: string
}

export interface RuntimeInfo {
  service: string
  version: string
  environment: string
  database: {
    configured: boolean
    status: 'connected' | 'disconnected'
  }
  agentControlPlane: {
    enabled: boolean
    runnerCount: number
    defaultRunnerStatus: AgentRunnerStatus
  }
}

export type AgentRunnerStatus = 'unknown' | 'healthy' | 'unreachable'

export type AgentSessionStatus =
  | 'creating'
  | 'starting'
  | 'running'
  | 'connecting'
  | 'stopped'
  | 'closing'
  | 'restarting'
  | 'error'

export interface AgentRunnerInfo {
  id: string
  baseUrl: string
  status: AgentRunnerStatus
  version?: string
  lastHeartbeatAt?: string
  lastError?: string
}

export interface AgentSession {
  id: string
  workspaceId: string
  name: string
  channelId?: string
  modelId?: string
  status: AgentSessionStatus
  runnerId: string
  transport: 'http'
  createdAt: string
  updatedAt: string
  connectedAt?: string
  lastError?: string
}

export interface CreateAgentSessionInput {
  workspaceId: string
  name: string
  channelId: string
  modelId: string
}

export interface ConnectAgentSessionInput {
  conversationId?: string
}

export interface AgentSessionConnection {
  sessionId: string
  conversationId?: string
  connectedAt: string
}

export interface AgentSessionActionResult {
  session: AgentSession
}

export interface AgentSessionListResult {
  sessions: AgentSession[]
  activeSessionId?: string
}

export interface Workspace {
  id: string
  name: string
  rootPath: string
  createdAt: string
  updatedAt: string
  lastOpenedAt?: string
}

export interface ConversationMeta {
  id: string
  title: string
  modelId?: string
  channelId?: string
  pinned?: boolean
  createdAt: string
  updatedAt: string
}

export interface UserProfile {
  displayName: string
  email?: string
}

export interface WorkspaceCapabilities {
  mcpServerCount: number
  skillCount: number
}

export type ChatMessageRole = 'user' | 'assistant' | 'system'
export type ChatMessageStatus = 'loading' | 'partial' | 'done' | 'error'
export type ChatMessageKind = 'text' | 'tool_result' | 'context_divider'

export interface Attachment {
  id: string
  name: string
  mimeType: string
  size: number
  url?: string
  status?: 'pending' | 'ready' | 'error'
}

export interface UploadedAttachment extends Attachment {
  url: string
  status: 'ready'
}

export interface AttachmentInput {
  id?: string
  name: string
  mimeType: string
  size: number
  url?: string
}

export interface ToolInvocation {
  id: string
  name: string
  status?: 'pending' | 'running' | 'success' | 'error'
  input?: string
}

export interface ToolResult {
  invocationId?: string
  name: string
  status: 'success' | 'error'
  output: string
}

export interface ContextDivider {
  id: string
  title: string
  content?: string
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: ChatMessageRole
  content: string
  createdAt: string
  status?: ChatMessageStatus
  kind?: ChatMessageKind
  attachments?: Attachment[]
  toolInvocation?: ToolInvocation
  toolResult?: ToolResult
  contextDivider?: ContextDivider
}

export interface StreamingMessageDelta {
  messageId: string
  content: string
  status: ChatMessageStatus
}

export type StreamingEvent =
  | { type: 'start'; conversationId: string; message: ChatMessage }
  | { type: 'delta'; conversationId: string; delta: StreamingMessageDelta }
  | { type: 'done'; conversationId: string; message: ChatMessage }
  | { type: 'error'; conversationId: string; error: string }

export interface StreamMessageHandlers {
  onEvent?: (event: StreamingEvent) => void
}

export interface ConversationMessagesResult {
  messages: ChatMessage[]
  hasMore: boolean
  total: number
}

export interface CreateConversationInput {
  title?: string
  modelId?: string
  channelId?: string
}

export interface RenameConversationInput {
  title: string
}

export interface UpdateConversationPinInput {
  pinned: boolean
}

export interface GetMessagesInput {
  limit?: number
  before?: string
}

export interface SendMessageInput {
  content: string
  modelId?: string
  channelId?: string
  attachments?: AttachmentInput[]
}

export interface EditMessageInput {
  content: string
}

export interface ResendMessageInput {
  messageId: string
}

export interface TruncateMessagesInput {
  messageId: string
}

export interface UpdateContextDividerInput {
  title: string
  content?: string
}
