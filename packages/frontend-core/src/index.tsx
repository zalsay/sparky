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
}

function SidebarSection({ title, children }: SidebarSectionProps): React.ReactElement {
  return (
    <section>
      <h2>{title}</h2>
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

export function SparkyApp({ client }: SparkyAppProps): React.ReactElement {
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null)
  const [profile, setProfile] = React.useState<UserProfile | null>(null)
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceCapabilities, setWorkspaceCapabilities] = React.useState<Record<string, WorkspaceCapabilities>>({})
  const [conversations, setConversations] = React.useState<ConversationMeta[]>([])
  const [currentConversationId, setCurrentConversationId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadMessages = React.useCallback(async (conversationId: string) => {
    const result = await client.getMessages(conversationId)
    setMessages(result.messages)
  }, [client])

  const refreshConversations = React.useCallback(async () => {
    const sessionItems = await client.listConversations()
    setConversations(sessionItems)
    return sessionItems
  }, [client])

  const bootstrap = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [runtimeInfo, workspaceItems, sessionItems, userProfile] = await Promise.all([
        client.getRuntime(),
        client.listWorkspaces(),
        client.listConversations(),
        client.getUserProfile(),
      ])
      setRuntime(runtimeInfo)
      setProfile(userProfile)
      setWorkspaces(workspaceItems)
      setConversations(sessionItems)

      const capabilitiesEntries = await Promise.all(
        workspaceItems.map(async (workspace) => [workspace.id, await client.getWorkspaceCapabilities(workspace.id)] as const),
      )
      setWorkspaceCapabilities(Object.fromEntries(capabilitiesEntries))

      const activeId = sessionItems[0]?.id ?? null
      setCurrentConversationId(activeId)
      if (activeId) {
        await loadMessages(activeId)
      } else {
        setMessages([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [client, loadMessages])

  React.useEffect(() => {
    void bootstrap()
  }, [bootstrap])

  const handleSelectConversation = async (conversationId: string) => {
    setCurrentConversationId(conversationId)
    await loadMessages(conversationId)
  }

  const handleCreateConversation = async () => {
    try {
      const created = await client.createConversation({ title: '新对话' })
      const next = [created, ...conversations]
      setConversations(next)
      setCurrentConversationId(created.id)
      setMessages([])
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建对话失败')
    }
  }

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!currentConversationId || !input.trim()) return

    setSending(true)
    setError(null)
    try {
      await client.sendMessage(currentConversationId, { content: input.trim() })
      setInput('')
      await loadMessages(currentConversationId)
      await refreshConversations()
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const conversationGroups = React.useMemo(
    () => groupConversationsByDate(conversations),
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

        <section>
          <h2>Chats</h2>
          {conversationGroups.map((group: { label: string; items: ConversationMeta[] }) => (
            <div key={group.label} className="list">
              <div className="muted">{group.label}</div>
              {group.items.map((conversation: ConversationMeta) => (
                <button
                  key={conversation.id}
                  className={`conversation ${conversation.id === currentConversationId ? 'active' : ''}`}
                  onClick={() => void handleSelectConversation(conversation.id)}
                >
                  <strong>{conversation.title}</strong>
                  <span>{new Date(conversation.updatedAt).toLocaleString()}</span>
                </button>
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
        </header>

        {error ? <div className="error">{error}</div> : null}

        <div className="messages">
          {messages.map((message: ChatMessage) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="role">{message.role}</div>
              <div>{message.content}</div>
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
