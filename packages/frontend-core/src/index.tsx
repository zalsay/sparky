import * as React from 'react'
import type { PlatformClient } from '@sparky/platform-contract'
import { PlatformRequestError } from '@sparky/shared'
import type {
  AgentRunnerStatus,
  AgentSession,
  Attachment,
  AttachmentInput,
  Channel,
  ChannelModel,
  ChatMessage,
  ConversationMeta,
  RuntimeInfo,
  StreamingEvent,
  UserProfile,
  Workspace,
  WorkspaceCapabilities,
} from '@sparky/shared'

interface SparkyAppProps {
  client: PlatformClient
}

interface SidebarSectionProps {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}

interface BootstrapData {
  runtime: RuntimeInfo | null
  profile: UserProfile | null
  workspaces: Workspace[]
  channels: Channel[]
  conversations: ConversationMeta[]
  bootstrapError: string | null
}

interface ChatState {
  currentConversationId: string | null
  messages: ChatMessage[]
  input: string
  editingMessageId: string | null
  editingMessageContent: string
  messagesLoading: boolean
  refreshingMessages: boolean
  loadingMoreMessages: boolean
  sending: boolean
  streaming: boolean
  streamingMessageId: string | null
  streamingError: string | null
  pendingAttachments: Attachment[]
  chatError: string | null
  hasMoreMessages: boolean
}

interface SidebarState {
  conversations: ConversationMeta[]
  channels: Channel[]
  editingConversationId: string | null
  editingTitle: string
  pinnedExpanded: boolean
  sidebarError: string | null
}

interface AgentSessionsState {
  runnerStatus: AgentRunnerStatus
  sessions: AgentSession[]
  activeSessionId: string | null
  loading: boolean
  creating: boolean
  pendingActionSessionId: string | null
  error: string | null
}

function SidebarSection({ title, children, action }: SidebarSectionProps): React.ReactElement {
  return (
    <section>
      <div className="section-header">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="list">{children}</div>
    </section>
  )
}

function groupConversationsByDate(conversations: ConversationMeta[]): Array<{ label: string; items: ConversationMeta[] }> {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 86_400_000

  const today: ConversationMeta[] = []
  const yesterday: ConversationMeta[] = []
  const earlier: ConversationMeta[] = []

  for (const conversation of conversations) {
    const updatedAt = new Date(conversation.updatedAt).getTime()
    if (updatedAt >= todayStart) {
      today.push(conversation)
    } else if (updatedAt >= yesterdayStart) {
      yesterday.push(conversation)
    } else {
      earlier.push(conversation)
    }
  }

  const groups: Array<{ label: string; items: ConversationMeta[] }> = []
  if (today.length > 0) groups.push({ label: '今天', items: today })
  if (yesterday.length > 0) groups.push({ label: '昨天', items: yesterday })
  if (earlier.length > 0) groups.push({ label: '更早', items: earlier })
  return groups
}

