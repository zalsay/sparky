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
  StreamMessageHandlers,
  TruncateMessagesInput,
  UpdateContextDividerInput,
  UpdateConversationPinInput,
  UserProfile,
  Workspace,
  WorkspaceCapabilities,
  ChatMessage,
  UploadedAttachment,
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
  sendMessage(conversationId: string, input: SendMessageInput): Promise<{ messages: ChatMessage[] }>
  uploadAttachment(file: File): Promise<UploadedAttachment>
  streamMessage(conversationId: string, input: SendMessageInput, handlers?: StreamMessageHandlers): Promise<void>
  editMessage(conversationId: string, messageId: string, input: EditMessageInput): Promise<{ messages: ChatMessage[] }>
  resendMessage(conversationId: string, input: ResendMessageInput): Promise<{ messages: ChatMessage[] }>
  truncateMessages(conversationId: string, input: TruncateMessagesInput): Promise<ConversationMessagesResult>
  updateContextDivider(conversationId: string, messageId: string, input: UpdateContextDividerInput): Promise<ChatMessage>
  getUserProfile(): Promise<UserProfile>
  getWorkspaceCapabilities(workspaceId: string): Promise<WorkspaceCapabilities>
}
