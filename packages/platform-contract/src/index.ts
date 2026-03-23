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

export interface PlatformClient {
  getRuntime(): Promise<RuntimeInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(input: AppSettings): Promise<AppSettings>
  listWorkspaces(): Promise<Workspace[]>
  listConversations(): Promise<ConversationMeta[]>
  createConversation(input: CreateConversationInput): Promise<ConversationMeta>
  getMessages(conversationId: string): Promise<ConversationMessagesResult>
  sendMessage(conversationId: string, input: SendMessageInput): Promise<{ messages: { id: string; role: string; content: string; createdAt: string; conversationId: string }[] }>
  getUserProfile(): Promise<UserProfile>
  getWorkspaceCapabilities(workspaceId: string): Promise<WorkspaceCapabilities>
}
