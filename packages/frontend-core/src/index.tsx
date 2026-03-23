import React from 'react'
import type { PlatformClient } from '@sparky/platform-contract'
import type {
  ChatMessage,
  ConversationMeta,
  RuntimeInfo,
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

export function SparkyApp({ client }: SparkyAppProps): React.ReactElement {
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null)
  const [profile, setProfile] = React.useState<UserProfile | null>(null)
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceCapabilities, setWorkspaceCapabilities] = React.useState<Record<string, WorkspaceCapabilities>>({})
  const [conversations, setConversations] = React.useState<ConversationMeta[]>([])
  const [currentConversationId, setCurrentConversationId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState('')
  const [editingConversationId, setEditingConversationId] = React.useState<string | null>(null)
  const [editingTitle, setEditingTitle] = React.useState('')
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(null)
  const [editingMessageContent, setEditingMessageContent] = React.useState('')
  const [pinnedExpanded, setPinnedExpanded] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [messagesLoading, setMessagesLoading] = React.useState(false)
  const [refreshingMessages, setRefreshingMessages] = React.useState(false)
  const [loadingMoreMessages, setLoadingMoreMessages] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [sidebarError, setSidebarError] = React.useState<string | null>(null)
  const [chatError, setChatError] = React.useState<string | null>(null)
  const [hasMoreMessages, setHasMoreMessages] = React.useState(false)

  const applyMessagesResult = React.useCallback((result: { messages: ChatMessage[]; hasMore: boolean }, mode: 'replace' | 'prepend' = 'replace') => {
    setHasMoreMessages(result.hasMore)
    setMessages((prev) => {
      if (mode === 'prepend') {
        const knownIds = new Set(prev.map((message) => message.id))
        const older = result.messages.filter((message) => !knownIds.has(message.id))
        return [...older, ...prev]
      }
      return result.messages
    })
  }, [])

  const refreshConversations = React.useCallback(async () => {
    const sessionItems = sortConversations(await client.listConversations())
    setConversations(sessionItems)
    return sessionItems
  }, [client])

  const loadMessages = React.useCallback(async (conversationId: string, options?: { append?: boolean; before?: string; refresh?: boolean }) => {
    if (options?.append) {
      setLoadingMoreMessages(true)
    } else if (options?.refresh) {
      setRefreshingMessages(true)
    } else {
      setMessagesLoading(true)
    }
    setChatError(null)
    try {
      const result = options?.append
        ? await client.loadMoreMessages(conversationId, { limit: 20, before: options.before })
        : options?.refresh
          ? await client.refreshMessages(conversationId, { limit: 50 })
          : await client.getMessages(conversationId, { limit: 50 })
      applyMessagesResult(result, options?.append ? 'prepend' : 'replace')
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '加载消息失败')
    } finally {
      setMessagesLoading(false)
      setRefreshingMessages(false)
      setLoadingMoreMessages(false)
    }
  }, [applyMessagesResult, client])

  const selectConversationAfterDeletion = React.useCallback((nextConversations: ConversationMeta[], deletedId: string) => {
    if (currentConversationId !== deletedId) return
    const nextActive = nextConversations[0]?.id ?? null
    setCurrentConversationId(nextActive)
    if (!nextActive) {
      setMessages([])
      setHasMoreMessages(false)
    }
  }, [currentConversationId])

  const bootstrap = React.useCallback(async () => {
    setLoading(true)
    setSidebarError(null)
    setChatError(null)
    try {
      const [runtimeInfo, workspaceItems, userProfile] = await Promise.all([
        client.getRuntime(),
        client.listWorkspaces(),
        client.getUserProfile(),
      ])
      setRuntime(runtimeInfo)
      setProfile(userProfile)
      setWorkspaces(workspaceItems)

      const capabilitiesEntries = await Promise.all(
        workspaceItems.map(async (workspace) => [workspace.id, await client.getWorkspaceCapabilities(workspace.id)] as const),
      )
      setWorkspaceCapabilities(Object.fromEntries(capabilitiesEntries))

      const sessionItems = await refreshConversations()
      const activeId = sessionItems[0]?.id ?? null
      setCurrentConversationId(activeId)
      if (activeId) {
        await loadMessages(activeId)
      } else {
        setMessages([])
        setHasMoreMessages(false)
      }
    } catch (err) {
      setSidebarError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [client, loadMessages, refreshConversations])

  React.useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const handleSelectConversation = async (conversationId: string) => {
    setCurrentConversationId(conversationId)
    setEditingMessageId(null)
    await loadMessages(conversationId)
  }

  const handleCreateConversation = async () => {
    setSidebarError(null)
    try {
      const created = await client.createConversation({ title: '新对话' })
      const next = sortConversations([created, ...conversations])
      setConversations(next)
      setCurrentConversationId(created.id)
      setMessages([])
      setHasMoreMessages(false)
    } catch (err) {
      setSidebarError(err instanceof Error ? err.message : '创建对话失败')
    }
  }

  const handleStartRenameConversation = (conversation: ConversationMeta) => {
    setEditingConversationId(conversation.id)
    setEditingTitle(conversationTitleForInput(conversation.title))
  }

  const handleRenameConversation = async (conversationId: string) => {
    const title = editingTitle.trim() || '新对话'
    setSidebarError(null)
    try {
      const updated = await client.renameConversation(conversationId, { title })
      setConversations((prev) => sortConversations(prev.map((item) => (item.id === updated.id ? updated : item))))
      setEditingConversationId(null)
      setEditingTitle('')
    } catch (err) {
      setSidebarError(err instanceof Error ? err.message : '重命名失败')
    }
  }

  const handleDeleteConversation = async (conversationId: string) => {
    setSidebarError(null)
    try {
      await client.deleteConversation(conversationId)
      const next = sortConversations(conversations.filter((item) => item.id !== conversationId))
      setConversations(next)
      selectConversationAfterDeletion(next, conversationId)
    } catch (err) {
      setSidebarError(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleTogglePinConversation = async (conversation: ConversationMeta) => {
    setSidebarError(null)
    try {
      const updated = conversation.pinned
        ? await client.unpinConversation(conversation.id, { pinned: false })
        : await client.pinConversation(conversation.id, { pinned: true })
      setConversations((prev) => sortConversations(prev.map((item) => (item.id === updated.id ? updated : item))))
    } catch (err) {
      setSidebarError(err instanceof Error ? err.message : '置顶操作失败')
    }
  }

  const handleRefreshMessages = async () => {
    if (!currentConversationId) return
    await loadMessages(currentConversationId, { refresh: true })
    await refreshConversations()
  }

  const handleLoadMoreMessages = async () => {
    if (!currentConversationId || !hasMoreMessages || messages.length === 0) return
    await loadMessages(currentConversationId, { append: true, before: messages[0]?.id })
  }

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!currentConversationId || !input.trim()) return

    setSending(true)
    setChatError(null)
    try {
      await client.sendMessage(currentConversationId, { content: input.trim() })
      setInput('')
      await loadMessages(currentConversationId, { refresh: true })
      await refreshConversations()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const handleStartEditMessage = (message: ChatMessage) => {
    setEditingMessageId(message.id)
    setEditingMessageContent(message.content)
  }

  const handleEditMessage = async (messageId: string) => {
    if (!currentConversationId || !editingMessageContent.trim()) return
    setChatError(null)
    try {
      const result = await client.editMessage(currentConversationId, messageId, { content: editingMessageContent.trim() })
      setMessages(result.messages as ChatMessage[])
      setEditingMessageId(null)
      setEditingMessageContent('')
      await refreshConversations()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '编辑消息失败')
    }
  }

  const handleResendMessage = async (messageId: string) => {
    if (!currentConversationId) return
    setChatError(null)
    try {
      await client.resendMessage(currentConversationId, { messageId })
      await loadMessages(currentConversationId, { refresh: true })
      await refreshConversations()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '重发失败')
    }
  }

  const handleTruncateMessages = async (messageId: string) => {
    if (!currentConversationId) return
    setChatError(null)
    try {
      const result = await client.truncateMessages(currentConversationId, { messageId })
      applyMessagesResult(result)
      setEditingMessageId(null)
      await refreshConversations()
    } catch (err) {
      setChatError(err instanceof Error ? err.message : '截断失败')
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

        <button className="primary" onClick={handleCreateConversation}>新对话</button>

        <SidebarSection title="Runtime">
          <div className="card small">
            <div>{runtime?.service}</div>
            <div>{runtime?.environment}</div>
            <div>DB: {runtime?.database.status}</div>
          </div>
        </SidebarSection>

        <SidebarSection title="Workspaces">
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

        {sidebarError ? <div className="error">{sidebarError}</div> : null}

        <SidebarSection
          title="Pinned"
          action={pinnedConversations.length > 0 ? <button className="ghost" onClick={() => setPinnedExpanded((prev) => !prev)}>{pinnedExpanded ? '收起' : '展开'}</button> : null}
        >
          {pinnedExpanded && pinnedConversations.length > 0 ? pinnedConversations.map((conversation) => (
            <ConversationListItem
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === currentConversationId}
              editing={editingConversationId === conversation.id}
              editingTitle={editingTitle}
              onEditingTitleChange={setEditingTitle}
              onSelect={handleSelectConversation}
              onStartRename={handleStartRenameConversation}
              onConfirmRename={handleRenameConversation}
              onCancelRename={() => setEditingConversationId(null)}
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
                  onEditingTitleChange={setEditingTitle}
                  onSelect={handleSelectConversation}
                  onStartRename={handleStartRenameConversation}
                  onConfirmRename={handleRenameConversation}
                  onCancelRename={() => setEditingConversationId(null)}
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

        {chatError ? <div className="error">{chatError}</div> : null}

        {messagesLoading ? <div className="muted">正在加载消息...</div> : null}

        <div className="messages">
          {!messagesLoading && messages.length === 0 ? <div className="empty-state">当前对话还没有消息。</div> : null}
          {messages.map((message: ChatMessage) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-header">
                <div className="role">{message.role}</div>
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
                    onChange={(event) => setEditingMessageContent(event.target.value)}
                    rows={4}
                  />
                  <div className="toolbar">
                    <button className="primary" type="button" onClick={() => void handleEditMessage(message.id)}>保存</button>
                    <button className="ghost" type="button" onClick={() => setEditingMessageId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <div>{message.content}</div>
              )}
            </article>
          ))}
        </div>

        <form className="composer" onSubmit={handleSend}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入一条消息，验证 frontend-core -> platform-web -> Go server"
            rows={4}
          />
          <button className="primary" type="submit" disabled={!currentConversationId || sending}>
            {sending ? '发送中...' : '发送'}
          </button>
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
