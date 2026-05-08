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
  WS_CONNECT_TIMEOUT_MS,
  WS_BASE,
} from '../constants'
import {
  applySessionTabOrder,
  buildSessionTab,
  composeSessionTabs,
  normalizeCodexTimeline,
  normalizeProjectPathInput,
  normalizeProjects,
  normalizeSessions,
  sameSessionTabs,
} from '../data'
import {
  describeContent,
  logSessionDebug,
  socketReadyStateLabel,
  summarizeContentPreview,
} from '../sessionDebug'
import { clearStorage, readStorage } from '../storage'
import { useWorkspacePanels } from './useWorkspacePanels'

export function useWorkspaceController({
  auth,
  authHeaders,
  clearAuth,
  setLoginError,
}) {
  const wait = (ms) => new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
  const emptyCodexTimeline = {
    sessionId: '',
    title: '',
    updatedAtMs: 0,
    items: [],
  }
  const [step, setStep] = useState('select')
  const [projects, setProjects] = useState([])
  const [sessions, setSessions] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [sessionTabs, setSessionTabs] = useState([])
  const [sessionTabOrder, setSessionTabOrder] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [connected, setConnected] = useState(false)
  const [terminalReconnectState, setTerminalReconnectState] = useState({})
  const [codexSessionTitlesByPtySessionId, setCodexSessionTitlesByPtySessionId] = useState({})
  const [activeCodexSessionId, setActiveCodexSessionId] = useState('')
  const [codexTimeline, setCodexTimeline] = useState(emptyCodexTimeline)
  const [codexTimelineLoading, setCodexTimelineLoading] = useState(false)
  const [codexTimelineError, setCodexTimelineError] = useState('')

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
  const [newProjectRuntime, setNewProjectRuntime] = useState('codex')
  const [projectRepoOptions, setProjectRepoOptions] = useState([])
  const [projectRepoLoading, setProjectRepoLoading] = useState(false)
  const [selectedProjectRepoPath, setSelectedProjectRepoPath] = useState('')
  const [preferredProjectId, setPreferredProjectId] = useState(() => readStorage(PROJECT_STORAGE_KEY, LEGACY_PROJECT_STORAGE_KEY))

  const wsRef = useRef(null)
  const wsPoolRef = useRef(new Map())
  const keepAliveRef = useRef(new Map())
  const connectTimeoutRef = useRef(new Map())
  const reconnectingSessionRef = useRef(new Set())
  const terminalHostRef = useRef(new Map())
  const terminalHostCallbackRef = useRef(new Map())
  const terminalRef = useRef(new Map())
  const fitAddonRef = useRef(new Map())
  const pendingOutputRef = useRef(new Map())
  const pendingInputRef = useRef(new Map())
  const lastMeasuredTerminalSizeRef = useRef(new Map())
  const lastSentTerminalSizeRef = useRef(new Map())
  const terminalCleanupRef = useRef(new Map())
  const projectsRef = useRef([])
  const sessionsRef = useRef([])
  const sessionTabsRef = useRef([])
  const sessionTabOrderRef = useRef([])
  const sessionIdRef = useRef(null)
  const stepRef = useRef(step)
  const workspaceShellRef = useRef(null)
  const resetPanelsRef = useRef(() => {})
  const lastLoadedCodexSessionIdRef = useRef('')
  const projectRepoRequestIdRef = useRef(0)

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
    const terminal = terminalRef.current.get(sid)
    if (!fitAddon || !terminal) {
      return
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const dimensions = fitAddon.proposeDimensions()
        if (!dimensions) {
          return
        }

        fitAddon.fit()
        lastMeasuredTerminalSizeRef.current.set(sid, dimensions)

        const ws = wsPoolRef.current.get(sid)
        const lastSent = lastSentTerminalSizeRef.current.get(sid)
        const hasChanged = !lastSent
          || lastSent.rows !== dimensions.rows
          || lastSent.cols !== dimensions.cols

        if (ws?.readyState === WebSocket.OPEN && hasChanged) {
          sendWsPayload(sid, ws, {
            type: 'resize',
            rows: dimensions.rows,
            cols: dimensions.cols,
          }, {
            source: 'fit_terminal',
            rows: dimensions.rows,
            cols: dimensions.cols,
          })
          lastSentTerminalSizeRef.current.set(sid, dimensions)
        }
      })
    })
  }

  const configureTerminalTextarea = (terminal) => {
    const textarea = terminal?.textarea
    if (!textarea) {
      return
    }

    textarea.autocapitalize = 'off'
    textarea.autocomplete = 'off'
    textarea.autocorrect = 'off'
    textarea.enterKeyHint = 'enter'
    textarea.spellcheck = false
    textarea.setAttribute('autocapitalize', 'off')
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('data-gramm', 'false')
    textarea.setAttribute('inputmode', 'text')
  }

  const setTerminalInputEnabled = (terminal, enabled) => {
    const textarea = terminal?.textarea
    if (!textarea) {
      return
    }

    if (enabled) {
      textarea.readOnly = false
      textarea.removeAttribute('readonly')
      textarea.setAttribute('inputmode', 'text')
      return
    }

    textarea.blur()
    textarea.readOnly = true
    textarea.setAttribute('readonly', 'readonly')
    textarea.setAttribute('inputmode', 'none')
  }

  const createKeyboardEchoDeduper = () => {
    let pendingKey = null

    return {
      noteKey(key, domEvent) {
        if (
          !key
          || Array.from(key).length !== 1
          || domEvent?.ctrlKey
          || domEvent?.altKey
          || domEvent?.metaKey
        ) {
          pendingKey = null
          return
        }

        pendingKey = {
          atMs: Date.now(),
          forwarded: false,
          key,
        }
      },
      shouldSuppress(data) {
        if (!pendingKey) {
          return false
        }

        const expired = (Date.now() - pendingKey.atMs) > 80
        if (expired || data !== pendingKey.key) {
          if (expired || pendingKey.forwarded) {
            pendingKey = null
          }
          return false
        }

        if (!pendingKey.forwarded) {
          pendingKey.forwarded = true
          return false
        }

        pendingKey = null
        return true
      },
    }
  }

  const resetTerminalById = (sid) => {
    if (!sid) {
      return
    }

    pendingOutputRef.current.delete(sid)
    pendingInputRef.current.delete(sid)
    lastMeasuredTerminalSizeRef.current.delete(sid)
    lastSentTerminalSizeRef.current.delete(sid)
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
    pendingInputRef.current = new Map()
    for (const sid of terminalCleanupRef.current.keys()) {
      resetTerminalById(sid)
    }
  }

  const ensurePendingInputQueue = (sid) => {
    if (!pendingInputRef.current.has(sid)) {
      pendingInputRef.current.set(sid, [])
    }
    return pendingInputRef.current.get(sid)
  }

  const serializeSessionInput = (content) => {
    const value = String(content || '')
    if (!value) {
      return []
    }

    return [value]
  }

  const normalizeSessionInput = (content, options = {}) => {
    const value = String(content || '')
    if (!value) {
      return ''
    }

    let normalized = value

    if (options.replaceIntermediateReturns) {
      const treatAsBulkInput = options.bulkInput === true || normalized.length > 1

      if (treatAsBulkInput) {
        normalized = normalized.replace(/\r\n|\r|\n/g, ' ')
      } else {
        const trailingBreakMatch = normalized.match(/(?:\r\n|\r|\n)+$/)
        const trailingBreaks = trailingBreakMatch ? trailingBreakMatch[0] : ''
        const body = trailingBreaks
          ? normalized.slice(0, normalized.length - trailingBreaks.length)
          : normalized

        normalized = `${body.replace(/\r\n|\r|\n/g, ' ')}${trailingBreaks}`
      }
    }

    if (options.ensureTrailingReturn && !/[\r\n]$/.test(normalized)) {
      normalized = `${normalized}\r`
    }

    return normalized
  }

  const flushPendingSessionInput = (sid, ws) => {
    if (!sid || !ws || ws.readyState !== WebSocket.OPEN) {
      logSessionDebug('session_input_flush_skipped', {
        sid,
        hasSocket: Boolean(ws),
        readyState: ws ? socketReadyStateLabel(ws.readyState) : 'NO_SOCKET',
      })
      return
    }

    const chunks = pendingInputRef.current.get(sid) || []
    if (!chunks.length) {
      logSessionDebug('session_input_flush_empty', {
        sid,
      })
      return
    }

    logSessionDebug('session_input_flush_start', {
      sid,
      chunkCount: chunks.length,
      preview: summarizeContentPreview(chunks.join('')),
      wsUrl: ws.url || '',
    })
    chunks.forEach((chunk) => {
      ws.send(JSON.stringify({ type: 'input', content: chunk }))
    })
    pendingInputRef.current.set(sid, [])
    logSessionDebug('session_input_flush_done', {
      sid,
      chunkCount: chunks.length,
    })
  }

  const sendWsPayload = (sid, ws, payload, meta = {}) => {
    if (!ws) {
      logSessionDebug('ws_send_skipped', {
        sid,
        reason: 'missing_socket',
        payloadType: payload?.type || '',
        ...meta,
      })
      return false
    }

    logSessionDebug('ws_send', {
      sid,
      wsUrl: ws.url || '',
      readyState: socketReadyStateLabel(ws.readyState),
      payloadType: payload?.type || '',
      contentPreview: payload && typeof payload.content === 'string'
        ? summarizeContentPreview(payload.content)
        : '',
      ...meta,
    })
    ws.send(JSON.stringify(payload))
    return true
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

  const clearConnectTimeout = (sid) => {
    if (!sid) {
      for (const timer of connectTimeoutRef.current.values()) {
        clearTimeout(timer)
      }
      connectTimeoutRef.current.clear()
      return
    }

    const timer = connectTimeoutRef.current.get(sid)
    if (timer) {
      clearTimeout(timer)
      connectTimeoutRef.current.delete(sid)
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
    clearConnectTimeout(sid)
    wsPoolRef.current.delete(sid)
    ws._sparkyManualClose = manual

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }

  const dropSocketById = (sid, manual = true) => {
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
    clearConnectTimeout(sid)
    wsPoolRef.current.delete(sid)
    ws._sparkyManualClose = manual

    try {
      ws.close()
    } catch {
      // Ignore close failures on stale sockets.
    }
  }

  const closeAllSockets = (manual = true) => {
    clearKeepAlive()
    clearConnectTimeout()
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
    setSessionTabOrder([])
    setSelectedProject(null)
    setSessionId(null)
    setConnected(false)
    setTerminalReconnectState({})
    setCodexSessionTitlesByPtySessionId({})
    setActiveCodexSessionId('')
    setCodexTimeline(emptyCodexTimeline)
    setCodexTimelineLoading(false)
    setCodexTimelineError('')
    setStep('select')
    resetPanelsRef.current()
    resetTerminal()
    lastLoadedCodexSessionIdRef.current = ''
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
    projectRepoRequestIdRef.current += 1
    setCreateProjectOpen(false)
    setCreatingProject(false)
    setCreateProjectError('')
    setEditingProjectTarget(null)
    setNewProjectName('')
    setNewProjectPath('')
    setNewProjectGitUrl('')
    setNewProjectRuntime('codex')
    setProjectRepoOptions([])
    setProjectRepoLoading(false)
    setSelectedProjectRepoPath('')
  }

  const openCreateProjectForm = () => {
    projectRepoRequestIdRef.current += 1
    setEditingProjectTarget(null)
    setCreateProjectError('')
    setNewProjectName('')
    setNewProjectPath('')
    setNewProjectGitUrl('')
    setNewProjectRuntime('codex')
    setProjectRepoOptions([])
    setProjectRepoLoading(false)
    setSelectedProjectRepoPath('')
    setCreateProjectOpen(true)
  }

  const openEditProjectForm = (project) => {
    projectRepoRequestIdRef.current += 1
    const projectPath = project.bindDirs.find((dir) => dir !== '/tmp') || PROJECT_PATH_PREFIX
    setEditingProjectTarget(project)
    setCreateProjectError('')
    setNewProjectName(project.name || '')
    setNewProjectPath(normalizeProjectPathInput(projectPath))
    setNewProjectGitUrl(project.gitUrl || '')
    setNewProjectRuntime('codex')
    setProjectRepoOptions([])
    setProjectRepoLoading(false)
    setSelectedProjectRepoPath(normalizeProjectPathInput(projectPath))
    setCreateProjectOpen(true)
  }

  useEffect(() => {
    if (!createProjectOpen) {
      return undefined
    }

    const normalizedPath = normalizeProjectPathInput(newProjectPath.trim())
    if (!normalizedPath) {
      setProjectRepoOptions([])
      setProjectRepoLoading(false)
      setSelectedProjectRepoPath('')
      return undefined
    }

    const requestId = projectRepoRequestIdRef.current + 1
    projectRepoRequestIdRef.current = requestId
    setProjectRepoLoading(true)

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`${API_BASE}/projects/git/repositories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            path: normalizedPath,
          }),
        })
        const data = await response.json().catch(() => ({}))

        if (response.status === 401) {
          handleUnauthorized()
          return
        }

        if (projectRepoRequestIdRef.current !== requestId) {
          return
        }

        if (!response.ok) {
          setProjectRepoOptions([])
          setSelectedProjectRepoPath('')
          return
        }

        const nextOptions = Array.isArray(data?.repositories)
          ? data.repositories
            .map((item) => ({
              path: normalizeProjectPathInput(item.relative_path || item.path || ''),
              label: item.relative_path || item.path || '',
            }))
            .filter((item) => item.path)
          : []

        setProjectRepoOptions(nextOptions)
        setSelectedProjectRepoPath((current) => {
          if (current && nextOptions.some((item) => item.path === current)) {
            return current
          }
          if (nextOptions.some((item) => item.path === normalizedPath)) {
            return normalizedPath
          }
          if (nextOptions.length === 1) {
            return nextOptions[0].path
          }
          return ''
        })
      } catch {
        if (projectRepoRequestIdRef.current === requestId) {
          setProjectRepoOptions([])
          setSelectedProjectRepoPath('')
        }
      } finally {
        if (projectRepoRequestIdRef.current === requestId) {
          setProjectRepoLoading(false)
        }
      }
    }, 220)

    return () => {
      window.clearTimeout(timer)
    }
  }, [auth?.token, createProjectOpen, newProjectPath])

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

  const loadCodexTimeline = async (
    codexSessionId = '',
    project = selectedProject,
    targetPtySessionId = '',
    options = {},
  ) => {
    const background = options.background === true
    if (!auth?.token || !project?.id || project.runtime !== 'codex') {
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineLoading(false)
      setCodexTimelineError('')
      lastLoadedCodexSessionIdRef.current = ''
      return null
    }

    const targetSessionId = codexSessionId || activeCodexSessionId || panels.codexSessions[0]?.sessionId || ''
    if (!targetSessionId) {
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineError('')
      setCodexTimelineLoading(false)
      lastLoadedCodexSessionIdRef.current = ''
      return null
    }

    if (!background) {
      setCodexTimelineLoading(true)
      setCodexTimelineError('')
    }

    try {
      const response = await fetch(
        `${API_BASE}/projects/${encodeURIComponent(project.id)}/codex/sessions/${encodeURIComponent(targetSessionId)}/timeline`,
        {
          headers: authHeaders(),
        },
      )
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        handleUnauthorized()
        return null
      }

      if (!response.ok) {
        throw new Error(data.error || '加载 Codex 会话详情失败')
      }

      const normalized = normalizeCodexTimeline(data)
      const resolvedId = normalized.sessionId || targetSessionId
      setActiveCodexSessionId(resolvedId)
      setCodexTimeline(normalized)
      if (project.runtime === 'codex' && targetPtySessionId) {
        setCodexSessionTitlesByPtySessionId((prev) => (
          prev[targetPtySessionId] === (normalized.title || '')
            ? prev
            : {
                ...prev,
                [targetPtySessionId]: normalized.title || '',
              }
        ))
        setSessions((prev) => prev.map((session) => (
          session.id === targetPtySessionId
            ? { ...session, codexSessionId: resolvedId }
            : session
        )))
        setSessionTabs((prev) => prev.map((tab) => (
          tab.id === targetPtySessionId
            ? { ...tab, codexSessionId: resolvedId }
            : tab
        )))
      }
      lastLoadedCodexSessionIdRef.current = resolvedId
      return normalized
    } catch (error) {
      if (!background) {
        setCodexTimeline(emptyCodexTimeline)
        setCodexTimelineError(error.message || '加载 Codex 会话详情失败')
        lastLoadedCodexSessionIdRef.current = ''
      }
      return null
    } finally {
      if (!background) {
        setCodexTimelineLoading(false)
      }
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

    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
    const mobileTerminalFontSize = viewportWidth <= 780 ? 10 : 14
    const mobileTerminalLineHeight = viewportWidth <= 780 ? 1.16 : 1.3

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: mobileTerminalFontSize,
      lineHeight: mobileTerminalLineHeight,
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
    const keyboardEchoDeduper = createKeyboardEchoDeduper()

    terminal.loadAddon(fitAddon)
    terminal.open(host)
    configureTerminalTextarea(terminal)

    const scheduleFit = () => {
      fitTerminal(sid)
    }

    terminalRef.current.set(sid, terminal)
    fitAddonRef.current.set(sid, fitAddon)

    const keyDisposable = terminal.onKey(({ key, domEvent }) => {
      logSessionDebug('terminal_key', {
        sid,
        key: describeContent(key),
        altKey: Boolean(domEvent?.altKey),
        ctrlKey: Boolean(domEvent?.ctrlKey),
        metaKey: Boolean(domEvent?.metaKey),
        shiftKey: Boolean(domEvent?.shiftKey),
        code: domEvent?.code || '',
        inputType: domEvent?.inputType || '',
        isComposing: Boolean(domEvent?.isComposing),
        keyCode: Number(domEvent?.keyCode || 0),
      })
      keyboardEchoDeduper.noteKey(key, domEvent)
    })

    const dataDisposable = terminal.onData((data) => {
      logSessionDebug('terminal_on_data', {
        sid,
        data: describeContent(data),
      })

      if (keyboardEchoDeduper.shouldSuppress(data)) {
        logSessionDebug('terminal_input_suppressed_duplicate', {
          sid,
          preview: summarizeContentPreview(data),
        })
        return
      }

      const ws = wsPoolRef.current.get(sid)
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        logSessionDebug('terminal_input_drop', {
          sid,
          hasSocket: Boolean(ws),
          readyState: ws ? socketReadyStateLabel(ws.readyState) : 'NO_SOCKET',
          preview: summarizeContentPreview(data),
        })
        return
      }

      const normalizedData = normalizeSessionInput(data, {
        replaceIntermediateReturns: true,
        bulkInput: data.length > 1,
      })

      logSessionDebug('terminal_on_data_normalized', {
        sid,
        original: describeContent(data),
        normalized: describeContent(normalizedData),
      })

      sendWsPayload(sid, ws, { type: 'input', content: normalizedData }, {
        source: 'terminal_on_data',
        replacedIntermediateReturns: normalizedData !== data,
        originalPreview: summarizeContentPreview(data),
      })
    })

    flushPendingTerminalOutput(sid)
    scheduleFit()

    const requiresDoubleTapInput = () => {
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
      return viewportWidth <= 780 && Boolean(host.closest('.codex-raw-terminal-sheet__body'))
    }
    const syncTerminalInputMode = () => {
      setTerminalInputEnabled(terminal, !requiresDoubleTapInput())
    }

    syncTerminalInputMode()

    const onResize = () => {
      syncTerminalInputMode()
      scheduleFit()
    }
    const onPointerDown = () => {
      if (sessionIdRef.current === sid) {
        if (requiresDoubleTapInput()) {
          return
        }

        setTerminalInputEnabled(terminal, true)
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
    host.addEventListener('pointerdown', onPointerDown)

    const cleanup = () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      host.removeEventListener('pointerdown', onPointerDown)
      resizeObserver.disconnect()
      keyDisposable.dispose()
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

  const sendSessionInput = (sid, content, options = {}) => {
    const normalizedContent = normalizeSessionInput(content, options)
    const chunks = serializeSessionInput(normalizedContent)
    const ws = wsPoolRef.current.get(sid)
    logSessionDebug('mobile_session_input_called', {
      sid,
      chunkCount: chunks.length,
      preview: summarizeContentPreview(normalizedContent),
      ensureTrailingReturn: Boolean(options.ensureTrailingReturn),
      hasTrailingReturn: /[\r\n]$/.test(normalizedContent),
      hasSocket: Boolean(ws),
      readyState: ws ? socketReadyStateLabel(ws.readyState) : 'NO_SOCKET',
      activeSessionId: sessionIdRef.current,
      step: stepRef.current,
    })

    if (!sid || chunks.length === 0) {
      logSessionDebug('mobile_session_input_rejected', {
        sid,
        reason: !sid ? 'missing_session_id' : 'empty_chunks',
      })
      return false
    }

    if (ws?.readyState === WebSocket.OPEN) {
      chunks.forEach((chunk) => {
        sendWsPayload(sid, ws, { type: 'input', content: chunk }, {
          source: 'mobile_composer',
        })
      })
      logSessionDebug('mobile_session_input_sent', {
        sid,
        chunkCount: chunks.length,
        hasTrailingReturn: /[\r\n]$/.test(normalizedContent),
      })
      return true
    }

    ensurePendingInputQueue(sid).push(...chunks)
    logSessionDebug('mobile_session_input_queued', {
      sid,
      chunkCount: chunks.length,
      queuedCount: ensurePendingInputQueue(sid).length,
      hasTrailingReturn: /[\r\n]$/.test(normalizedContent),
      readyState: ws ? socketReadyStateLabel(ws.readyState) : 'NO_SOCKET',
    })

    const targetTab = sessionTabsRef.current.find((tab) => tab.id === sid)
    if (targetTab) {
      logSessionDebug('mobile_session_input_reconnect', {
        sid,
        forceReconnect: ws?.readyState === WebSocket.CLOSING || ws?.readyState === WebSocket.CLOSED,
        active: sessionIdRef.current === sid,
      })
      connectWs(targetTab, {
        activate: sessionIdRef.current === sid,
        forceReconnect: ws?.readyState === WebSocket.CLOSING || ws?.readyState === WebSocket.CLOSED,
      })
      if (sessionIdRef.current === sid) {
        setConnected(false)
        setStep('connecting')
      }
      return true
    }

    pendingInputRef.current.delete(sid)
    logSessionDebug('mobile_session_input_failed', {
      sid,
      reason: 'missing_target_tab',
    })
    return false
  }

  const connectWs = (tab, options = {}) => {
    const sid = tab.id
    const temporary = tab.temporary
    const existingWs = wsPoolRef.current.get(sid)
    const forceReconnect = options.forceReconnect === true

    logSessionDebug('connect_ws_start', {
      sid,
      forceReconnect,
      activate: options.activate !== false,
      hasExistingSocket: Boolean(existingWs),
      existingReadyState: existingWs ? socketReadyStateLabel(existingWs.readyState) : 'NO_SOCKET',
    })

    if (existingWs && !forceReconnect && (existingWs.readyState === WebSocket.OPEN || existingWs.readyState === WebSocket.CONNECTING)) {
      if (options.activate !== false) {
        attachActiveSocket(sid)
      }
      logSessionDebug('connect_ws_reuse_existing', {
        sid,
        readyState: socketReadyStateLabel(existingWs.readyState),
        wsUrl: existingWs.url || '',
      })
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

    if (existingWs) {
      dropSocketById(sid, true)
    }
    lastSentTerminalSizeRef.current.delete(sid)

    const tokenQuery = auth?.token ? `?token=${encodeURIComponent(auth.token)}` : ''
    const ws = new WebSocket(`${WS_BASE}/session/${encodeURIComponent(sid)}/ws${tokenQuery}`)
    logSessionDebug('connect_ws_created', {
      sid,
      wsUrl: ws.url || `${WS_BASE}/session/${encodeURIComponent(sid)}/ws${tokenQuery}`,
    })
    ws._sparkySessionId = sid
    ws._sparkyManualClose = false
    ws._sparkyExited = false
    ws._sparkyHadError = false
    if (options.activate !== false) {
      wsRef.current = ws
    }
    wsPoolRef.current.set(sid, ws)
    clearReconnectNotice(sid)
    clearConnectTimeout(sid)
    connectTimeoutRef.current.set(sid, window.setTimeout(() => {
      if (wsPoolRef.current.get(sid) !== ws || ws.readyState !== WebSocket.CONNECTING) {
        return
      }

      ws._sparkyHadError = true
      reconnectingSessionRef.current.delete(sid)
      try {
        ws.close()
      } catch {
        if (wsPoolRef.current.get(sid) === ws) {
          wsPoolRef.current.delete(sid)
        }
        if (wsRef.current === ws) {
          wsRef.current = null
          setConnected(false)
          if (sessionIdRef.current === sid) {
            setStep('chat')
          }
        }
        setReconnectNotice(sid, 'WebSocket 连接超时。会话仍在保活，可恢复当前 PTY 连接。')
      }
    }, WS_CONNECT_TIMEOUT_MS))

    ws.onopen = () => {
      logSessionDebug('connect_ws_open', {
        sid,
        wsUrl: ws.url || '',
      })
      reconnectingSessionRef.current.delete(sid)
      clearConnectTimeout(sid)
      clearReconnectNotice(sid)
      clearKeepAlive(sid)
      keepAliveRef.current.set(sid, window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          sendWsPayload(sid, ws, { type: 'ping' }, {
            source: 'keepalive',
          })
        }
      }, KEEPALIVE_INTERVAL_MS))
      flushPendingSessionInput(sid, ws)
      lastSentTerminalSizeRef.current.delete(sid)

      if (wsRef.current !== ws) {
        return
      }

      setConnected(true)
      setStep('chat')
      writeTerminalLine(sid, 'PTY 已连接。')
      fitTerminal(sid)
    }

    ws.onclose = () => {
      logSessionDebug('connect_ws_close', {
        sid,
        wsUrl: ws.url || '',
        manualClose: ws._sparkyManualClose === true,
        exited: ws._sparkyExited === true,
        hadError: ws._sparkyHadError === true,
      })
      reconnectingSessionRef.current.delete(sid)
      clearConnectTimeout(sid)
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
        if (!hasExited && sessionIdRef.current === sid) {
          setStep('chat')
        }
      }
      if (!wasManualClose && hasExited) {
        setSessions((prev) => prev.filter((item) => item.id !== sid))
        commitSessionTabs(sessionTabsRef.current.filter((item) => item.id !== sid))
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
      logSessionDebug('connect_ws_error', {
        sid,
        wsUrl: ws.url || '',
      })
      if (wsPoolRef.current.get(sid) !== ws) {
        return
      }
      ws._sparkyHadError = true
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        logSessionDebug('connect_ws_message', {
          sid,
          wsUrl: ws.url || '',
          messageType: data?.type || '',
          contentPreview: typeof data?.content === 'string'
            ? summarizeContentPreview(data.content)
            : '',
        })
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
        logSessionDebug('connect_ws_message_raw', {
          sid,
          wsUrl: ws.url || '',
          preview: summarizeContentPreview(event.data),
        })
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

  const sameIdOrder = (left, right) => {
    if (left === right) {
      return true
    }

    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }

    return left.every((id, index) => id === right[index])
  }

  const deriveSessionTabOrder = (tabs, preferredOrder = sessionTabOrderRef.current) => {
    const nextIds = tabs.map((tab) => tab.id)
    const nextIdSet = new Set(nextIds)
    const preservedIds = preferredOrder.filter((id) => nextIdSet.has(id))
    const preservedIdSet = new Set(preservedIds)
    const appendedIds = nextIds.filter((id) => !preservedIdSet.has(id))

    return [...preservedIds, ...appendedIds]
  }

  const getOrderedSessionTabs = (tabs, preferredOrder = sessionTabOrderRef.current) => {
    const nextOrder = deriveSessionTabOrder(tabs, preferredOrder)
    return {
      nextOrder,
      orderedTabs: applySessionTabOrder(tabs, nextOrder),
    }
  }

  const commitSessionTabs = (tabs, preferredOrder = sessionTabOrderRef.current) => {
    const { nextOrder, orderedTabs } = getOrderedSessionTabs(tabs, preferredOrder)

    setSessionTabOrder((prev) => (sameIdOrder(prev, nextOrder) ? prev : nextOrder))
    setSessionTabs((prev) => (sameSessionTabs(prev, orderedTabs) ? prev : orderedTabs))

    return orderedTabs
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
    connectWs(tab, { activate: true, forceReconnect: options.forceReconnect === true })
  }

  const activatePersistentSession = (project, targetSessionId = '') => {
    if (!project?.id) {
      return
    }

    const nextTabs = commitSessionTabs(composeSessionTabs(
      sessionsRef.current,
      mergeProjects(projectsRef.current, project),
      sessionTabsRef.current,
    ))
    const nextTab = targetSessionId
      ? nextTabs.find((tab) => tab.id === targetSessionId)
      : nextTabs.find((tab) => tab.projectId === project.id && !tab.temporary)
        || nextTabs.find((tab) => tab.projectId === project.id)

    if (!nextTab) {
      return
    }

    activateSessionTab(nextTab, { project })
  }

  const reorderSessionTab = (draggedId, targetId, placement = 'before') => {
    if (!draggedId || !targetId || draggedId === targetId) {
      return
    }

    const currentTabs = sessionTabsRef.current
    const currentOrder = currentTabs.map((tab) => tab.id)
    if (!currentOrder.includes(draggedId) || !currentOrder.includes(targetId)) {
      return
    }

    const nextOrder = currentOrder.filter((id) => id !== draggedId)
    const targetIndex = nextOrder.indexOf(targetId)
    if (targetIndex < 0) {
      return
    }

    const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
    nextOrder.splice(insertIndex, 0, draggedId)
    if (sameIdOrder(currentOrder, nextOrder)) {
      return
    }

    commitSessionTabs(currentTabs, nextOrder)
  }

  const syncCodexHistoryAfterSessionOpen = async ({
    project,
    ptySessionId,
    preferredCodexSessionId = '',
    knownHistorySessionIds = [],
  }) => {
    if (!project?.id || project.runtime !== 'codex' || !ptySessionId) {
      return ''
    }

    const attempts = [0, 800, 1600, 3200, 5000]
    const seenHistoryIds = new Set(
      knownHistorySessionIds
        .concat(panels.codexSessions.map((item) => item.sessionId))
        .filter(Boolean),
    )

    for (const delayMs of attempts) {
      if (delayMs > 0) {
        await wait(delayMs)
      }

      const normalized = await panels.loadCodexSessions(project)
      if (!normalized) {
        return ''
      }

      const historySessions = normalized.historySessions || []
      if (historySessions.length === 0) {
        continue
      }

      let targetCodexSessionId = preferredCodexSessionId
      if (!targetCodexSessionId || !historySessions.some((item) => item.sessionId === targetCodexSessionId)) {
        targetCodexSessionId = (
          historySessions.find((item) => !seenHistoryIds.has(item.sessionId))
          || historySessions[0]
        )?.sessionId || ''
      }

      historySessions.forEach((item) => {
        if (item.sessionId) {
          seenHistoryIds.add(item.sessionId)
        }
      })

      if (!targetCodexSessionId) {
        continue
      }

      const timeline = await loadCodexTimeline(targetCodexSessionId, project, ptySessionId)
      return timeline?.sessionId || targetCodexSessionId
    }

    return ''
  }

  const loadCodexSessionTitlesForProject = async (project, projectSessions = []) => {
    if (!project?.id || project.runtime !== 'codex') {
      return {}
    }

    const normalized = await panels.loadCodexSessions(project)
    if (!normalized) {
      return {}
    }

    const titleByCodexSessionId = Object.fromEntries(
      (normalized.historySessions || [])
        .filter((item) => item.sessionId)
        .map((item) => [item.sessionId, item.title || '']),
    )

    const titleByPtySessionId = {}
    projectSessions.forEach((session) => {
      const title = titleByCodexSessionId[session.codexSessionId || '']
      if (title) {
        titleByPtySessionId[session.id] = title
      }
    })

    setCodexSessionTitlesByPtySessionId((prev) => ({
      ...prev,
      ...titleByPtySessionId,
    }))

    return titleByPtySessionId
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
    const knownCodexHistorySessionIds = project.runtime === 'codex'
      ? panels.codexSessions.map((item) => item.sessionId).filter(Boolean)
      : []
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
      const codexSessionId = data.codex_session_id || ''
      const tab = buildSessionTab(
        data.session_id,
        project,
        nextTemporary,
        sessionTabsRef.current,
        codexSessionId,
      )
      const nextSessions = [
        {
          id: data.session_id,
          projectId: project.id,
          createdAtMs: Date.now(),
          alive: true,
          temporary: nextTemporary,
          codexSessionId,
        },
        ...sessionsRef.current.filter((item) => item.id !== data.session_id),
      ].sort((a, b) => b.createdAtMs - a.createdAtMs)

      setSessions(nextSessions)
      const preservedTabs = preserveTabs
        ? sessionTabsRef.current
        : sessionTabsRef.current.filter((item) => !item.temporary)
      commitSessionTabs(
        composeSessionTabs(nextSessions, nextProjects, preservedTabs, nextTemporary ? tab : null),
      )
      setSessionId(data.session_id)
      attachActiveSocket(tab.id)
      clearReconnectNotice(tab.id)
      queueTerminalOutput(data.session_id, typeof readyMessage === 'function' ? readyMessage(data) : readyMessage)
      setStep('connecting')
      setConnected(false)
      connectWs(tab, { activate: true })
      if (project.runtime === 'codex' && !nextTemporary) {
        void syncCodexHistoryAfterSessionOpen({
          project,
          ptySessionId: data.session_id,
          preferredCodexSessionId: codexSessionId,
          knownHistorySessionIds: knownCodexHistorySessionIds,
        })
      }
      return data
    } catch {
      if (previousTab) {
        commitSessionTabs(previousTabs, previousTabs.map((tab) => tab.id))
        setSelectedProject(previousProject)
        activateSessionTab(previousTab, { project: previousProject })
        return null
      }
      setStep('select')
      setSessionTabs([])
      setSessionTabOrder([])
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
        const nextCodexSessionId = result.codex_session_id || codexSessionId || ''
        if (nextCodexSessionId) {
          await loadCodexTimeline(nextCodexSessionId, selectedProject, result.session_id)
        } else {
          lastLoadedCodexSessionIdRef.current = ''
        }
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

    const tabProject = projectsRef.current.find((item) => item.id === tab.projectId) || selectedProject
    logSessionDebug('switch_session_tab', {
      tabId: tab.id,
      tabCodexSessionId: tab.codexSessionId || '',
      activeSessionId: sessionIdRef.current,
      activeCodexSessionId,
    })
    activateSessionTab(tab)

    if (tabProject?.runtime !== 'codex') {
      return
    }

    if (tab.temporary) {
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineLoading(false)
      setCodexTimelineError('')
      lastLoadedCodexSessionIdRef.current = ''
      return
    }

    if (!tab.codexSessionId) {
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineError('')
      lastLoadedCodexSessionIdRef.current = ''
      return
    }

    setActiveCodexSessionId(tab.codexSessionId)
    setCodexTimeline(emptyCodexTimeline)
    setCodexTimelineError('')
    loadCodexTimeline(tab.codexSessionId, tabProject, tab.id)
  }

  const leaveSessionView = async () => {
    closeAllSockets(true)
    setStep('select')
    setConnected(false)
    setSessionId(null)
    setSessionTabs([])
    setSessionTabOrder([])
    setSelectedProject(null)
    setTerminalReconnectState({})
    setCodexSessionTitlesByPtySessionId({})
    setActiveCodexSessionId('')
    setCodexTimeline(emptyCodexTimeline)
    setCodexTimelineLoading(false)
    setCodexTimelineError('')
    panels.resetWorkspacePanels()
    resetTerminal()
    lastLoadedCodexSessionIdRef.current = ''
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
      commitSessionTabs(remainingTabs)
      setConnected(false)
      setSessionId(null)
      lastLoadedCodexSessionIdRef.current = ''
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
      setSessionTabOrder([])
      setSelectedProject(null)
      setTerminalReconnectState({})
      setCodexSessionTitlesByPtySessionId({})
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineLoading(false)
      setCodexTimelineError('')
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
    const targetProjectPath = selectedProjectRepoPath || projectPath
    const gitUrl = newProjectGitUrl.trim()

    if (!name) {
      setCreateProjectError('请输入项目名称')
      return
    }

    if (!projectPath) {
      setCreateProjectError('请输入项目路径')
      return
    }

    if (projectRepoOptions.length > 1 && !selectedProjectRepoPath) {
      setCreateProjectError('该目录下存在多个 Git 仓库，请先选择具体仓库根目录')
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
            path: targetProjectPath,
            git_url: gitUrl || null,
            runtime: 'codex',
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
    setSessionTabOrder([])
    setSelectedProject(null)
    setTerminalReconnectState({})
    setCodexSessionTitlesByPtySessionId({})
    setActiveCodexSessionId('')
    setCodexTimeline(emptyCodexTimeline)
    setCodexTimelineLoading(false)
    setCodexTimelineError('')
    panels.resetWorkspacePanels()
    resetTerminal()
    lastLoadedCodexSessionIdRef.current = ''

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
    sessionTabOrderRef.current = sessionTabOrder
  }, [sessionTabOrder])

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
    const prevTabs = sessionTabsRef.current
    if (prevTabs.length === 0) {
      return
    }

    commitSessionTabs(composeSessionTabs(sessions, projects, prevTabs))
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

  useEffect(() => {
    if (
      selectedProject?.runtime !== 'codex'
      || (!panels.codexLiveSessions.length && !panels.codexSessions.length)
    ) {
      return
    }

    const codexSessionIdByPtySessionId = new Map(
      panels.codexLiveSessions
        .filter((item) => item?.sessionId)
        .map((item) => [item.sessionId, item.codexSessionId || ''])
        .filter(([, codexSessionId]) => Boolean(codexSessionId)),
    )

    sessionsRef.current
      .filter((session) => session.projectId === selectedProject.id && !session.temporary)
      .forEach((session) => {
        if (session.codexSessionId && !codexSessionIdByPtySessionId.has(session.id)) {
          codexSessionIdByPtySessionId.set(session.id, session.codexSessionId)
        }
      })

    const usedCodexSessionIds = new Set(
      Array.from(codexSessionIdByPtySessionId.values()).filter(Boolean),
    )
    const fallbackCodexSessions = panels.codexSessions
      .filter((item) => item?.sessionId && !usedCodexSessionIds.has(item.sessionId))
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)

    const projectPersistentSessions = sessionsRef.current
      .filter((session) => session.projectId === selectedProject.id && !session.temporary)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)

    projectPersistentSessions.forEach((session) => {
      if (codexSessionIdByPtySessionId.has(session.id)) {
        return
      }

      const fallbackSession = fallbackCodexSessions.shift()
      if (!fallbackSession?.sessionId) {
        return
      }

      codexSessionIdByPtySessionId.set(session.id, fallbackSession.sessionId)
    })

    logSessionDebug('codex_session_mapping_sync', {
      projectId: selectedProject.id,
      mappings: Array.from(codexSessionIdByPtySessionId.entries()).map(([ptySessionId, codexSessionId]) => ({
        ptySessionId,
        codexSessionId,
      })),
    })

    if (!codexSessionIdByPtySessionId.size) {
      return
    }

    setSessions((prev) => {
      let changed = false
      const next = prev.map((session) => {
        const nextCodexSessionId = codexSessionIdByPtySessionId.get(session.id) || session.codexSessionId || ''
        if ((session.codexSessionId || '') === nextCodexSessionId) {
          return session
        }

        changed = true
        return {
          ...session,
          codexSessionId: nextCodexSessionId,
        }
      })

      return changed ? next : prev
    })

    setSessionTabs((prev) => {
      let changed = false
      const next = prev.map((tab) => {
        const nextCodexSessionId = codexSessionIdByPtySessionId.get(tab.id) || tab.codexSessionId || ''
        if ((tab.codexSessionId || '') === nextCodexSessionId) {
          return tab
        }

        changed = true
        return {
          ...tab,
          codexSessionId: nextCodexSessionId,
        }
      })

      return changed ? next : prev
    })
  }, [panels.codexLiveSessions, panels.codexSessions, selectedProject])

  useEffect(() => {
    if (step === 'select' || selectedProject?.runtime !== 'codex') {
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineLoading(false)
      setCodexTimelineError('')
      lastLoadedCodexSessionIdRef.current = ''
      return
    }

    const activeTab = sessionTabsRef.current.find((tab) => tab.id === sessionIdRef.current) || null
    if (activeTab?.temporary) {
      logSessionDebug('codex_timeline_effect_skip_temporary', {
        activeTabId: activeTab.id,
      })
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineLoading(false)
      setCodexTimelineError('')
      lastLoadedCodexSessionIdRef.current = ''
      return
    }

    const availableSessionIds = panels.codexSessions.map((item) => item.sessionId).filter(Boolean)
    if (availableSessionIds.length === 0) {
      logSessionDebug('codex_timeline_effect_empty_sessions', {
        activeTabId: activeTab?.id || '',
      })
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineError('')
      setCodexTimelineLoading(false)
      lastLoadedCodexSessionIdRef.current = ''
      return
    }

    if (activeTab && !activeTab.codexSessionId) {
      logSessionDebug('codex_timeline_effect_wait_mapping', {
        activeTabId: activeTab.id,
        activeCodexSessionId,
      })
      setActiveCodexSessionId('')
      setCodexTimeline(emptyCodexTimeline)
      setCodexTimelineLoading(false)
      setCodexTimelineError('')
      lastLoadedCodexSessionIdRef.current = ''
      return
    }

    const nextSessionId = activeTab
      ? activeTab.codexSessionId || ''
      : (
          (availableSessionIds.includes(activeCodexSessionId) ? activeCodexSessionId : '')
          || availableSessionIds[0]
        )

    logSessionDebug('codex_timeline_effect_resolve', {
      activeTabId: activeTab?.id || '',
      activeTabCodexSessionId: activeTab?.codexSessionId || '',
      activeCodexSessionId,
      nextSessionId,
      availableSessionIds,
    })

    if (nextSessionId !== activeCodexSessionId) {
      setActiveCodexSessionId(nextSessionId)
    }

    if (lastLoadedCodexSessionIdRef.current !== nextSessionId) {
      loadCodexTimeline(nextSessionId, selectedProject, activeTab?.id || '')
    }
  }, [activeCodexSessionId, panels.codexSessions, selectedProject, sessionId, sessionTabs, step])

  useEffect(() => {
    if (step === 'select' || selectedProject?.runtime !== 'codex') {
      return undefined
    }

    const activeTab = sessionTabsRef.current.find((tab) => tab.id === sessionIdRef.current) || null
    if (activeTab?.temporary) {
      return undefined
    }

    const targetSessionId = activeTab?.codexSessionId || activeCodexSessionId || panels.codexSessions[0]?.sessionId || ''
    if (!targetSessionId) {
      return undefined
    }

    let cancelled = false
    let refreshing = false

    const refreshTimeline = async () => {
      if (cancelled || refreshing) {
        return
      }

      refreshing = true
      try {
        await loadCodexTimeline(targetSessionId, selectedProject, activeTab?.id || '', {
          background: true,
        })
      } finally {
        refreshing = false
      }
    }

    const timer = window.setInterval(() => {
      void refreshTimeline()
    }, 2500)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeCodexSessionId, panels.codexSessions, selectedProject, sessionId, sessionTabs, step])

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
  const currentCodexSessionTab = selectedProject?.runtime === 'codex'
    ? (
        (activeSessionTab && !activeSessionTab.temporary ? activeSessionTab : null)
        || sessionTabs.find((tab) => tab.projectId === selectedProject.id && !tab.temporary)
        || null
      )
    : null
  const currentCodexLiveSession = selectedProject?.runtime === 'codex'
    ? (
        panels.codexLiveSessions.find((item) => item.sessionId === currentCodexSessionTab?.id)
        || (currentCodexSessionTab
          ? {
              sessionId: currentCodexSessionTab.id,
              codexSessionId: currentCodexSessionTab.codexSessionId || '',
              cwd: '',
              createdAtMs: 0,
              updatedAtMs: 0,
            }
          : null)
      )
    : null
  const canReconnectCurrentSession = Boolean(activeSessionTab?.id) && !connected && step !== 'connecting'
  const isEditingProject = Boolean(editingProjectTarget?.id)
  const reconnectCurrentSession = (targetTab = activeSessionTab) => {
    if (!targetTab?.id || reconnectingSessionRef.current.has(targetTab.id)) {
      return
    }

    reconnectingSessionRef.current.add(targetTab.id)
    activateSessionTab(targetTab, {
      project: selectedProject || projectsRef.current.find((item) => item.id === targetTab.projectId) || null,
      forceReconnect: true,
    })
  }

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined
    }

    const tryReconnectVisibleSession = () => {
      if (document.visibilityState !== 'visible') {
        return
      }

      const activeTab = sessionTabsRef.current.find((tab) => tab.id === sessionIdRef.current) || null
      if (!activeTab?.id) {
        return
      }

      const ws = wsPoolRef.current.get(activeTab.id)
      const reconnectable = !ws || ws.readyState !== WebSocket.OPEN
      const hasReconnectNotice = Boolean(terminalReconnectState[activeTab.id])
      if (!reconnectable || !hasReconnectNotice) {
        return
      }

      reconnectCurrentSession(activeTab)
    }

    document.addEventListener('visibilitychange', tryReconnectVisibleSession)
    window.addEventListener('focus', tryReconnectVisibleSession)
    window.addEventListener('pageshow', tryReconnectVisibleSession)

    return () => {
      document.removeEventListener('visibilitychange', tryReconnectVisibleSession)
      window.removeEventListener('focus', tryReconnectVisibleSession)
      window.removeEventListener('pageshow', tryReconnectVisibleSession)
    }
  }, [terminalReconnectState, selectedProject, connected])
  const sidePanelProps = {
    codexPanelProps: {
      codexError: panels.codexError,
      codexLoading: panels.codexLoading,
      codexResumeLoading: panels.codexResumeLoading,
      codexSessions: panels.codexSessions,
      currentCodexSession: currentCodexLiveSession,
      hasCodexSessions: panels.hasCodexSessions,
      onLoadCodexSessions: () => panels.loadCodexSessions(),
      onReturnToCurrentSession: () => {
        const targetTab = currentCodexSessionTab
          || null
        if (targetTab) {
          activateSessionTab(targetTab, {
            project: selectedProject || projectsRef.current.find((item) => item.id === targetTab.projectId) || null,
          })
        }
      },
      onResumeCodexSession: resumeCodexSession,
      selectedProjectId: selectedProject?.id,
    },
    filePanelProps: {
      editorLoadingPath: panels.editorLoadingPath,
      fileDeleteLoadingPath: panels.fileDeleteLoadingPath,
      fileDeleteTarget: panels.fileDeleteTarget,
      fileDownloadLoadingPath: panels.fileDownloadLoadingPath,
      fileUploadLoading: panels.fileUploadLoading,
      fileUploadProgress: panels.fileUploadProgress,
      fileTreeEntries: panels.fileTreeEntries,
      fileTreeError: panels.fileTreeError,
      fileTreeExpanded: panels.fileTreeExpanded,
      fileTreeLoadingPaths: panels.fileTreeLoadingPaths,
      fileTreeNodes: panels.fileTreeNodes,
      fileTreeRoot: panels.fileTreeRoot,
      onDownloadFile: panels.downloadFile,
      onCancelDeleteFile: panels.cancelDeleteFile,
      onConfirmDeleteFile: panels.confirmDeleteFile,
      onOpenEditor: panels.openEditor,
      onRefresh: () => panels.loadFileTree(selectedProject, '', { replace: true }),
      onRequestDeleteFile: panels.requestDeleteFile,
      onToggleFileTreeDirectory: panels.toggleFileTreeDirectory,
      onUploadFiles: panels.uploadFiles,
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
    repoSelectorProps: {
      enabled: panels.repoSelectionEnabled,
      repoError: panels.repoError,
      repoLoading: panels.repoLoading,
      repoOptions: panels.repoOptions,
      resolvedRepoPath: panels.resolvedRepoPath,
      selectedProjectId: selectedProject?.id,
      selectedRepoPath: panels.selectedRepoPath,
      onSelectRepoPath: panels.setSelectedRepoPath,
    },
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
    activeCodexSessionId,
    canReconnectCurrentSession,
    connected,
    codexTimeline,
    codexTimelineError,
    codexTimelineLoading,
    currentSessionTemporary,
    onRefreshCodexTimeline: () => loadCodexTimeline(),
    onDestroyCurrentSession: requestCloseCurrentSession,
    onLeaveSessionView: leaveSessionView,
    onOpenTemporarySession: openTemporarySession,
    onReconnectCurrentSession: reconnectCurrentSession,
    onReorderSessionTab: reorderSessionTab,
    onSwitchSessionTab: switchSessionTab,
    reconnectNotice: activeReconnectNotice,
    selectedProject,
    sessionId,
    sessionTabs,
    onSendSessionInput: sendSessionInput,
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
    codexSessionTitlesByPtySessionId,
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
    loadCodexSessionTitlesForProject,
    logout,
    newProjectGitUrl,
    newProjectName,
    newProjectPath,
    projectRepoLoading,
    projectRepoOptions,
    selectedProjectRepoPath,
    newProjectRuntime,
    onProjectPathInputChange: (value) => setNewProjectPath(normalizeProjectPathInput(value)),
    onProjectRepoPathChange: setSelectedProjectRepoPath,
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
