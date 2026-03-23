export type ThemeMode = 'light' | 'dark' | 'system'

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

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
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
