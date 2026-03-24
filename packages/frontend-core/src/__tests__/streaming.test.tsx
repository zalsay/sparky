import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SparkyApp } from '../index'
import type { PlatformClient } from '@sparky/platform-contract'
import type {
  AgentRunnerInfo,
  AgentSession,
  AgentSessionActionResult,
  AgentSessionListResult,
  AppSettings,
  Channel,
  ChatMessage,
  ConversationMessagesResult,
  ConversationMeta,
  CreateConversationInput,
  GetMessagesInput,
  RenameConversationInput,
  ResendMessageInput,
  RuntimeInfo,
  SendMessageInput,
  StreamMessageHandlers,
  TruncateMessagesInput,
  UpdateConversationPinInput,
  UserProfile,
  Workspace,
  WorkspaceCapabilities,
} from '@sparky/shared'

function createPlatformClient(overrides: Partial<PlatformClient> = {}): PlatformClient {
  const runtime: RuntimeInfo = {
    service: 'sparky-web',
    version: 'test',
    environment: 'test',
    database: { configured: false, status: 'disconnected' },
    agentControlPlane: { enabled: true, runnerCount: 1, defaultRunnerStatus: 'healthy' },
  }
  const profile: UserProfile = { displayName: 'Tester' }
  const channels: Channel[] = [{
    id: 'channel-1',
    name: 'Anthropic',
    provider: 'anthropic',
    enabled: true,
    createdAt: '2026-03-24T00:00:00.000Z',
    updatedAt: '2026-03-24T00:00:00.000Z',
    models: [{
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      enabled: true,
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    }],
  }]
  const conversation: ConversationMeta = {
    id: 'conv-1',
    title: '测试会话',
    channelId: 'channel-1',
    modelId: 'claude-opus-4-6',
    createdAt: '2026-03-24T00:00:00.000Z',
    updatedAt: '2026-03-24T00:00:00.000Z',
  }
  const emptyMessages: ConversationMessagesResult = { messages: [], hasMore: false, total: 0 }
  const agentSession: AgentSession = {
    id: 'agent-1',
    workspaceId: 'workspace-1',
    name: 'Agent 1',
    status: 'running',
    runnerId: 'default',
    transport: 'http',
    createdAt: '2026-03-24T00:00:00.000Z',
    updatedAt: '2026-03-24T00:00:00.000Z',
  }
  const runner: AgentRunnerInfo = {
    id: 'default',
    baseUrl: 'http://runner',
    status: 'healthy',
  }
  const actionResult: AgentSessionActionResult = { session: agentSession }
  const sessionList: AgentSessionListResult = { sessions: [agentSession], activeSessionId: 'agent-1' }

  return {
    getRuntime: async () => runtime,
    getSettings: async () => ({
      themeMode: 'system',
      onboardingCompleted: true,
      environmentCheckSkipped: true,
      notificationsEnabled: true,
    } as AppSettings),
    updateSettings: async (input: AppSettings) => input,
    listChannels: async () => channels,
    listWorkspaces: async () => [{
      id: 'workspace-1',
      name: 'Workspace 1',
      rootPath: '/tmp/workspace-1',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    }] as Workspace[],
    listAgentRunners: async () => [runner],
    getAgentRunner: async () => runner,
    listAgentSessions: async () => sessionList,
    createAgentSession: async () => actionResult,
    getAgentSession: async () => agentSession,
    connectAgentSession: async () => ({
      session: agentSession,
      connection: {
        sessionId: agentSession.id,
        conversationId: 'conv-1',
        connectedAt: '2026-03-24T00:00:00.000Z',
      },
    }),
    closeAgentSession: async () => actionResult,
    restartAgentSession: async () => actionResult,
    listConversations: async () => [conversation],
    createConversation: async (input: CreateConversationInput) => ({
      ...conversation,
      id: 'conv-new',
      title: input.title ?? '新对话',
    }),
    renameConversation: async (conversationId: string, input: RenameConversationInput) => ({
      ...conversation,
      id: conversationId,
      title: input.title,
    }),
    deleteConversation: async () => {},
    pinConversation: async (conversationId: string, input: UpdateConversationPinInput) => ({
      ...conversation,
      id: conversationId,
      pinned: input.pinned,
    }),
    unpinConversation: async (conversationId: string, input: UpdateConversationPinInput) => ({
      ...conversation,
      id: conversationId,
      pinned: input.pinned,
    }),
    getMessages: async (_conversationId: string, _input?: GetMessagesInput) => emptyMessages,
    refreshMessages: async (_conversationId: string, _input?: GetMessagesInput) => emptyMessages,
    loadMoreMessages: async (_conversationId: string, _input: GetMessagesInput) => emptyMessages,
    sendMessage: async () => ({ messages: [] as ChatMessage[] }),
    uploadAttachment: async () => ({
      id: 'att-1',
      name: 'file.txt',
      mimeType: 'text/plain',
      size: 4,
      url: '/uploads/att-1-file.txt',
      status: 'ready' as const,
    }),
    streamMessage: async () => {},
    editMessage: async () => ({ messages: [] as ChatMessage[] }),
    resendMessage: async (_conversationId: string, _input: ResendMessageInput) => ({ messages: [] as ChatMessage[] }),
    truncateMessages: async (_conversationId: string, _input: TruncateMessagesInput) => emptyMessages,
    updateContextDivider: async () => ({
      id: 'divider-1',
      conversationId: 'conv-1',
      role: 'system',
      content: 'divider',
      createdAt: '2026-03-24T00:00:00.000Z',
      kind: 'context_divider',
      contextDivider: { id: 'divider-1', title: 'Divider', content: 'divider' },
    }),
    getUserProfile: async () => profile,
    getWorkspaceCapabilities: async (_workspaceId: string) => ({ mcpServerCount: 0, skillCount: 0 } as WorkspaceCapabilities),
    ...overrides,
  }
}

