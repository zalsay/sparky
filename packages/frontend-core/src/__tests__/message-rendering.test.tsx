import * as React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SparkyApp } from '../index'
import type { PlatformClient } from '@sparky/platform-contract'
import type {
  AppSettings,
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

function createPlatformClient(messages: ChatMessage[], overrides: Partial<PlatformClient> = {}): PlatformClient {
  const runtime: RuntimeInfo = {
    service: 'sparky-web',
    version: 'test',
    environment: 'test',
    database: { configured: false, status: 'disconnected' },
  }
  const profile: UserProfile = { displayName: 'Tester' }
  const conversation: ConversationMeta = {
    id: 'conv-1',
    title: '测试会话',
    createdAt: '2026-03-24T00:00:00.000Z',
    updatedAt: '2026-03-24T00:00:00.000Z',
  }
  const result: ConversationMessagesResult = { messages, hasMore: false, total: messages.length }

  return {
    getRuntime: async () => runtime,
    getSettings: async () => ({
      themeMode: 'system',
      onboardingCompleted: true,
      environmentCheckSkipped: true,
      notificationsEnabled: true,
    } as AppSettings),
    updateSettings: async (input: AppSettings) => input,
    listWorkspaces: async () => [] as Workspace[],
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
    getMessages: async () => result,
    refreshMessages: async () => result,
    loadMoreMessages: async (_conversationId: string, _input: GetMessagesInput) => result,
    sendMessage: async (_conversationId: string, _input: SendMessageInput) => ({ messages }),
    uploadAttachment: async () => ({
      id: 'att-1',
      name: 'file.txt',
      mimeType: 'text/plain',
      size: 4,
      url: '/uploads/att-1-file.txt',
      status: 'ready' as const,
    }),
    streamMessage: async (_conversationId: string, _input: SendMessageInput, _handlers?: StreamMessageHandlers) => {},
    editMessage: async () => ({ messages }),
    resendMessage: async (_conversationId: string, _input: ResendMessageInput) => ({ messages }),
    truncateMessages: async (_conversationId: string, _input: TruncateMessagesInput) => result,
    updateContextDivider: async (_conversationId: string, messageId: string, input) => ({
      id: messageId,
      conversationId: 'conv-1',
      role: 'system',
      content: input.content ?? '',
      createdAt: '2026-03-24T00:00:00.000Z',
      kind: 'context_divider',
      contextDivider: { id: messageId, title: input.title, content: input.content },
    }),
    getUserProfile: async () => profile,
    getWorkspaceCapabilities: async (_workspaceId: string) => ({ mcpServerCount: 0, skillCount: 0 } as WorkspaceCapabilities),
    ...overrides,
  }
}

describe('SparkyApp message rendering', () => {
  it('renders tool result block with status and output', async () => {
    const client = createPlatformClient([
      {
        id: 'tool-1',
        conversationId: 'conv-1',
        role: 'system',
        content: 'fallback content',
        createdAt: '2026-03-24T00:00:01.000Z',
        status: 'done',
        kind: 'tool_result',
        toolResult: { name: 'grep', status: 'success', output: 'match line' },
      },
    ])

    render(<SparkyApp client={client} />)

    await waitFor(() => {
      expect(screen.getByText('grep')).toBeTruthy()
      expect(screen.getByText('success')).toBeTruthy()
      expect(screen.getByText('match line')).toBeTruthy()
    })
  })

  it('renders context divider block and supports edit save', async () => {
    const updateContextDivider = async (_conversationId: string, messageId: string, input: { title: string; content?: string }) => ({
      id: messageId,
      conversationId: 'conv-1',
      role: 'system' as const,
      content: input.content ?? '',
      createdAt: '2026-03-24T00:00:00.000Z',
      status: 'done' as const,
      kind: 'context_divider' as const,
      contextDivider: { id: messageId, title: input.title, content: input.content },
    })

    const client = createPlatformClient([
      {
        id: 'divider-1',
        conversationId: 'conv-1',
        role: 'system',
        content: 'old body',
        createdAt: '2026-03-24T00:00:01.000Z',
        status: 'done',
        kind: 'context_divider',
        contextDivider: { id: 'divider-1', title: 'Before', content: 'old body' },
      },
    ], { updateContextDivider })

    render(<SparkyApp client={client} />)

    await screen.findByText('Before')
    fireEvent.click(screen.getByText('编辑'))

    const editor = screen.getByDisplayValue('old body')
    fireEvent.change(editor, { target: { value: 'new body' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(screen.getByText('Before')).toBeTruthy()
      expect(screen.getByText('new body')).toBeTruthy()
    })
  })
})
