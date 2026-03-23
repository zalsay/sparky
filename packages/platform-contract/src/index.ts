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
import { PlatformRequestError } from '@sparky/shared'
import type { PlatformRequestErrorDetails } from '@sparky/shared'

export interface PlatformClient {
  getRuntime(): Promise<RuntimeInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(input: AppSettings): Promise<AppSettings>
  listWorkspaces(): Promise<Workspace[]>
  listConversations(): Promise<ConversationMeta[]>
  createConversation(input: CreateConversationInput): Promise<ConversationMeta>
  renameConversation(conversationId: string, input: RenameConversationInput): Promise<ConversationMeta>
  deleteConversation(conversationId: string): Promise<void>
  pinConversation(conversationId: string, input: UpdateConversationPinInput): Promise<ConversationMeta>
  unpinConversation(conversationId: string, input: UpdateConversationPinInput): Promise<ConversationMeta>
  getMessages(conversationId: string, input?: GetMessagesInput): Promise<ConversationMessagesResult>
  refreshMessages(conversationId: string, input?: GetMessagesInput): Promise<ConversationMessagesResult>
  loadMoreMessages(conversationId: string, input: GetMessagesInput): Promise<ConversationMessagesResult>
  sendMessage(conversationId: string, input: SendMessageInput): Promise<{ messages: { id: string; role: string; content: string; createdAt: string; conversationId: string }[] }>
  editMessage(conversationId: string, messageId: string, input: EditMessageInput): Promise<{ messages: { id: string; role: string; content: string; createdAt: string; conversationId: string }[] }>
  resendMessage(conversationId: string, input: ResendMessageInput): Promise<{ messages: { id: string; role: string; content: string; createdAt: string; conversationId: string }[] }>
  truncateMessages(conversationId: string, input: TruncateMessagesInput): Promise<ConversationMessagesResult>
  getUserProfile(): Promise<UserProfile>
  getWorkspaceCapabilities(workspaceId: string): Promise<WorkspaceCapabilities>
}