function sortConversations(items: ConversationMeta[]): ConversationMeta[] {
  return [...items].sort((a, b) => {
    const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    if (pinnedDelta !== 0) return pinnedDelta
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

function conversationTitleForInput(title: string): string {
  return title === '新对话' ? '' : title
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PlatformRequestError) {
    if (error.message.trim()) {
      return error.message
    }

    if (typeof error.body === 'string' && error.body.trim()) {
      return error.body
    }

    if (error.body && typeof error.body === 'object') {
      if (typeof error.body.message === 'string' && error.body.message.trim()) {
        return error.body.message
      }
      if (typeof error.body.error === 'string' && error.body.error.trim()) {
        return error.body.error
      }
    }

    return fallback
  }

  return error instanceof Error && error.message.trim() ? error.message : fallback
}

function createPendingAttachment(file: File): Attachment {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${file.name}`,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    status: 'pending',
  }
}

export function toAttachmentInput(items: Attachment[]): AttachmentInput[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    url: item.url,
  }))
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === next.id)
  if (index === -1) return [...messages, next]
  const copy = [...messages]
  copy[index] = next
  return copy
}

export function applyStreamingEvent(messages: ChatMessage[], event: StreamingEvent): ChatMessage[] {
  if (event.type === 'start') {
    return upsertMessage(messages, event.message)
  }

  if (event.type === 'delta') {
    return messages.map((message) => message.id === event.delta.messageId
      ? { ...message, content: `${message.content}${event.delta.content}`, status: event.delta.status }
      : message)
  }

  if (event.type === 'done') {
    return upsertMessage(messages, event.message)
  }

  return messages
}

function renderToolStatusLabel(status?: string): string {
  if (status === 'success') return 'success'
  if (status === 'error') return 'error'
  if (status === 'running') return 'running'
  if (status === 'pending') return 'pending'
  return 'unknown'
}

function renderToolOutput(message: ChatMessage): string {
  const output = message.toolResult?.output?.trim()
  if (output) return output
  const fallback = message.content.trim()
  return fallback || '暂无输出'
}

function renderDividerTitle(message: ChatMessage): string {
  return message.contextDivider?.title?.trim() || 'Context divider'
}

function renderDividerContent(message: ChatMessage): string {
  return message.contextDivider?.content?.trim() || message.content.trim() || '暂无内容'
}

function getEnabledModels(channel?: Channel | null): ChannelModel[] {
  return (channel?.models ?? []).filter((model) => model.enabled)
}

function getConversationSelection(conversation: ConversationMeta | undefined, channels: Channel[]): { channelId: string; modelId: string } | null {
  const fallbackChannel = channels[0]
  const channel = channels.find((item) => item.id === conversation?.channelId && item.enabled) ?? fallbackChannel
  if (!channel) return null
  const enabledModels = getEnabledModels(channel)
  const model = enabledModels.find((item) => item.id === conversation?.modelId) ?? enabledModels[0]
  if (!model) return null
  return { channelId: channel.id, modelId: model.id }
}

function renderChannelLabel(channel?: Channel): string {
  if (!channel) return '未选择 Channel'
  return `${channel.name} · ${channel.provider}`
}

async function loadBootstrapData(client: PlatformClient, refreshWorkspaceCapabilities: (workspaceItems: Workspace[]) => Promise<void>): Promise<BootstrapData> {
  const [runtimeResult, workspaceResult, profileResult, channelResult] = await Promise.allSettled([
    client.getRuntime(),
    client.listWorkspaces(),
    client.getUserProfile(),
    client.listChannels(),
  ])

  const workspaces = workspaceResult.status === 'fulfilled' ? workspaceResult.value : []
  const channels = channelResult.status === 'fulfilled' ? channelResult.value.filter((channel) => channel.enabled) : []

  if (workspaces.length > 0) {
    await refreshWorkspaceCapabilities(workspaces)
  }

  const conversations = sortConversations(await client.listConversations())

  const bootstrapError = [
    runtimeResult.status === 'rejected' ? getErrorMessage(runtimeResult.reason, '加载 runtime 失败') : null,
    workspaceResult.status === 'rejected' ? getErrorMessage(workspaceResult.reason, '加载 workspaces 失败') : null,
    profileResult.status === 'rejected' ? getErrorMessage(profileResult.reason, '加载用户信息失败') : null,
    channelResult.status === 'rejected' ? getErrorMessage(channelResult.reason, '加载 channels 失败') : null,
  ].filter(Boolean).join('；')

  return {
    runtime: runtimeResult.status === 'fulfilled' ? runtimeResult.value : null,
    profile: profileResult.status === 'fulfilled' ? profileResult.value : null,
    workspaces,
    channels,
    conversations,
    bootstrapError: bootstrapError || null,
  }
}

function useSidebarState(): [SidebarState, React.Dispatch<React.SetStateAction<SidebarState>>] {
  return React.useState<SidebarState>({
    conversations: [],
    channels: [],
    editingConversationId: null,
    editingTitle: '',
    pinnedExpanded: true,
    sidebarError: null,
  })
}

function useChatState(): [ChatState, React.Dispatch<React.SetStateAction<ChatState>>] {
  return React.useState<ChatState>({
    currentConversationId: null,
    messages: [],
    input: '',
    editingMessageId: null,
    editingMessageContent: '',
    messagesLoading: false,
    refreshingMessages: false,
    loadingMoreMessages: false,
    sending: false,
    streaming: false,
    streamingMessageId: null,
    streamingError: null,
    pendingAttachments: [],
    chatError: null,
    hasMoreMessages: false,
  })
}

function useAgentSessionsState(): [AgentSessionsState, React.Dispatch<React.SetStateAction<AgentSessionsState>>] {
  return React.useState<AgentSessionsState>({
    runnerStatus: 'unknown',
    sessions: [],
    activeSessionId: null,
    loading: false,
    creating: false,
    pendingActionSessionId: null,
    error: null,
  })
}

export function SparkyApp({ client }: SparkyAppProps): React.ReactElement {
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null)
  const [profile, setProfile] = React.useState<UserProfile | null>(null)
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceCapabilities, setWorkspaceCapabilities] = React.useState<Record<string, WorkspaceCapabilities>>({})
  const [sidebarState, setSidebarState] = useSidebarState()
  const [chatState, setChatState] = useChatState()
  const [agentSessionsState, setAgentSessionsState] = useAgentSessionsState()
  const [loading, setLoading] = React.useState(true)
  const [bootstrapError, setBootstrapError] = React.useState<string | null>(null)

  const {
    conversations,
    channels,
    editingConversationId,
    editingTitle,
    pinnedExpanded,
    sidebarError,
  } = sidebarState

  const {
    runnerStatus,
    sessions: agentSessions,
    activeSessionId,
    loading: agentSessionsLoading,
    creating: agentSessionsCreating,
    pendingActionSessionId,
    error: agentSessionsError,
  } = agentSessionsState

  const {
    currentConversationId,
    messages,
    input,
    editingMessageId,
    editingMessageContent,
    messagesLoading,
    refreshingMessages,
    loadingMoreMessages,
    sending,
    streaming,
    streamingError,
    pendingAttachments,
    chatError,
    hasMoreMessages,
  } = chatState

  const applyMessagesResult = React.useCallback((result: { messages: ChatMessage[]; hasMore: boolean }, mode: 'replace' | 'prepend' = 'replace') => {
    setChatState((prev) => ({
      ...prev,
      hasMoreMessages: result.hasMore,
      messages: mode === 'prepend'
        ? (() => {
            const knownIds = new Set(prev.messages.map((message) => message.id))
            const older = result.messages.filter((message) => !knownIds.has(message.id))
            return [...older, ...prev.messages]
          })()
        : result.messages,
    }))
  }, [setChatState])

  const refreshWorkspaceCapabilities = React.useCallback(async (workspaceItems: Workspace[]) => {
    const capabilitiesEntries = await Promise.all(
      workspaceItems.map(async (workspace) => [workspace.id, await client.getWorkspaceCapabilities(workspace.id)] as const),
    )
    setWorkspaceCapabilities(Object.fromEntries(capabilitiesEntries))
  }, [client])

  const refreshConversations = React.useCallback(async () => {
    const sessionItems = sortConversations(await client.listConversations())
    setSidebarState((prev) => ({ ...prev, conversations: sessionItems }))
    return sessionItems
  }, [client, setSidebarState])

  const refreshAgentSessions = React.useCallback(async () => {
    setAgentSessionsState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const [runnerItems, sessionResult] = await Promise.all([
        client.listAgentRunners(),
        client.listAgentSessions(),
      ])
      setAgentSessionsState((prev) => ({
        ...prev,
        runnerStatus: runnerItems[0]?.status ?? 'unknown',
        sessions: sessionResult.sessions,
        activeSessionId: sessionResult.activeSessionId ?? null,
        loading: false,
      }))
    } catch (err) {
      setAgentSessionsState((prev) => ({
        ...prev,
        loading: false,
        error: getErrorMessage(err, '加载 Agent Sessions 失败'),
      }))
    }
  }, [client])

  const loadMessages = React.useCallback(async (conversationId: string, options?: { append?: boolean; before?: string; refresh?: boolean }) => {
    setChatState((prev) => ({
      ...prev,
      loadingMoreMessages: Boolean(options?.append),
      refreshingMessages: Boolean(options?.refresh),
      messagesLoading: !options?.append && !options?.refresh,
      chatError: null,
    }))
    try {
      const result = options?.append
        ? await client.loadMoreMessages(conversationId, { limit: 20, before: options.before })
        : options?.refresh
          ? await client.refreshMessages(conversationId, { limit: 50 })
          : await client.getMessages(conversationId, { limit: 50 })
      applyMessagesResult(result, options?.append ? 'prepend' : 'replace')
    } catch (err) {
      setChatState((prev) => ({ ...prev, chatError: getErrorMessage(err, '加载消息失败') }))
    } finally {
      setChatState((prev) => ({
        ...prev,
        messagesLoading: false,
        refreshingMessages: false,
        loadingMoreMessages: false,
      }))
    }
  }, [applyMessagesResult, client, setChatState])

  const selectConversationAfterDeletion = React.useCallback((nextConversations: ConversationMeta[], deletedId: string) => {
    if (currentConversationId !== deletedId) return
    const nextActive = nextConversations[0]?.id ?? null
    setChatState((prev) => ({
      ...prev,
      currentConversationId: nextActive,
      messages: nextActive ? prev.messages : [],
      hasMoreMessages: nextActive ? prev.hasMoreMessages : false,
    }))
  }, [currentConversationId, setChatState])

  const bootstrap = React.useCallback(async () => {
    setLoading(true)
    setBootstrapError(null)
    setSidebarState((prev) => ({ ...prev, sidebarError: null }))
    setChatState((prev) => ({ ...prev, chatError: null }))
    setWorkspaceCapabilities({})
    try {
      const data = await loadBootstrapData(client, refreshWorkspaceCapabilities)
      setRuntime(data.runtime)
      setProfile(data.profile)
      setWorkspaces(data.workspaces)
      setSidebarState((prev) => ({ ...prev, channels: data.channels, conversations: data.conversations }))
      await refreshAgentSessions()
      const activeId = data.conversations[0]?.id ?? null
      setChatState((prev) => ({
        ...prev,
        currentConversationId: activeId,
        messages: activeId ? prev.messages : [],
        hasMoreMessages: activeId ? prev.hasMoreMessages : false,
      }))
      if (activeId) {
        await loadMessages(activeId)
      } else {
        setChatState((prev) => ({ ...prev, messages: [], hasMoreMessages: false }))
      }
      setBootstrapError(data.bootstrapError)
    } catch (err) {
      setBootstrapError(getErrorMessage(err, '加载应用失败'))
    } finally {
      setLoading(false)
    }
  }, [client, loadMessages, refreshWorkspaceCapabilities, refreshAgentSessions, setChatState, setSidebarState])

  React.useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const handleRefreshWorkspaceCapabilities = async () => {
    if (workspaces.length === 0) return
    setSidebarState((prev) => ({ ...prev, sidebarError: null }))
    try {
      await refreshWorkspaceCapabilities(workspaces)
    } catch (err) {
      setSidebarState((prev) => ({ ...prev, sidebarError: getErrorMessage(err, '刷新 workspace capabilities 失败') }))
    }
  }

  const activeConversation = React.useMemo(
    () => conversations.find((item) => item.id === currentConversationId),
    [conversations, currentConversationId],
  )

  const activeConversationSelection = React.useMemo(
    () => getConversationSelection(activeConversation, channels),
    [activeConversation, channels],
  )

  const selectedChannel = React.useMemo(
    () => channels.find((item) => item.id === activeConversationSelection?.channelId) ?? null,
    [channels, activeConversationSelection],
  )

  const selectedModels = React.useMemo(
    () => getEnabledModels(selectedChannel),
    [selectedChannel],
  )

  const selectedModelId = activeConversationSelection?.modelId ?? ''

  const activeAgentSession = React.useMemo(
    () => agentSessions.find((session) => session.id === activeSessionId) ?? null,
    [agentSessions, activeSessionId],
  )

  const composerBlockedReason = React.useMemo(() => {
    if (!currentConversationId) {
      return '请先选择对话'
    }
    if (!activeAgentSession) {
      return agentSessions.length === 0 ? '请先创建并连接一个 Agent Session' : '请先连接一个 Agent Session'
    }
    if (!activeConversationSelection) {
      return channels.length === 0 ? '请先配置可用 Channel' : '当前对话没有可用模型'
    }
    if (activeAgentSession.status !== 'running') {
      return '当前 Agent Session 不可用，请重启或重新连接'
    }
    return null
  }, [activeAgentSession, agentSessions.length, currentConversationId, activeConversationSelection, channels.length])

  const canSendMessage = !sending && !composerBlockedReason

  const handleCreateAgentSession = async () => {
    const workspaceId = workspaces[0]?.id
    if (!workspaceId) {
      setAgentSessionsState((prev) => ({ ...prev, error: '没有可用 workspace，无法创建 Agent Session' }))
      return
    }
    if (!activeConversationSelection) {
      setAgentSessionsState((prev) => ({ ...prev, error: channels.length === 0 ? '没有可用 Channel，无法创建 Agent Session' : '当前对话没有可用模型，无法创建 Agent Session' }))
      return
    }
    setAgentSessionsState((prev) => ({ ...prev, creating: true, error: null }))
    try {
      await client.createAgentSession({
        workspaceId,
        name: `Agent ${agentSessions.length + 1}`,
        channelId: activeConversationSelection.channelId,
        modelId: activeConversationSelection.modelId,
      })
      await refreshAgentSessions()
    } catch (err) {
      setAgentSessionsState((prev) => ({ ...prev, error: getErrorMessage(err, '创建 Agent Session 失败') }))
    } finally {
      setAgentSessionsState((prev) => ({ ...prev, creating: false }))
    }
  }

  const handleConnectAgentSession = async (sessionId: string) => {
    if (!currentConversationId) {
      setAgentSessionsState((prev) => ({ ...prev, error: '请先选择一个对话再连接 Agent Session' }))
      return
    }
    setAgentSessionsState((prev) => ({ ...prev, pendingActionSessionId: sessionId, error: null }))
    try {
      await client.connectAgentSession(sessionId, { conversationId: currentConversationId })
      await refreshAgentSessions()
    } catch (err) {
      setAgentSessionsState((prev) => ({ ...prev, error: getErrorMessage(err, '连接 Agent Session 失败') }))
    } finally {
      setAgentSessionsState((prev) => ({ ...prev, pendingActionSessionId: null }))
    }
  }

  const handleCloseAgentSession = async (sessionId: string) => {
    setAgentSessionsState((prev) => ({ ...prev, pendingActionSessionId: sessionId, error: null }))
    try {
      await client.closeAgentSession(sessionId)
      await refreshAgentSessions()
    } catch (err) {
      setAgentSessionsState((prev) => ({ ...prev, error: getErrorMessage(err, '关闭 Agent Session 失败') }))
    } finally {
      setAgentSessionsState((prev) => ({ ...prev, pendingActionSessionId: null }))
    }
  }

  const handleRestartAgentSession = async (sessionId: string) => {
    setAgentSessionsState((prev) => ({ ...prev, pendingActionSessionId: sessionId, error: null }))
    try {
      await client.restartAgentSession(sessionId)
      await refreshAgentSessions()
    } catch (err) {
      setAgentSessionsState((prev) => ({ ...prev, error: getErrorMessage(err, '重启 Agent Session 失败') }))
    } finally {
      setAgentSessionsState((prev) => ({ ...prev, pendingActionSessionId: null }))
    }
  }

  const handleUpdateConversationSelection = async (nextChannelId: string, nextModelId: string) => {
    if (!activeConversation) return
    setSidebarState((prev) => ({
      ...prev,
      sidebarError: null,
      conversations: prev.conversations.map((item) => item.id === activeConversation.id
        ? { ...item, channelId: nextChannelId, modelId: nextModelId, updatedAt: new Date().toISOString() }
        : item),
    }))
  }

  const handleCreateConversation = async () => {
    setSidebarState((prev) => ({ ...prev, sidebarError: null }))
    const fallbackChannel = channels[0]
    const fallbackModel = getEnabledModels(fallbackChannel)[0]
    if (!fallbackChannel || !fallbackModel) {
      setSidebarState((prev) => ({ ...prev, sidebarError: '请先配置至少一个可用 Channel 和 Model' }))
      return
    }
    try {
      const created = await client.createConversation({ title: '新对话', channelId: fallbackChannel.id, modelId: fallbackModel.id })
      const next = sortConversations([created, ...conversations])
      setSidebarState((prev) => ({ ...prev, conversations: next }))
      setChatState((prev) => ({ ...prev, currentConversationId: created.id, messages: [], hasMoreMessages: false }))
    } catch (err) {
      setSidebarState((prev) => ({ ...prev, sidebarError: getErrorMessage(err, '创建对话失败') }))
    }
  }

  const handleStartRenameConversation = (conversation: ConversationMeta) => {
    setSidebarState((prev) => ({
      ...prev,
      editingConversationId: conversation.id,
      editingTitle: conversationTitleForInput(conversation.title),
    }))
  }

  const handleRenameConversation = async (conversationId: string) => {
    const title = editingTitle.trim() || '新对话'
    setSidebarState((prev) => ({ ...prev, sidebarError: null }))
    try {
      const updated = await client.renameConversation(conversationId, { title })
      setSidebarState((prev) => ({
        ...prev,
        conversations: sortConversations(prev.conversations.map((item) => (item.id === updated.id ? updated : item))),
        editingConversationId: null,
        editingTitle: '',
      }))
    } catch (err) {
      setSidebarState((prev) => ({ ...prev, sidebarError: getErrorMessage(err, '重命名失败') }))
    }
  }

  const handleDeleteConversation = async (conversationId: string) => {
    setSidebarState((prev) => ({ ...prev, sidebarError: null }))
    try {
      await client.deleteConversation(conversationId)
      const next = sortConversations(conversations.filter((item) => item.id !== conversationId))
      setSidebarState((prev) => ({ ...prev, conversations: next }))
      selectConversationAfterDeletion(next, conversationId)
    } catch (err) {
      setSidebarState((prev) => ({ ...prev, sidebarError: getErrorMessage(err, '删除失败') }))
    }
  }

  const handleTogglePinConversation = async (conversation: ConversationMeta) => {
    setSidebarState((prev) => ({ ...prev, sidebarError: null }))
    try {
      const updated = conversation.pinned
        ? await client.unpinConversation(conversation.id, { pinned: false })
        : await client.pinConversation(conversation.id, { pinned: true })
      setSidebarState((prev) => ({
        ...prev,
        conversations: sortConversations(prev.conversations.map((item) => (item.id === updated.id ? updated : item))),
      }))
    } catch (err) {
      setSidebarState((prev) => ({ ...prev, sidebarError: getErrorMessage(err, '置顶操作失败') }))
    }
  }

  const handleSelectConversation = React.useCallback((conversationId: string) => {
    setChatState((prev) => ({
      ...prev,
      currentConversationId: conversationId,
      input: '',
      editingMessageId: null,
      editingMessageContent: '',
      chatError: null,
      streamingError: null,
      pendingAttachments: [],
    }))
    void loadMessages(conversationId)
  }, [loadMessages, setChatState])

  const handleRefreshMessages = async () => {
    if (!currentConversationId) return
    await loadMessages(currentConversationId, { refresh: true })
    await refreshConversations()
  }

  const handleLoadMoreMessages = async () => {
    if (!currentConversationId || !hasMoreMessages || messages.length === 0) return
    await loadMessages(currentConversationId, { append: true, before: messages[0]?.id })
  }

  const handleAddAttachments = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const pending = Array.from(files).map(createPendingAttachment)
    setChatState((prev) => ({ ...prev, pendingAttachments: [...prev.pendingAttachments, ...pending], chatError: null }))

    await Promise.all(pending.map(async (attachment, index) => {
      const file = files[index]
      try {
        const uploaded = await client.uploadAttachment(file)
        setChatState((prev) => ({
          ...prev,
          pendingAttachments: prev.pendingAttachments.map((item) => item.id === attachment.id ? uploaded : item),
        }))
      } catch (err) {
        setChatState((prev) => ({
          ...prev,
          chatError: getErrorMessage(err, '附件上传失败'),
          pendingAttachments: prev.pendingAttachments.map((item) => item.id === attachment.id ? { ...item, status: 'error' } : item),
        }))
      }
    }))
  }

  const handleRemoveAttachment = (attachmentId: string) => {
    setChatState((prev) => ({
      ...prev,
      pendingAttachments: prev.pendingAttachments.filter((item) => item.id !== attachmentId),
    }))
  }

  const handleStreamingEvent = React.useCallback((event: StreamingEvent) => {
    setChatState((prev) => {
      const nextMessages = applyStreamingEvent(prev.messages, event)
      return {
        ...prev,
        messages: nextMessages,
        streamingMessageId: event.type === 'start'
          ? event.message.id
          : event.type === 'done' || event.type === 'error'
            ? null
            : prev.streamingMessageId,
        streaming: event.type === 'done' || event.type === 'error' ? false : true,
        streamingError: event.type === 'error' ? event.error : prev.streamingError,
      }
    })
  }, [setChatState])

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!currentConversationId || !input.trim() || composerBlockedReason || !activeConversationSelection) return

    const trimmedInput = input.trim()
    const attachments = pendingAttachments.filter((item) => item.status === 'ready')
    const optimisticUserMessage: ChatMessage = {
      id: `local-user-${Date.now()}`,
      conversationId: currentConversationId,
      role: 'user',
      content: trimmedInput,
      createdAt: new Date().toISOString(),
      status: 'done',
      attachments,
    }

    setChatState((prev) => ({
      ...prev,
      sending: true,
      streaming: true,
      streamingError: null,
      chatError: null,
      input: '',
      pendingAttachments: [],
      messages: [...prev.messages, optimisticUserMessage],
    }))

    try {
      await client.streamMessage(currentConversationId, {
        content: trimmedInput,
        channelId: activeConversationSelection.channelId,
        modelId: activeConversationSelection.modelId,
        attachments: toAttachmentInput(attachments),
      }, {
        onEvent: handleStreamingEvent,
      })
      await loadMessages(currentConversationId, { refresh: true })
      await refreshConversations()
    } catch (err) {
      setChatState((prev) => ({
        ...prev,
        chatError: getErrorMessage(err, '发送失败'),
        streamingError: getErrorMessage(err, 'Streaming 失败'),
      }))
    } finally {
      setChatState((prev) => ({ ...prev, sending: false, streaming: false, streamingMessageId: null }))
    }
  }

  const handleStartEditMessage = (message: ChatMessage) => {
    setChatState((prev) => ({
      ...prev,
      editingMessageId: message.id,
      editingMessageContent: message.kind === 'context_divider'
        ? message.contextDivider?.content ?? message.content
        : message.content,
    }))
  }

  const handleEditMessage = async (message: ChatMessage) => {
    if (!currentConversationId || !editingMessageContent.trim()) return
    setChatState((prev) => ({ ...prev, chatError: null }))
    try {
      if (message.kind === 'context_divider') {
        const updated = await client.updateContextDivider(currentConversationId, message.id, {
          title: message.contextDivider?.title ?? 'Context divider',
          content: editingMessageContent.trim(),
        })
        setChatState((prev) => ({
          ...prev,
          messages: prev.messages.map((item) => item.id === updated.id ? updated : item),
          editingMessageId: null,
          editingMessageContent: '',
        }))
      } else {
        const result = await client.editMessage(currentConversationId, message.id, { content: editingMessageContent.trim() })
        setChatState((prev) => ({
          ...prev,
          messages: result.messages as ChatMessage[],
          editingMessageId: null,
          editingMessageContent: '',
        }))
      }
      await refreshConversations()
    } catch (err) {
      setChatState((prev) => ({ ...prev, chatError: getErrorMessage(err, '编辑消息失败') }))
    }
  }

  const handleResendMessage = async (messageId: string) => {
    if (!currentConversationId) return
    setChatState((prev) => ({ ...prev, chatError: null }))
    try {
      await client.resendMessage(currentConversationId, { messageId })
      await loadMessages(currentConversationId, { refresh: true })
      await refreshConversations()
    } catch (err) {
      setChatState((prev) => ({ ...prev, chatError: getErrorMessage(err, '重发失败') }))
    }
  }

  const handleTruncateMessages = async (messageId: string) => {
    if (!currentConversationId) return
    setChatState((prev) => ({ ...prev, chatError: null }))
    try {
      const result = await client.truncateMessages(currentConversationId, { messageId })
      applyMessagesResult(result)
      setChatState((prev) => ({ ...prev, editingMessageId: null }))
      await refreshConversations()
    } catch (err) {
      setChatState((prev) => ({ ...prev, chatError: getErrorMessage(err, '截断失败') }))
    }
  }

  const pinnedConversations = React.useMemo(
    () => conversations.filter((conversation) => conversation.pinned),
    [conversations],
  )

  const conversationGroups = React.useMemo(
    () => groupConversationsByDate(conversations.filter((conversation) => !conversation.pinned)),
    [conversations],
  )

  if (loading) {
    return <div className="screen center">正在连接 Sparky Web...</div>
  }

  return (
    <div className="screen">
      <aside className="sidebar">
        <div>
          <h1>Sparky Web</h1>
          <p className="muted">frontend-core + platform-web</p>
          <p className="muted">{profile?.displayName ?? '未登录用户'}</p>
        </div>

        <button className="primary" onClick={handleCreateConversation} disabled={channels.length === 0}>新对话</button>

        {bootstrapError ? <div className="error">{bootstrapError}</div> : null}

        <SidebarSection title="Runtime">
          <div className="card small">
            <div>{runtime?.service}</div>
            <div>{runtime?.environment}</div>
            <div>DB: {runtime?.database.status}</div>
          </div>
        </SidebarSection>

        <SidebarSection
          title="Workspaces"
          action={workspaces.length > 0 ? <button className="ghost" onClick={() => void handleRefreshWorkspaceCapabilities()}>刷新</button> : null}
        >
          {workspaces.map((workspace: Workspace) => {
            const capability = workspaceCapabilities[workspace.id]
            return (
              <div key={workspace.id} className="card small">
                <strong>{workspace.name}</strong>
                <span>{workspace.rootPath}</span>
                <span className="muted">skills {capability?.skillCount ?? 0} · mcp {capability?.mcpServerCount ?? 0}</span>
              </div>
            )
          })}
        </SidebarSection>

        <SidebarSection
          title="Agent Sessions"
          action={(
            <div className="toolbar compact">
              <button className="ghost" onClick={() => void refreshAgentSessions()} disabled={agentSessionsLoading}>刷新</button>
              <button className="primary" onClick={() => void handleCreateAgentSession()} disabled={runnerStatus !== 'healthy' || agentSessionsCreating || workspaces.length === 0}>
                {agentSessionsCreating ? '创建中...' : '创建'}
              </button>
            </div>
          )}
        >
          <div className="card small">
            <strong>Runner</strong>
            <span className={`status-badge ${runnerStatus}`}>{runnerStatus}</span>
          </div>
          {agentSessionsError ? <div className="error">{agentSessionsError}</div> : null}
          {agentSessions.length === 0 ? <div className="muted">No agent sessions yet</div> : null}
          {agentSessions.map((session) => {
            const pending = pendingActionSessionId === session.id
            return (
              <div key={session.id} className={`card small agent-session ${activeSessionId === session.id ? 'active-session' : ''}`}>
                <div className="agent-session-header">
                  <strong>{session.name}</strong>
                  <span className={`status-badge ${session.status}`}>{session.status}</span>
                </div>
                <span className="muted">{session.workspaceId}</span>
                {session.lastError ? <span className="error inline-error">{session.lastError}</span> : null}
                <div className="toolbar compact">
                  {session.status === 'running' ? <button className="ghost" onClick={() => void handleConnectAgentSession(session.id)} disabled={pending || !currentConversationId}>连接</button> : null}
                  {session.status === 'running' ? <button className="ghost" onClick={() => void handleCloseAgentSession(session.id)} disabled={pending}>关闭</button> : null}
                  {(session.status === 'running' || session.status === 'stopped' || session.status === 'error') ? (
                    <button className="ghost" onClick={() => void handleRestartAgentSession(session.id)} disabled={pending}>重启</button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </SidebarSection>

        {sidebarError ? <div className="error">{sidebarError}</div> : null}

        <SidebarSection
          title="Pinned"
          action={pinnedConversations.length > 0 ? <button className="ghost" onClick={() => setSidebarState((prev) => ({ ...prev, pinnedExpanded: !prev.pinnedExpanded }))}>{pinnedExpanded ? '收起' : '展开'}</button> : null}
        >
          {pinnedExpanded && pinnedConversations.length > 0 ? pinnedConversations.map((conversation) => (
            <ConversationListItem
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === currentConversationId}
              editing={editingConversationId === conversation.id}
              editingTitle={editingTitle}
              onEditingTitleChange={(value) => setSidebarState((prev) => ({ ...prev, editingTitle: value }))}
              onSelect={handleSelectConversation}
              onStartRename={handleStartRenameConversation}
              onConfirmRename={handleRenameConversation}
              onCancelRename={() => setSidebarState((prev) => ({ ...prev, editingConversationId: null }))}
              onDelete={handleDeleteConversation}
              onTogglePin={handleTogglePinConversation}
            />
          )) : <div className="muted">暂无置顶对话</div>}
        </SidebarSection>

        <section>
          <div className="section-header">
            <h2>Chats</h2>
          </div>
          {conversationGroups.map((group: { label: string; items: ConversationMeta[] }) => (
            <div key={group.label} className="list">
              <div className="muted">{group.label}</div>
              {group.items.map((conversation: ConversationMeta) => (
                <ConversationListItem
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === currentConversationId}
                  editing={editingConversationId === conversation.id}
                  editingTitle={editingTitle}
                  onEditingTitleChange={(value) => setSidebarState((prev) => ({ ...prev, editingTitle: value }))}
                  onSelect={handleSelectConversation}
                  onStartRename={handleStartRenameConversation}
                  onConfirmRename={handleRenameConversation}
                  onCancelRename={() => setSidebarState((prev) => ({ ...prev, editingConversationId: null }))}
                  onDelete={handleDeleteConversation}
                  onTogglePin={handleTogglePinConversation}
                />
              ))}
            </div>
          ))}
        </section>
      </aside>

      <main className="content">
        <header className="content-header">
          <div>
            <h2>{conversations.find((item: ConversationMeta) => item.id === currentConversationId)?.title ?? '请选择对话'}</h2>
            <p className="muted">能力边界已从 window.electronAPI 收敛到 PlatformClient</p>
            {currentConversationId ? (
              <div className="toolbar compact">
                <label>
                  <span className="muted">Channel</span>
                  <select
                    value={activeConversationSelection?.channelId ?? ''}
                    onChange={(event) => {
                      const nextChannel = channels.find((item) => item.id === event.target.value)
                      const nextModel = getEnabledModels(nextChannel)[0]
                      if (nextChannel && nextModel) {
                        void handleUpdateConversationSelection(nextChannel.id, nextModel.id)
                      }
                    }}
                    disabled={!currentConversationId || channels.length === 0}
                  >
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>{renderChannelLabel(channel)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="muted">Model</span>
                  <select
                    value={selectedModelId}
                    onChange={(event) => {
                      if (activeConversationSelection) {
                        void handleUpdateConversationSelection(activeConversationSelection.channelId, event.target.value)
                      }
                    }}
                    disabled={!currentConversationId || selectedModels.length === 0}
                  >
                    {selectedModels.map((model) => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
          </div>
          <div className="toolbar">
            <button className="ghost" onClick={() => void handleRefreshMessages()} disabled={!currentConversationId || refreshingMessages}>
              {refreshingMessages ? '刷新中...' : '刷新'}
            </button>
            <button className="ghost" onClick={() => void handleLoadMoreMessages()} disabled={!currentConversationId || !hasMoreMessages || loadingMoreMessages}>
              {loadingMoreMessages ? '加载中...' : '加载更多'}
            </button>
          </div>
        </header>

        <div className={`connection-banner ${activeAgentSession?.status === 'running' ? 'connected' : 'disconnected'}`}>
          {activeAgentSession
            ? `Connected to ${activeAgentSession.name}${activeAgentSession.status === 'running' ? '' : '（不可用）'}`
            : '未连接 Agent Session'}
        </div>

        {chatError ? <div className="error">{chatError}</div> : null}
        {streamingError ? <div className="error">{streamingError}</div> : null}

        {!currentConversationId && !messagesLoading ? (
          <div className="empty-state">请选择一个对话，或先创建一个新对话。</div>
        ) : null}

        {messagesLoading ? <div className="muted">正在加载消息...</div> : null}
        {streaming ? <div className="muted">正在接收流式回复...</div> : null}

        <div className="messages">
          {currentConversationId && !messagesLoading && messages.length === 0 ? <div className="empty-state">当前对话还没有消息。</div> : null}
          {messages.map((message: ChatMessage) => (
            <article key={message.id} className={`message ${message.role} ${message.kind ?? 'text'}`}>
              <div className="message-header">
                <div>
                  <div className="role">{message.kind === 'tool_result' ? 'tool' : message.kind === 'context_divider' ? 'divider' : message.role}</div>
                  {message.status ? <div className="muted">{message.status}</div> : null}
                </div>
                <div className="message-actions">
                  <button className="ghost" onClick={() => handleTruncateMessages(message.id)}>截断</button>
                  {message.role === 'user' ? <button className="ghost" onClick={() => handleResendMessage(message.id)}>重发</button> : null}
                  <button className="ghost" onClick={() => handleStartEditMessage(message)}>编辑</button>
                </div>
              </div>
              {editingMessageId === message.id ? (
                <div className="list">
                  <textarea
                    value={editingMessageContent}
                    onChange={(event) => setChatState((prev) => ({ ...prev, editingMessageContent: event.target.value }))}
                    rows={4}
                  />
                  <div className="toolbar">
                    <button className="primary" type="button" onClick={() => void handleEditMessage(message)}>保存</button>
                    <button className="ghost" type="button" onClick={() => setChatState((prev) => ({
                      ...prev,
                      editingMessageId: null,
                      editingMessageContent: '',
                    }))}>取消</button>
                  </div>
                </div>
              ) : message.kind === 'tool_result' ? (
                <div className="card tool-card">
                  <strong>{message.toolResult?.name ?? message.toolInvocation?.name ?? 'Tool result'}</strong>
                  <div className="muted">{renderToolStatusLabel(message.toolResult?.status ?? message.toolInvocation?.status)}</div>
                  <div>{renderToolOutput(message)}</div>
                </div>
              ) : message.kind === 'context_divider' ? (
                <div className="divider-card">
                  <strong>{renderDividerTitle(message)}</strong>
                  <div>{renderDividerContent(message)}</div>
                </div>
              ) : (
                <>
                  <div>{message.content}</div>
                  {message.attachments?.length ? (
                    <div className="attachment-list">
                      {message.attachments.map((attachment) => (
                        <div key={attachment.id} className="attachment-item">
                          <strong>{attachment.name}</strong>
                          <span className="muted">{attachment.mimeType} · {attachment.size} bytes</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={handleSend}>
          {composerBlockedReason ? <div className="empty-state">{composerBlockedReason}</div> : null}
          {pendingAttachments.length > 0 ? (
            <div className="attachment-list">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.id} className="attachment-item">
                  <div>
                    <strong>{attachment.name}</strong>
                    <div className="muted">{attachment.mimeType} · {attachment.size} bytes · {attachment.status}</div>
                  </div>
                  <button className="ghost" type="button" onClick={() => handleRemoveAttachment(attachment.id)}>移除</button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            value={input}
            onChange={(event) => setChatState((prev) => ({ ...prev, input: event.target.value }))}
            placeholder="输入一条消息，验证 frontend-core -> platform-web -> Go server"
            rows={4}
          />
          <div className="toolbar">
            <label className="ghost upload-button">
              添加附件
              <input
                hidden
                type="file"
                multiple
                onChange={(event) => {
                  handleAddAttachments(event.target.files)
                  event.currentTarget.value = ''
                }}
              />
            </label>
            <button className="primary" type="submit" disabled={!canSendMessage}>
              {sending ? '发送中...' : composerBlockedReason ?? '发送'}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

interface ConversationListItemProps {
  conversation: ConversationMeta
  active: boolean
  editing: boolean
  editingTitle: string
  onEditingTitleChange: (value: string) => void
  onSelect: (conversationId: string) => void | Promise<void>
  onStartRename: (conversation: ConversationMeta) => void
  onConfirmRename: (conversationId: string) => void | Promise<void>
  onCancelRename: () => void
  onDelete: (conversationId: string) => void | Promise<void>
  onTogglePin: (conversation: ConversationMeta) => void | Promise<void>
}

function ConversationListItem({
  conversation,
  active,
  editing,
  editingTitle,
  onEditingTitleChange,
  onSelect,
  onStartRename,
  onConfirmRename,
  onCancelRename,
  onDelete,
  onTogglePin,
}: ConversationListItemProps): React.ReactElement {
  return (
    <div className={`conversation ${active ? 'active' : ''}`}>
      {editing ? (
        <>
          <input
            className="input"
            value={editingTitle}
            onChange={(event) => onEditingTitleChange(event.target.value)}
            placeholder="输入对话标题"
          />
          <div className="conversation-actions">
            <button className="ghost" onClick={() => void onConfirmRename(conversation.id)}>保存</button>
            <button className="ghost" onClick={onCancelRename}>取消</button>
          </div>
        </>
      ) : (
        <>
          <button className="conversation-title" onClick={() => void onSelect(conversation.id)}>
            <strong>{conversation.title}</strong>
            <span>{new Date(conversation.updatedAt).toLocaleString()}</span>
          </button>
          <div className="conversation-actions">
            <button className="ghost" onClick={() => onStartRename(conversation)}>重命名</button>
            <button className="ghost" onClick={() => void onTogglePin(conversation)}>{conversation.pinned ? '取消置顶' : '置顶'}</button>
            <button className="ghost danger" onClick={() => void onDelete(conversation.id)}>删除</button>
          </div>
        </>
      )}
    </div>
  )
}
