import type {
  AgentRunnerInfo,
  AgentSession,
  AgentSessionActionResult,
  AgentSessionConnection,
  AgentSessionListResult,
  AppSettings,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ConnectAgentSessionInput,
  ConversationMessagesResult,
  ConversationMeta,
  CreateAgentSessionInput,
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
  listChannels(): Promise<Channel[]>
  createChannel(input: ChannelCreateInput): Promise<Channel>
  updateChannel(channelId: string, input: ChannelUpdateInput): Promise<Channel>
  deleteChannel(channelId: string): Promise<void>
  listWorkspaces(): Promise<Workspace[]>
  listAgentRunners(): Promise<AgentRunnerInfo[]>
  getAgentRunner(runnerId: string): Promise<AgentRunnerInfo>
  listAgentSessions(): Promise<AgentSessionListResult>
  createAgentSession(input: CreateAgentSessionInput): Promise<AgentSessionActionResult>
  getAgentSession(sessionId: string): Promise<AgentSession>
  connectAgentSession(sessionId: string, input?: ConnectAgentSessionInput): Promise<{ session: AgentSession, connection: AgentSessionConnection }>
  closeAgentSession(sessionId: string): Promise<AgentSessionActionResult>
  restartAgentSession(sessionId: string): Promise<AgentSessionActionResult>
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
