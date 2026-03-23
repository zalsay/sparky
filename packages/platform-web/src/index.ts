import type { PlatformClient } from '@sparky/platform-contract'
import type {
  AppSettings,
  ConversationMessagesResult,
  ConversationMeta,
  CreateConversationInput,
  RuntimeInfo,
  SendMessageInput,
  UserProfile,
  Workspace,
  WorkspaceCapabilities,
} from '@sparky/shared'

type ImportMetaEnvShape = { env?: { VITE_API_BASE_URL?: string } }

const globalImportMeta = import.meta as unknown as ImportMetaEnvShape
const API_BASE = globalImportMeta.env?.VITE_API_BASE_URL ?? 'http://localhost:8080'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

export function createWebPlatformClient(): PlatformClient {
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
    getMessages: (conversationId: string) => request<ConversationMessagesResult>(`/api/chat/sessions/${conversationId}/messages?limit=50`),
    sendMessage: (conversationId: string, input: SendMessageInput) => request<{ messages: { id: string; role: string; content: string; createdAt: string; conversationId: string }[] }>(`/api/chat/sessions/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    getUserProfile: async () => ({
      displayName: 'Sparky User',
    }),
    getWorkspaceCapabilities: async () => ({
      mcpServerCount: 0,
      skillCount: 0,
    }),
  }
}
