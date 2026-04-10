import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import {
  API_BASE,
  DEFAULT_SIDEBAR_WIDTH,
  KEEPALIVE_INTERVAL_MS,
  LEGACY_PROJECT_STORAGE_KEY,
  PROJECT_PATH_PREFIX,
  PROJECT_STORAGE_KEY,
  WS_BASE,
} from '../constants'
import {
  buildSessionTab,
  composeSessionTabs,
  normalizeProjectPathInput,
  normalizeProjects,
  normalizeSessions,
  sameSessionTabs,
} from '../data'
import { clearStorage, readStorage } from '../storage'
import { useWorkspacePanels } from './useWorkspacePanels'

export function useWorkspaceController({
  auth,
  authHeaders,
  clearAuth,
  setLoginError,
}) {
  const [step, setStep] = useState('select')
  const [projects, setProjects] = useState([])
  const [sessions, setSessions] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [sessionTabs, setSessionTabs] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [connected, setConnected] = useState(false)
  const [terminalReconnectState, setTerminalReconnectState] = useState({})

  const [loadingProjects, setLoadingProjects] = useState(true)
  const [projectError, setProjectError] = useState('')
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [createProjectError, setCreateProjectError] = useState('')
  const [editingProjectTarget, setEditingProjectTarget] = useState(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState(null)
  const [deletingProject, setDeletingProject] = useState(false)
  const [deleteProjectError, setDeleteProjectError] = useState('')
  const [closeSessionTarget, setCloseSessionTarget] = useState(null)
  const [closingSession, setClosingSession] = useState(false)
  const [closeSessionError, setCloseSessionError] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectGitUrl, setNewProjectGitUrl] = useState('')
  const [newProjectRuntime, setNewProjectRuntime] = useState('claude')
  const [preferredProjectId, setPreferredProjectId] = useState(() => readStorage(PROJECT_STORAGE_KEY, LEGACY_PROJECT_STORAGE_KEY))

  const wsRef = useRef(null)
  const wsPoolRef = useRef(new Map())
  const keepAliveRef = useRef(new Map())
  const terminalHostRef = useRef(new Map())
  const terminalHostCallbackRef = useRef(new Map())
  const terminalRef = useRef(new Map())
  const fitAddonRef = useRef(new Map())
  const pendingOutputRef = useRef(new Map())
  const terminalCleanupRef = useRef(new Map())
  const projectsRef = useRef([])
  const sessionsRef = useRef([])
  const sessionTabsRef = useRef([])
  const sessionIdRef = useRef(null)
  const stepRef = useRef(step)
  const workspaceShellRef = useRef(null)
  const resetPanelsRef = useRef(() => {})

  const rememberProject = (projectId) => {
    if (!projectId) {
      clearStorage(PROJECT_STORAGE_KEY, LEGACY_PROJECT_STORAGE_KEY)
      setPreferredProjectId('')
      return
    }

    localStorage.setItem(PROJECT_STORAGE_KEY, projectId)
    localStorage.removeItem(LEGACY_PROJECT_STORAGE_KEY)
    setPreferredProjectId(projectId)
  }

  const ensurePendingOutputQueue = (sid) => {
    if (!pendingOutputRef.current.has(sid)) {
      pendingOutputRef.current.set(sid, [])
    }
    return pendingOutputRef.current.get(sid)
  }

  const queueTerminalOutput = (sid, text) => {
    if (!sid || !text) {
      return
    }

    const terminal = terminalRef.current.get(sid)
    if (terminal) {
      terminal.write(text, () => {
        terminal.scrollToBottom()
      })
      return
    }

    ensurePendingOutputQueue(sid).push(text)
  }

  const writeTerminalLine = (sid, text) => {
    queueTerminalOutput(sid, `\r\n${text}\r\n`)
  }

  const flushPendingTerminalOutput = (sid) => {
    const terminal = terminalRef.current.get(sid)
    const chunks = pendingOutputRef.current.get(sid) || []
    if (!terminal || chunks.length === 0) {
      return
    }

    for (const chunk of chunks) {
      terminal.write(chunk, () => {
        terminal.scrollToBottom()
      })
    }
    pendingOutputRef.current.set(sid, [])
  }

  const fitTerminal = (sid) => {
    const fitAddon = fitAddonRef.current.get(sid)
    if (!fitAddon) {
      return
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddon.fit()
      })
    })
  }

  const resetTerminalById = (sid) => {
    if (!sid) {
      return
    }

    pendingOutputRef.current.delete(sid)
    const cleanup = terminalCleanupRef.current.get(sid)
    if (cleanup) {
      cleanup()
      terminalCleanupRef.current.delete(sid)
    }
    terminalRef.current.delete(sid)
    fitAddonRef.current.delete(sid)
    terminalHostCallbackRef.current.delete(sid)
    terminalHostRef.current.delete(sid)
  }

  const resetTerminal = () => {
    pendingOutputRef.current = new Map()
    for (const sid of terminalCleanupRef.current.keys()) {
      resetTerminalById(sid)
    }
  }

  const clearReconnectNotice = (sid) => {
    if (!sid) {
      setTerminalReconnectState({})
      return
    }

    setTerminalReconnectState((prev) => {
      if (!prev[sid]) {
        return prev
      }

      const next = { ...prev }
      delete next[sid]
      return next
    })
  }

  const setReconnectNotice = (sid, message) => {
    if (!sid) {
      return
    }

    setTerminalReconnectState((prev) => {
      const current = prev[sid]
      if (current?.message === message) {
        return prev
      }

      return {
        ...prev,
        [sid]: {
          sessionId: sid,
          message,
        },
      }
    })
  }

  const clearKeepAlive = (sid) => {
    if (!sid) {
      for (const timer of keepAliveRef.current.values()) {
        clearInterval(timer)
      }
      keepAliveRef.current.clear()
      return
    }

    const timer = keepAliveRef.current.get(sid)
    if (timer) {
      clearInterval(timer)
      keepAliveRef.current.delete(sid)
    }
  }

  const attachActiveSocket = (sid) => {
    wsRef.current = sid ? wsPoolRef.current.get(sid) || null : null
  }

  const closeSocketById = (sid, manual = true) => {
    if (!sid) {
      return
    }

    const ws = wsPoolRef.current.get(sid)
    if (!ws) {
      return
    }

    if (wsRef.current === ws) {
      wsRef.current = null
    }

    clearKeepAlive(sid)
    wsPoolRef.current.delete(sid)
    ws._sparkyManualClose = manual

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }

  const closeAllSockets = (manual = true) => {
    clearKeepAlive()
    wsRef.current = null

    const sockets = [...wsPoolRef.current.values()]
    wsPoolRef.current.clear()

    sockets.forEach((ws) => {
      ws._sparkyManualClose = manual
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    })
  }

  const clearAuthState = () => {
    closeAllSockets(true)
    clearAuth()
    setProjects([])
    setSessions([])
    setSessionTabs([])
    setSelectedProject(null)
    setSessionId(null)
    setConnected(false)
    setTerminalReconnectState({})
    setStep('select')
    resetPanelsRef.current()
    resetTerminal()
  }

  const handleUnauthorized = () => {
    clearAuthState()
    setLoginError('登录已失效，请重新登录')
  }

  const panels = useWorkspacePanels({
    auth,
    authHeaders,
    onUnauthorized: handleUnauthorized,
    selectedProject,
    step,
    workspaceShellRef,
  })

  resetPanelsRef.current = panels.resetWorkspacePanels

  const resetCreateProjectForm = () => {
    setCreateProjectOpen(false)
    setCreatingProject(false)
    setCreateProjectError('')
    setEditingProjectTarget(null)
    setNewProjectName('')
    setNewProjectPath('')
    setNewProjectGitUrl('')
    setNewProjectRuntime('claude')
  }

  const openCreateProjectForm = () => {
    setEditingProjectTarget(null)
    setCreateProjectError('')
    setNewProjectName('')
    setNewProjectPath('')
    setNewProjectGitUrl('')
    setNewProjectRuntime('claude')
    setCreateProjectOpen(true)
  }

  const openEditProjectForm = (project) => {
    const projectPath = project.bindDirs.find((dir) => dir !== '/tmp') || PROJECT_PATH_PREFIX
    setEditingProjectTarget(project)
    setCreateProjectError('')
    setNewProjectName(project.name || '')
    setNewProjectPath(normalizeProjectPathInput(projectPath))
    setNewProjectGitUrl(project.gitUrl || '')
    setNewProjectRuntime(project.runtime || 'claude')
    setCreateProjectOpen(true)
  }

  const resetDeleteProjectState = () => {
    setDeleteProjectTarget(null)
    setDeletingProject(false)
    setDeleteProjectError('')
  }

  const loadWorkspaceState = async () => {
    if (!auth?.token) {
      setLoadingProjects(false)
      setProjects([])
      setSessions([])
      return
    }

    setLoadingProjects(true)
    setProjectError('')
    try {
      const [projectsResponse, sessionsResponse] = await Promise.all([
        fetch(`${API_BASE}/projects`, {
          headers: authHeaders(),
        }),
        fetch(`${API_BASE}/sessions`, {
          headers: authHeaders(),
        }),
      ])

      const [projectsData, sessionsData] = await Promise.all([
        projectsResponse.json().catch(() => ({})),
        sessionsResponse.json().catch(() => ({})),
      ])

      if (projectsResponse.status === 401 || sessionsResponse.status === 401) {
        clearAuthState()
        setProjectError('登录已失效，请重新登录')
        return
      }
      if (!projectsResponse.ok) {
        throw new Error(projectsData.error || '加载项目失败')
      }
      if (!sessionsResponse.ok) {
        throw new Error(sessionsData.error || '加载会话失败')
      }

      const normalized = normalizeProjects(projectsData)
      const normalizedSessions = normalizeSessions(sessionsData).filter((session) =>
        normalized.some((project) => project.id === session.projectId),
      )
      setProjects(normalized)
      setSessions(normalizedSessions)

      if (normalized.length === 0) {
        rememberProject('')
      } else if (preferredProjectId && !normalized.some((project) => project.id === preferredProjectId)) {
        rememberProject(normalized[0].id)
      } else if (!preferredProjectId) {
        rememberProject(normalized[0].id)
      }
    } catch (error) {
      setProjects([])
      setProjectError(error.message || '加载项目失败')
    } finally {
      setLoadingProjects(false)
    }
  }

  const ensureTerminal = (sid) => {
    if (!sid || stepRef.current === 'select' || terminalRef.current.has(sid)) {
      return
    }

    const host = terminalHostRef.current.get(sid)
    if (!host) {
      return
    }

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 14,
      lineHeight: 1.3,
      theme: {
        background: '#0c0c0d',
        foreground: '#d1d3db',
        cursor: '#32f08c',
        cursorAccent: '#0c0c0d',
        selectionBackground: 'rgba(50, 240, 140, 0.2)',
        black: '#0c0c0d',
        red: '#f65a5a',
        green: '#32f08c',
        yellow: '#d9b136',
        blue: '#387bff',
        magenta: '#ec93ff',
        cyan: '#04cbe5',
        white: '#f5f9fe',
        brightBlack: '#666b75',
        brightRed: '#ff9392',
        brightGreen: '#60f2bd',
        brightYellow: '#dfb449',
        brightBlue: '#7bb8ff',
        brightMagenta: '#f0d8ff',
        brightCyan: '#a0fde7',
        brightWhite: '#ffffff',
      },
      scrollback: 5000,
      scrollOnUserInput: true,
      allowProposedApi: false,
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(host)

    const scheduleFit = () => {
      fitTerminal(sid)
    }

    terminalRef.current.set(sid, terminal)
    fitAddonRef.current.set(sid, fitAddon)

    const dataDisposable = terminal.onData((data) => {
      const ws = wsPoolRef.current.get(sid)
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return
      }

      ws.send(JSON.stringify({ type: 'input', content: data }))
    })

    flushPendingTerminalOutput(sid)
    scheduleFit()

    const onResize = () => {
      scheduleFit()
    }
    const onFocus = () => {
      if (sessionIdRef.current === sid) {
        terminal.focus()
      }
    }
    const resizeObserver = new ResizeObserver(() => {
      scheduleFit()
    })

    resizeObserver.observe(host)
    if (workspaceShellRef.current && workspaceShellRef.current !== host) {
      resizeObserver.observe(workspaceShellRef.current)
    }

    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    host.addEventListener('pointerdown', onFocus)

    const cleanup = () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      host.removeEventListener('pointerdown', onFocus)
      resizeObserver.disconnect()
      dataDisposable.dispose()
      terminal.dispose()
    }

    terminalCleanupRef.current.set(sid, cleanup)
  }

  const registerTerminalHost = (sid) => {
    if (!terminalHostCallbackRef.current.has(sid)) {
      terminalHostCallbackRef.current.set(sid, (node) => {
        if (!node) {
          terminalHostRef.current.delete(sid)
          resetTerminalById(sid)
          return
        }

        terminalHostRef.current.set(sid, node)
        ensureTerminal(sid)
      })
    }

    return terminalHostCallbackRef.current.get(sid)
  }

  const connectWs = (tab, options = {}) => {
    const sid = tab.id
    const temporary = tab.temporary
    const existingWs = wsPoolRef.current.get(sid)
    if (existingWs && (existingWs.readyState === WebSocket.OPEN || existingWs.readyState === WebSocket.CONNECTING)) {
      if (options.activate !== false) {
        attachActiveSocket(sid)
      }
      clearReconnectNotice(sid)
      if (existingWs.readyState === WebSocket.OPEN && options.activate !== false) {
        setConnected(true)
        setStep('chat')
        fitTerminal(sid)
      } else if (options.activate !== false) {
        setConnected(false)
        setStep('connecting')
      }
      return existingWs
    }

    const tokenQuery = auth?.token ? `?token=${encodeURIComponent(auth.token)}` : ''
    const ws = new WebSocket(`${WS_BASE}/session/${encodeURIComponent(sid)}/ws${tokenQuery}`)
    ws._sparkySessionId = sid
    ws._sparkyManualClose = false
    ws._sparkyExited = false
    ws._sparkyHadError = false
    if (options.activate !== false) {
      wsRef.current = ws
    }
    wsPoolRef.current.set(sid, ws)
    clearReconnectNotice(sid)

    ws.onopen = () => {
      clearReconnectNotice(sid)
      clearKeepAlive(sid)
      keepAliveRef.current.set(sid, window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, KEEPALIVE_INTERVAL_MS))

      if (wsRef.current !== ws) {
        return
      }

      setConnected(true)
      setStep('chat')
      writeTerminalLine(sid, 'PTY 已连接。')
      fitTerminal(sid)
    }

    ws.onclose = () => {
      const wasManualClose = ws._sparkyManualClose === true
      const hasExited = ws._sparkyExited === true
      const hadError = ws._sparkyHadError === true
      clearKeepAlive(sid)
      if (wsPoolRef.current.get(sid) === ws) {
        wsPoolRef.current.delete(sid)
      }
      const isActiveSocket = wsRef.current === ws
      if (isActiveSocket) {
        wsRef.current = null
        setConnected(false)
      }
      if (!wasManualClose && hasExited) {
        setSessions((prev) => prev.filter((item) => item.id !== sid))
        setSessionTabs((prev) => prev.filter((item) => item.id !== sid))
        if (sessionIdRef.current === sid) {
          setSessionId(null)
        }
        clearReconnectNotice(sid)
      }
      if (!wasManualClose) {
        if (hasExited) {
          writeTerminalLine(sid, temporary ? '连接已关闭。临时 PTY 已结束。' : '连接已关闭。会话已结束。')
        } else {
          const message = hadError
            ? 'WebSocket 连接异常。会话仍在保活，可恢复当前 PTY 连接。'
            : '连接已关闭。会话仍在保活，可恢复当前 PTY 连接。'
          setReconnectNotice(sid, message)
          writeTerminalLine(sid, message)
        }
      }
    }

    ws.onerror = () => {
      if (wsPoolRef.current.get(sid) !== ws) {
        return
      }
      ws._sparkyHadError = true
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'output' && typeof data.content === 'string') {
          queueTerminalOutput(sid, data.content)
        } else if (data.type === 'pong') {
          return
        } else if (data.type === 'error') {
          writeTerminalLine(sid, `错误：${data.msg || data.error || ''}`)
        } else if (data.type === 'done') {
          ws._sparkyExited = true
          writeTerminalLine(sid, '进程已结束。')
        } else if (typeof data.content === 'string') {
          queueTerminalOutput(sid, data.content)
        }
      } catch {
        queueTerminalOutput(sid, event.data)
      }
    }

    return ws
  }

  const destroySessionById = async (sid, allowPersistent = false) => {
    if (!sid) {
      return
    }

    const response = await fetch(
      `${API_BASE}/session/${encodeURIComponent(sid)}?allow_persistent=${allowPersistent ? 'true' : 'false'}`,
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    )
    const data = await response.json().catch(() => ({}))

    if (response.status === 401) {
      handleUnauthorized()
      throw new Error('登录已失效，请重新登录')
    }

    if (!response.ok) {
      throw new Error(data.error || '关闭会话失败')
    }

    return data
  }

  const mergeProjects = (baseProjects, project) => {
    if (!project?.id || baseProjects.some((item) => item.id === project.id)) {
      return baseProjects
    }

    return [...baseProjects, project]
  }

  const activateSessionTab = (tab, options = {}) => {
    if (!tab?.id) {
      return
    }

    const project = options.project
      || projectsRef.current.find((item) => item.id === tab.projectId)
      || null

    if (project?.id) {
      rememberProject(project.id)
      setSelectedProject(project)
    }

    setSessionId(tab.id)
    attachActiveSocket(tab.id)
    ensureTerminal(tab.id)
    clearReconnectNotice(tab.id)

    const ws = wsPoolRef.current.get(tab.id)
    if (ws?.readyState === WebSocket.OPEN) {
      setStep('chat')
      setConnected(true)
      fitTerminal(tab.id)
      return
    }

    setConnected(false)
    setStep('connecting')
    connectWs(tab, { activate: true })
  }

  const activatePersistentSession = (project, targetSessionId = '') => {
    if (!project?.id) {
      return
    }

    const nextTabs = composeSessionTabs(
      sessionsRef.current,
      mergeProjects(projectsRef.current, project),
      sessionTabsRef.current,
    )
    const nextTab = targetSessionId
      ? nextTabs.find((tab) => tab.id === targetSessionId)
      : nextTabs.find((tab) => tab.projectId === project.id && !tab.temporary)
        || nextTabs.find((tab) => tab.projectId === project.id)

    if (!nextTab) {
      return
    }

    setSessionTabs(nextTabs)
    activateSessionTab(nextTab, { project })
  }

  const openSessionRequest = async (project, options = {}) => {
    const temporary = Boolean(options.temporary)
    const preserveTabs = Boolean(options.preserveTabs)
    const fresh = Boolean(options.fresh)
    const endpoint = options.endpoint || `${API_BASE}/projects/${encodeURIComponent(project.id)}/session`
    const requestBody = options.body ?? { temporary, fresh }
    const readyMessage = options.readyMessage
      || (temporary
        ? (data) => `临时会话 ${data.session_id} 已就绪，正在连接...\r\n`
        : (data) => `会话 ${data.session_id} 已就绪，正在连接...\r\n`)
    const previousTabs = sessionTabsRef.current
    const previousTab = previousTabs.find((tab) => tab.id === sessionIdRef.current) || null
    const previousProject = selectedProject
    const nextProjects = mergeProjects(projectsRef.current, project)
    rememberProject(project.id)
    setSelectedProject(project)
    if (!sessionIdRef.current) {
      setStep('connecting')
      setConnected(false)
    }
    panels.setGitError('')
    panels.setGitActionResult('')
    panels.setCodexError('')
    panels.setCodexResumeLoading('')

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(requestBody),
      })
      const data = await response.json()

      if (response.status === 401) {
        handleUnauthorized()
        return null
      }

      if (!response.ok || !data.session_id) {
        throw new Error(data.error || '创建会话失败')
      }

      const nextTemporary = Boolean(data.temporary)
      const tab = buildSessionTab(data.session_id, project, nextTemporary, sessionTabsRef.current)
      const nextSessions = [
        {
          id: data.session_id,
          projectId: project.id,
          createdAtMs: Date.now(),
          alive: true,
          temporary: nextTemporary,
        },
        ...sessionsRef.current.filter((item) => item.id !== data.session_id),
      ].sort((a, b) => b.createdAtMs - a.createdAtMs)

      setSessions(nextSessions)
      setSessionTabs((prev) => {
        const preservedTabs = preserveTabs ? prev : prev.filter((item) => !item.temporary)
        return composeSessionTabs(nextSessions, nextProjects, preservedTabs, nextTemporary ? tab : null)
      })
      setSessionId(data.session_id)
      attachActiveSocket(tab.id)
      clearReconnectNotice(tab.id)
      queueTerminalOutput(data.session_id, typeof readyMessage === 'function' ? readyMessage(data) : readyMessage)
      setStep('connecting')
      setConnected(false)
      connectWs(tab, { activate: true })
      return data
    } catch {
      if (previousTab) {
        setSessionTabs(previousTabs)
        setSelectedProject(previousProject)
        activateSessionTab(previousTab, { project: previousProject })
        return null
      }
      setStep('select')
      setSessionTabs([])
      setSelectedProject(null)
      return null
    }
  }

  const openProjectSession = async (project, options = {}) => (
    openSessionRequest(project, options)
  )

  const selectProject = async (project) => {
    const existingSession = sessionsRef.current.find((item) => item.projectId === project.id && !item.temporary)
    if (existingSession) {
      activatePersistentSession(project, existingSession.id)
      return
    }

    await openProjectSession(project, { temporary: false, preserveTabs: false })
  }

  const openPrimarySession = async () => {
    if (!selectedProject?.id) {
      return
    }

    await openProjectSession(selectedProject, {
      temporary: false,
      fresh: true,
      preserveTabs: true,
    })
  }

  const openTemporarySession = async () => {
    if (!selectedProject?.id) {
      return
    }

    await openProjectSession(selectedProject, { temporary: true, preserveTabs: true })
  }

  const resumeCodexSession = async (codexSessionId = '') => {
    if (!selectedProject?.id || selectedProject.runtime !== 'codex') {
      return
    }

    panels.setCodexResumeLoading(codexSessionId || '__latest__')
    panels.setCodexError('')

    try {
      const result = await openSessionRequest(selectedProject, {
        temporary: false,
        preserveTabs: true,
        endpoint: `${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/codex/resume`,
        body: codexSessionId ? { session_id: codexSessionId } : {},
        readyMessage: (data) => `Codex 会话 ${data.codex_session_id || codexSessionId || data.session_id} 已恢复，正在连接...\r\n`,
        failureMessage: '恢复 Codex 会话失败',
      })

      if (result?.session_id) {
        await panels.loadCodexSessions(selectedProject)
      }
    } catch (error) {
      panels.setCodexError(error.message || '恢复 Codex 会话失败')
    } finally {
      panels.setCodexResumeLoading('')
    }
  }

  const switchSessionTab = (tab) => {
    if (!tab?.id) {
      return
    }

    if (tab.id === sessionId && connected) {
      return
    }

    activateSessionTab(tab)
  }

  const leaveSessionView = async () => {
    closeAllSockets(true)
    setStep('select')
    setConnected(false)
    setSessionId(null)
    setSessionTabs([])
    setSelectedProject(null)
    setTerminalReconnectState({})
    panels.resetWorkspacePanels()
    resetTerminal()
    await loadWorkspaceState()
  }

  const requestCloseCurrentSession = () => {
    const activeTab = sessionTabsRef.current.find((tab) => tab.id === sessionIdRef.current)
    if (!activeTab?.id) {
      return
    }

    setCloseSessionTarget(activeTab)
    setCloseSessionError('')
  }

  const resetCloseSessionState = () => {
    if (closingSession) {
      return
    }

    setCloseSessionTarget(null)
    setCloseSessionError('')
  }

  const destroyCurrentSession = async () => {
    const activeTab = closeSessionTarget
      ? sessionTabsRef.current.find((tab) => tab.id === closeSessionTarget.id) || closeSessionTarget
      : sessionTabsRef.current.find((tab) => tab.id === sessionIdRef.current)
    if (!activeTab?.id) {
      return
    }

    setClosingSession(true)
    setCloseSessionError('')

    try {
      await destroySessionById(activeTab.id, !activeTab.temporary)

      const remainingTabs = sessionTabsRef.current.filter((tab) => tab.id !== activeTab.id)
      closeSocketById(activeTab.id, true)
      resetTerminalById(activeTab.id)
      clearReconnectNotice(activeTab.id)
      setCloseSessionTarget(null)
      setCloseSessionError('')
      setClosingSession(false)
      setSessions((prev) => prev.filter((item) => item.id !== activeTab.id))
      setSessionTabs(remainingTabs)
      setConnected(false)
      setSessionId(null)
      panels.setGitError('')
      panels.setGitActionResult('')
      panels.setCommitMessage('')
      panels.setWebRestartLoading(false)
      panels.setCodexError('')
      panels.setCodexResumeLoading('')
      panels.setFileTreeError('')
      panels.setEditorLoadingPath('')

      const fallbackTab = remainingTabs.find((tab) => !tab.temporary && tab.projectId === activeTab.projectId)
        || remainingTabs.find((tab) => !tab.temporary)
        || remainingTabs[remainingTabs.length - 1]
      if (fallbackTab) {
        activateSessionTab(fallbackTab, {
          project: projectsRef.current.find((item) => item.id === fallbackTab.projectId) || null,
        })
        return
      }

      setStep('select')
      setConnected(false)
      setSessionId(null)
      setSessionTabs([])
      setSelectedProject(null)
      setTerminalReconnectState({})
      panels.resetWorkspacePanels()
      resetTerminal()
      await loadWorkspaceState()
    } catch (error) {
      setCloseSessionError(error.message || '关闭会话失败')
      setClosingSession(false)
      return
    }
  }

  const submitCreateProject = async (event) => {
    event.preventDefault()

    const name = newProjectName.trim()
    const projectPath = normalizeProjectPathInput(newProjectPath.trim())
    const gitUrl = newProjectGitUrl.trim()

    if (!name) {
      setCreateProjectError('请输入项目名称')
      return
    }

    if (!projectPath) {
      setCreateProjectError('请输入项目路径')
      return
    }

    setCreatingProject(true)
    setCreateProjectError('')

    try {
      const isEditing = Boolean(editingProjectTarget?.id)
      const response = await fetch(
        isEditing
          ? `${API_BASE}/projects/${encodeURIComponent(editingProjectTarget.id)}`
          : `${API_BASE}/projects`,
        {
          method: isEditing ? 'PATCH' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            name,
            path: projectPath,
            git_url: gitUrl || null,
            runtime: newProjectRuntime,
          }),
        },
      )
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        handleUnauthorized()
        return
      }

      if (!response.ok || !data?.project) {
        throw new Error(data.error || (isEditing ? '更新项目失败' : '创建项目失败'))
      }

      const createdProject = normalizeProjects({ projects: [data.project] })[0]
      rememberProject(createdProject?.id || preferredProjectId || '')
      resetCreateProjectForm()
      await loadWorkspaceState()
    } catch (error) {
      setCreateProjectError(error.message || (editingProjectTarget ? '更新项目失败' : '创建项目失败'))
    } finally {
      setCreatingProject(false)
    }
  }

  const requestDeleteProject = (project) => {
    setDeleteProjectTarget(project)
    setDeleteProjectError('')
  }

  const submitDeleteProject = async () => {
    if (!deleteProjectTarget?.id) {
      return
    }

    setDeletingProject(true)
    setDeleteProjectError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(deleteProjectTarget.id)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        handleUnauthorized()
        return
      }

      if (!response.ok) {
        throw new Error(data.error || '删除项目失败')
      }

      resetDeleteProjectState()
      await loadWorkspaceState()
    } catch (error) {
      setDeleteProjectError(error.message || '删除项目失败')
    } finally {
      setDeletingProject(false)
    }
  }

  const logout = async () => {
    const token = auth?.token
    closeAllSockets(true)
    setStep('select')
    setConnected(false)
    setSessionId(null)
    setSessionTabs([])
    setSelectedProject(null)
    setTerminalReconnectState({})
    panels.resetWorkspacePanels()
    resetTerminal()

    if (token) {
      try {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
      } catch {
        // Best effort logout on server side.
      }
    }

    clearAuthState()
  }

  useEffect(() => {
    sessionTabsRef.current = sessionTabs
  }, [sessionTabs])

  useEffect(() => {
    projectsRef.current = projects
  }, [projects])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    stepRef.current = step
  }, [step])

  useEffect(() => {
    setSessionTabs((prev) => {
      if (prev.length === 0) {
        return prev
      }

      const next = composeSessionTabs(sessions, projects, prev)
      return sameSessionTabs(prev, next) ? prev : next
    })
  }, [projects, sessions])

  useEffect(() => {
    if (auth?.token) {
      loadWorkspaceState()
    }
  }, [auth?.token])

  useEffect(() => {
    if (!selectedProject?.id) {
      return
    }

    const nextProject = projects.find((item) => item.id === selectedProject.id)
    if (nextProject && nextProject !== selectedProject) {
      setSelectedProject(nextProject)
    }
  }, [projects, selectedProject])

  useEffect(() => {
    if (step === 'select') {
      resetTerminal()
      return
    }

    for (const tab of sessionTabs) {
      ensureTerminal(tab.id)
    }
  }, [sessionTabs, step])

  useEffect(() => {
    if (step !== 'select' && sessionId) {
      fitTerminal(sessionId)
    }
  }, [connected, panels.sidebarWidth, panels.sidePanelTab, sessionId, step])

  const totalProjects = projects.length
  const activeSessionCount = sessions.length
  const sessionByProjectId = new Map()
  const sessionCountByProjectId = new Map()
  const temporarySessionCountByProjectId = new Map()

  sessions.forEach((session) => {
    if (!session.temporary && !sessionByProjectId.has(session.projectId)) {
      sessionByProjectId.set(session.projectId, session)
    }
    if (!session.temporary) {
      sessionCountByProjectId.set(session.projectId, (sessionCountByProjectId.get(session.projectId) || 0) + 1)
      return
    }

    temporarySessionCountByProjectId.set(
      session.projectId,
      (temporarySessionCountByProjectId.get(session.projectId) || 0) + 1,
    )
  })

  const projectIndexMap = new Map(projects.map((project, index) => [project.id, index]))
  const orderedProjects = [...projects].sort((a, b) => {
    const preferredDelta = Number(b.id === preferredProjectId) - Number(a.id === preferredProjectId)
    if (preferredDelta) {
      return preferredDelta
    }

    const sessionDelta = (sessionByProjectId.get(b.id)?.createdAtMs || 0) - (sessionByProjectId.get(a.id)?.createdAtMs || 0)
    if (sessionDelta) {
      return sessionDelta
    }

    return (projectIndexMap.get(a.id) || 0) - (projectIndexMap.get(b.id) || 0)
  })

  const activeSessionTab = sessionTabs.find((tab) => tab.id === sessionId) || null
  const activeReconnectNotice = activeSessionTab?.id ? terminalReconnectState[activeSessionTab.id] || null : null
  const currentSessionTemporary = Boolean(activeSessionTab?.temporary)
  const canReconnectCurrentSession = Boolean(activeSessionTab?.id) && !connected && step !== 'connecting'
  const isEditingProject = Boolean(editingProjectTarget?.id)
  const reconnectCurrentSession = () => {
    if (!activeSessionTab?.id) {
      return
    }

    activateSessionTab(activeSessionTab, {
      project: selectedProject || projectsRef.current.find((item) => item.id === activeSessionTab.projectId) || null,
    })
  }
  const sidePanelProps = {
    codexPanelProps: {
      codexError: panels.codexError,
      codexLoading: panels.codexLoading,
      codexResumeLoading: panels.codexResumeLoading,
      codexSessions: panels.codexSessions,
      hasCodexSessions: panels.hasCodexSessions,
      onLoadCodexSessions: () => panels.loadCodexSessions(),
      onResumeCodexSession: resumeCodexSession,
      selectedProjectId: selectedProject?.id,
    },
    filePanelProps: {
      editorLoadingPath: panels.editorLoadingPath,
      fileTreeEntries: panels.fileTreeEntries,
      fileTreeError: panels.fileTreeError,
      fileTreeExpanded: panels.fileTreeExpanded,
      fileTreeLoadingPaths: panels.fileTreeLoadingPaths,
      fileTreeNodes: panels.fileTreeNodes,
      fileTreeRoot: panels.fileTreeRoot,
      onOpenEditor: panels.openEditor,
      onRefresh: () => panels.loadFileTree(selectedProject, '', { replace: true }),
      onToggleFileTreeDirectory: panels.toggleFileTreeDirectory,
      selectedProjectId: selectedProject?.id,
    },
    gitPanelProps: {
      commitMessage: panels.commitMessage,
      gitActionLoading: panels.gitActionLoading,
      gitAvailable: panels.gitAvailable,
      gitError: panels.gitError,
      gitHasRemote: panels.gitHasRemote,
      gitLoading: panels.gitLoading,
      gitOutput: panels.gitOutput,
      gitState: panels.gitState,
      onCommitMessageChange: panels.setCommitMessage,
      onLoadGitStatus: () => panels.loadGitStatus(),
      onRunGitAction: panels.runGitAction,
      selectedProject,
      selectedProjectPath: panels.selectedProjectPath,
    },
    onSelectTab: panels.setSidePanelTab,
    selectedProject,
    sidePanelTab: panels.sidePanelTab,
    webDebugPanelProps: {
      activeWebTarget: panels.activeWebTarget,
      hasWebTargets: panels.hasWebTargets,
      onLoadWebTargets: () => panels.loadWebTargets(),
      onOpenWebDebug: panels.openWebDebug,
      onRestartWebDebug: panels.restartWebDebug,
      onSelectTarget: panels.setSelectedWebTargetId,
      selectedProjectId: selectedProject?.id,
      webActionLoading: panels.webActionLoading,
      webError: panels.webError,
      webLoading: panels.webLoading,
      webRestartLoading: panels.webRestartLoading,
      webTargets: panels.webTargets,
    },
  }
  const terminalPanelProps = {
    canReconnectCurrentSession,
    connected,
    currentSessionTemporary,
    onDestroyCurrentSession: requestCloseCurrentSession,
    onLeaveSessionView: leaveSessionView,
    onOpenTemporarySession: openTemporarySession,
    onReconnectCurrentSession: reconnectCurrentSession,
    onSwitchSessionTab: switchSessionTab,
    reconnectNotice: activeReconnectNotice,
    selectedProject,
    sessionId,
    sessionTabs,
    step,
    registerTerminalHost,
  }
  const sessionCloseModalProps = {
    closeSessionError,
    closeSessionTarget,
    closingSession,
    onClose: resetCloseSessionState,
    onSubmit: destroyCurrentSession,
  }

  return {
    activeSessionCount,
    activatePersistentSession,
    connected,
    createProjectError,
    createProjectOpen,
    creatingProject,
    currentSessionTemporary,
    deleteProjectError,
    deleteProjectTarget,
    deletingProject,
    editingProjectTarget,
    isEditingProject,
    leaveSessionView,
    loadingProjects,
    logout,
    newProjectGitUrl,
    newProjectName,
    newProjectPath,
    newProjectRuntime,
    onProjectPathInputChange: (value) => setNewProjectPath(normalizeProjectPathInput(value)),
    openCreateProjectForm,
    openEditProjectForm,
    openPrimarySession,
    openTemporarySession,
    orderedProjects,
    panels,
    preferredProjectId,
    projectError,
    requestDeleteProject,
    reconnectCurrentSession,
    canReconnectCurrentSession,
    resetSidebarWidth: () => panels.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH),
    resetCreateProjectForm,
    resetDeleteProjectState,
    resumeCodexSession,
    sessionCloseModalProps,
    selectProject,
    selectedProject,
    sessionByProjectId,
    sessionCountByProjectId,
    sessionId,
    sessionTabs,
    sessions,
    setNewProjectGitUrl,
    setNewProjectName,
    setNewProjectRuntime,
    sidePanelProps,
    step,
    loadWorkspaceState,
    submitCreateProject,
    submitDeleteProject,
    switchSessionTab,
    terminalPanelProps,
    temporarySessionCountByProjectId,
    totalProjects,
    workspaceShellRef,
  }
}
