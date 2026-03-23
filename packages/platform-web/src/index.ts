import type { PlatformClient } from '@sparky/platform-contract'
import {
  PlatformRequestError,
  type PlatformRequestErrorDetails,
} from '@sparky/shared'
import type {
  AppSettings,
  ConversationMessagesResult,
  ConversationMeta,
  CreateConversationInput,
  EditMessageInput,
  GetMessagesInput,
  RenameConversationInput,
  ResendMessageInput,
  RuntimeInfo,
  SendMessageInput,
  TruncateMessagesInput,
  UpdateConversationPinInput,
  UserProfile,
  Workspace,
  WorkspaceCapabilities,
} from '@sparky/shared'

type ImportMetaEnvShape = { env?: { VITE_API_BASE_URL?: string } }

type MessageMutationResponse = {
  messages: { id: string; role: string; content: string; createdAt: string; conversationId: string }[]
}

const globalImportMeta = import.meta as unknown as ImportMetaEnvShape
const API_BASE = globalImportMeta.env?.VITE_API_BASE_URL ?? 'http://localhost:3010'

async function parseErrorBody(response: Response): Promise<PlatformRequestErrorDetails | string | undefined> {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    try {
      return await response.json() as PlatformRequestErrorDetails
    } catch {
      return undefined
    }
  }

  try {
    const text = await response.text()
    return text || undefined
  } catch {
    return undefined
  }
}

function getErrorMessage(path: string, response: Response, body?: PlatformRequestErrorDetails | string): string {
  if (typeof body === 'string' && body.trim()) {
    return body
  }

  if (body && typeof body === 'object') {
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message
    }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error
    }
  }

  const suffix = response.statusText ? ` ${response.statusText}` : ''
  return `Request failed (${response.status}${suffix}): ${path}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const body = await parseErrorBody(response)
    throw new PlatformRequestError({
      message: getErrorMessage(path, response, body),
      status: response.status,
      statusText: response.statusText,
      path,
      body,
    })
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

function buildMessagesQuery(input?: GetMessagesInput): string {
  const params = new URLSearchParams()
  if (input?.limit) params.set('limit', String(input.limit))
  if (input?.before) params.set('before', input.before)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export interface WebPlatformClientOptions {
  getUserProfile?: PlatformClient['getUserProfile']
  getWorkspaceCapabilities?: PlatformClient['getWorkspaceCapabilities']
}

export function createWebPlatformClient(options: WebPlatformClientOptions = {}): PlatformClient {
  return {
    getRuntime: () => request<RuntimeInfo>('/api/runtime'),
    getSettings: () => request<AppSettings>('/api/settings'),
    updateSettings: (input: AppSettings) => request<AppSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
    listWorkspaces: () => request<Workspace[]>('/api/workspaces'),
    listConversations: () => request<ConversationMeta[]>('/api/chat/sessions'),
    createConversation: (input: CreateConversationInput) => request<ConversationMeta>('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    renameConversation: (conversationId: string, input: RenameConversationInput) => request<ConversationMeta>(`/api/chat/sessions/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
    deleteConversation: (conversationId: string) => request<void>(`/api/chat/sessions/${conversationId}`, {
      method: 'DELETE',
    }),
    pinConversation: (conversationId: string, input: UpdateConversationPinInput) => request<ConversationMeta>(`/api/chat/sessions/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
    unpinConversation: (conversationId: string, input: UpdateConversationPinInput) => request<ConversationMeta>(`/api/chat/sessions/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
    getMessages: (conversationId: string, input?: GetMessagesInput) => request<ConversationMessagesResult>(`/api/chat/sessions/${conversationId}/messages${buildMessagesQuery(input ?? { limit: 50 })}`),
    refreshMessages: (conversationId: string, input?: GetMessagesInput) => request<ConversationMessagesResult>(`/api/chat/sessions/${conversationId}/messages${buildMessagesQuery(input ?? { limit: 50 })}`),
    loadMoreMessages: (conversationId: string, input: GetMessagesInput) => request<ConversationMessagesResult>(`/api/chat/sessions/${conversationId}/messages${buildMessagesQuery(input)}`),
    sendMessage: (conversationId: string, input: SendMessageInput) => request<MessageMutationResponse>(`/api/chat/sessions/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    editMessage: (conversationId: string, messageId: string, input: EditMessageInput) => request<MessageMutationResponse>(`/api/chat/sessions/${conversationId}/messages/${messageId}/edit`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
    resendMessage: (conversationId: string, input: ResendMessageInput) => request<MessageMutationResponse>(`/api/chat/sessions/${conversationId}/messages/resend`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    truncateMessages: (conversationId: string, input: TruncateMessagesInput) => request<ConversationMessagesResult>(`/api/chat/sessions/${conversationId}/messages/truncate`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    getUserProfile: options.getUserProfile ?? (async () => ({
      displayName: 'Sparky User',
    })),
    getWorkspaceCapabilities: options.getWorkspaceCapabilities ?? (async () => ({
      mcpServerCount: 0,
      skillCount: 0,
    })),
  }
}