async function submitMessage(text: string) {
  const input = await screen.findByPlaceholderText('输入一条消息，验证 frontend-core -> platform-web -> Go server')
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(input.closest('form')!)
}

describe('SparkyApp streaming', () => {
  it('applies start -> delta -> done in order', async () => {
    const finalMessage: ChatMessage = {
      id: 'assistant-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'Hello world',
      createdAt: '2026-03-24T00:00:01.000Z',
      status: 'done',
    }

    const client = createPlatformClient({
      streamMessage: async (_conversationId: string, _input: SendMessageInput, handlers?: StreamMessageHandlers) => {
        handlers?.onEvent?.({
          type: 'start',
          conversationId: 'conv-1',
          message: {
            id: 'assistant-1',
            conversationId: 'conv-1',
            role: 'assistant',
            content: '',
            createdAt: '2026-03-24T00:00:01.000Z',
            status: 'loading',
          },
        })
        handlers?.onEvent?.({
          type: 'delta',
          conversationId: 'conv-1',
          delta: { messageId: 'assistant-1', content: 'Hello ', status: 'partial' },
        })
        handlers?.onEvent?.({
          type: 'delta',
          conversationId: 'conv-1',
          delta: { messageId: 'assistant-1', content: 'world', status: 'partial' },
        })
        handlers?.onEvent?.({ type: 'done', conversationId: 'conv-1', message: finalMessage })
      },
      refreshMessages: async () => ({ messages: [finalMessage], hasMore: false, total: 1 }),
    })

    render(<SparkyApp client={client} />)
    await submitMessage('hi')

    await waitFor(() => {
      expect(screen.getAllByText('Hello world').length).toBeGreaterThan(0)
    })
  })

  it('disables send before agent session is connected', async () => {
    const disconnectedSession: AgentSession = {
      id: 'agent-2',
      workspaceId: 'workspace-1',
      name: 'Agent 2',
      status: 'running',
      runnerId: 'default',
      transport: 'http',
      createdAt: '2026-03-24T00:00:00.000Z',
      updatedAt: '2026-03-24T00:00:00.000Z',
    }

    const client = createPlatformClient({
      listAgentSessions: async () => ({ sessions: [disconnectedSession], activeSessionId: undefined }),
    })

    render(<SparkyApp client={client} />)

    await waitFor(() => {
      expect(screen.getAllByText('请先连接一个 Agent Session').length).toBeGreaterThan(0)
    })
    expect(screen.getByRole('button', { name: '请先连接一个 Agent Session' }).hasAttribute('disabled')).toBe(true)
  })
})
