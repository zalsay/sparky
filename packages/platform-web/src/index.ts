import type { PlatformClient } from '@sparky/platform-contract'
import {
  PlatformRequestError,
  type PlatformRequestErrorDetails,
} from '@sparky/shared'
import type {
  AppSettings,
  AttachmentInput,
  ChatMessage,
  ConversationMessagesResult,
  ConversationMeta,
  CreateConversationInput,
  EditMessageInput,
  GetMessagesInput,
  RenameConversationInput,
  ResendMessageInput,
  RuntimeInfo,
  SendMessageInput,
  StreamingEvent,
  TruncateMessagesInput,
  UpdateContextDividerInput,
  UpdateConversationPinInput,
  UploadedAttachment,
  UserProfile,
  Workspace,
  WorkspaceCapabilities,
} from '@sparky/shared'

type ImportMetaEnvShape = { env?: { VITE_API_BASE_URL?: string } }

type MessageMutationResponse = {
  messages: ChatMessage[]
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

async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  const form = new FormData()
  form.append('file', file)

  const response = await fetch(`${API_BASE}/api/chat/attachments`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    const body = await parseErrorBody(response)
    throw new PlatformRequestError({
      message: getErrorMessage('/api/chat/attachments', response, body),
      status: response.status,
      statusText: response.statusText,
      path: '/api/chat/attachments',
      body,
    })
  }

  return response.json() as Promise<UploadedAttachment>
}

function buildMessagesQuery(input?: GetMessagesInput): string {
  const params = new URLSearchParams()
  if (input?.limit) params.set('limit', String(input.limit))
  if (input?.before) params.set('before', input.before)
  const query = params.toString()
  return query ? `?${query}` : ''
}

function normalizeAttachmentInput(items?: AttachmentInput[]): AttachmentInput[] | undefined {
  if (!items?.length) return undefined
  return items.map((item) => ({ ...item }))
}

async function streamRequest(path: string, body: unknown, onEvent?: (event: StreamingEvent) => void): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorBody = await parseErrorBody(response)
    throw new PlatformRequestError({
      message: getErrorMessage(path, response, errorBody),
      status: response.status,
      statusText: response.statusText,
      path,
      body: errorBody,
    })
  }

  if (!response.body) {
    throw new Error('Streaming response body is unavailable')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const flushEvent = (block: string) => {
    const lines = block.split('\n')
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (eventName !== 'message' || dataLines.length === 0) return
    try {
      const payload = JSON.parse(dataLines.join('\n')) as StreamingEvent
      onEvent?.(payload)
    } catch {
      // ignore malformed events
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundaryIndex = buffer.indexOf('\n\n')
    while (boundaryIndex >= 0) {
      const block = buffer.slice(0, boundaryIndex)
      buffer = buffer.slice(boundaryIndex + 2)
      flushEvent(block)
      boundaryIndex = buffer.indexOf('\n\n')
    }
  }

  if (buffer.trim()) flushEvent(buffer)
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
      body: JSON.stringify({ ...input, attachments: normalizeAttachmentInput(input.attachments) }),
    }),
    uploadAttachment,
    streamMessage: (conversationId: string, input: SendMessageInput, handlers) => streamRequest(
      `/api/chat/sessions/${conversationId}/messages/stream`,
      { ...input, attachments: normalizeAttachmentInput(input.attachments) },
      handlers?.onEvent,
    ),
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
    updateContextDivider: (conversationId: string, messageId: string, input: UpdateContextDividerInput) => request<ChatMessage>(`/api/chat/sessions/${conversationId}/messages/${messageId}/divider`, {
      method: 'PUT',
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
