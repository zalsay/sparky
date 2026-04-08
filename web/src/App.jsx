import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE || `${window.location.protocol}//${window.location.host}`
const WS_BASE = import.meta.env.VITE_WS_BASE || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
const AUTH_STORAGE_KEY = 'sparky-auth'
const LEGACY_AUTH_STORAGE_KEY = 'cc-bridge-auth'
const PROJECT_STORAGE_KEY = 'sparky-last-project'
const LEGACY_PROJECT_STORAGE_KEY = 'cc-bridge-last-project'
const KEEPALIVE_INTERVAL_MS = 15000
const PROJECT_PATH_PREFIX = '/projects/'
const WORKSPACE_SIDEBAR_WIDTH_KEY = 'sparky-workspace-sidebar-width'
const DEFAULT_SIDEBAR_WIDTH = 380
const MIN_SIDEBAR_WIDTH = 320
const MAX_SIDEBAR_WIDTH = 760
const MIN_TERMINAL_WIDTH = 480

const PROJECT_PRESETS = {
  default: {
    displayName: 'Claude',
    provider: 'Anthropic',
    accent: 'claude',
    order: 0,
  },
  codex: {
    displayName: 'Codex',
    provider: 'OpenAI',
    accent: 'codex',
    order: 1,
  },
}

function readStorage(...keys) {
  for (const key of keys) {
    const value = localStorage.getItem(key)
    if (value) {
      return value
    }
  }

  return ''
}

function clearStorage(...keys) {
  keys.forEach((key) => localStorage.removeItem(key))
}

function readNumberStorage(key, fallback) {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return fallback
  }

  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function runtimeLabel(runtime) {
  return runtime === 'codex' ? 'Codex' : 'Claude'
}

function detectProjectRuntime(project) {
  const cmd = String(project.cmd || project.cli_path || '').toLowerCase()
  const provider = String(project.provider || '').toLowerCase()
  const accent = String(project.accent || '').toLowerCase()
  const id = String(project.project_id || project.id || '').toLowerCase()

  if (
    cmd.includes('codex') ||
    provider.includes('openai') ||
    accent === 'codex' ||
    id === 'codex'
  ) {
    return 'codex'
  }

  return 'claude'
}

function normalizeProjects(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.projects) ? payload.projects : []

  return list
    .map((project) => {
      const id = project.project_id || project.id
      const preset = PROJECT_PRESETS[id] || {}

      return {
        id,
        name: project.name || project.display_name || preset.displayName || id,
        cmd: project.cmd || project.cli_path || 'claude',
        rootFs: project.root_fs || '',
        bindDirs: Array.isArray(project.bind_dirs) ? project.bind_dirs : [],
        provider: project.provider || preset.provider || '自定义',
        accent: project.accent || preset.accent || 'generic',
        order: typeof preset.order === 'number' ? preset.order : 99,
        gitUrl: project.git_url || '',
        runtime: detectProjectRuntime(project),
        deletable: typeof project.deletable === 'boolean' ? project.deletable : !PROJECT_PRESETS[id],
      }
    })
    .filter((project) => project.id)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

function normalizeSessions(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.sessions) ? payload.sessions : []

  return list
    .map((session) => ({
      id: session.session_id || session.id,
      projectId: session.project_id || session.projectId,
      createdAtMs: Number(session.created_at_ms || session.createdAtMs || 0),
      alive: session.alive !== false,
      temporary: Boolean(session.temporary),
    }))
    .filter((session) => session.id && session.projectId && session.alive)
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
}

function sameSessionTabs(left, right) {
  if (left === right) {
    return true
  }

  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false
  }

  return left.every((tab, index) => {
    const other = right[index]
    return (
      tab.id === other.id &&
      tab.projectId === other.projectId &&
      tab.label === other.label &&
      tab.temporary === other.temporary
    )
  })
}

function normalizeProjectPathInput(value) {
  return value
    .replace(/^\/+/, '')
    .replace(/^projects\/?/, '')
}

function normalizeGitStatus(payload) {
  const status = payload?.status || payload || {}

  return {
    available: status.available !== false,
    root: status.root || '',
    branch: status.branch || 'HEAD',
    message: status.message || '',
    upstream: status.upstream || '',
    ahead: Number(status.ahead || 0),
    behind: Number(status.behind || 0),
    hasChanges: Boolean(status.has_changes),
    stagedCount: Number(status.staged_count || 0),
    unstagedCount: Number(status.unstaged_count || 0),
    untrackedCount: Number(status.untracked_count || 0),
    lastCommit: status.last_commit || null,
    changes: Array.isArray(status.changes)
      ? status.changes.map((item) => ({
          path: item.path || '',
          originalPath: item.original_path || '',
          staged: item.staged || ' ',
          unstaged: item.unstaged || ' ',
        }))
      : [],
  }
}

function normalizeWebTargets(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.targets)
      ? payload.targets
      : []

  return list
    .map((target) => ({
      id: target.id || target.candidate?.id,
      name: target.name || target.candidate?.name || 'Web',
      relativePath: target.relative_path || target.candidate?.relative_path || '',
      packageManager: target.package_manager || target.candidate?.package_manager || 'npm',
      framework: target.framework || target.candidate?.framework || 'generic',
      supportLevel: target.support_level || target.candidate?.support_level || 'best_effort',
      running: Boolean(target.running),
      url: target.url || '',
      port: target.port || null,
    }))
    .filter((target) => target.id)
}

function normalizeCodexSessions(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : []

  return list
    .map((session) => ({
      sessionId: session.session_id || session.sessionId,
      title: session.title || 'Codex 会话',
      cwd: session.cwd || '',
      rolloutPath: session.rollout_path || session.rolloutPath || '',
      updatedAtMs: Number(session.updated_at_ms || session.updatedAtMs || 0),
    }))
    .filter((session) => session.sessionId)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

function formatDateTime(value) {
  if (!value) {
    return '未知时间'
  }

  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return '未知时间'
  }
}

function webFrameworkLabel(framework) {
  switch (framework) {
    case 'vite':
      return 'Vite'
    case 'astro':
      return 'Astro'
    case 'next':
      return 'Next.js'
    case 'nuxt':
      return 'Nuxt'
    case 'cra':
      return 'CRA'
    case 'webpack':
      return 'Webpack'
    default:
      return 'Web'
  }
}

function gitCodeLabel(code) {
  switch ((code || '').trim()) {
    case 'M':
      return '修改'
    case 'A':
      return '新增'
    case 'D':
      return '删除'
    case 'R':
      return '重命名'
    case 'C':
      return '复制'
    case 'U':
      return '冲突'
    case '?':
      return '未跟踪'
    default:
      return ''
  }
}

function gitOutputPreview(value) {
  return String(value || '').trim()
}

function buildSessionTab(sessionId, project, temporary, existingTabs = []) {
  const projectId = project?.id || ''
  const projectName = project?.name || projectId || '项目'
  const baseTab = {
    id: sessionId,
    projectId,
    projectName,
    provider: project?.provider || '自定义',
    runtime: project?.runtime || 'claude',
    temporary,
  }

  if (!temporary) {
    return {
      ...baseTab,
      label: projectName,
    }
  }

  const nextIndex = existingTabs.reduce((max, tab) => {
    if (!tab.temporary || tab.projectId !== projectId) {
      return max
    }

    const matched = /临时\s*(\d+)$/.exec(tab.label || '')
    return Math.max(max, matched ? Number(matched[1]) : 0)
  }, 0) + 1

  return {
    ...baseTab,
    label: `${projectName} · 临时 ${nextIndex}`,
  }
}

function composeSessionTabs(persistentSessions, projects, existingTabs = [], extraTemporaryTab = null) {
  const projectMap = new Map(projects.map((project) => [project.id, project]))
  const persistentCountByProject = persistentSessions.reduce((map, session) => {
    if (!session.temporary) {
      map.set(session.projectId, (map.get(session.projectId) || 0) + 1)
    }
    return map
  }, new Map())
  const temporaryIndexByProject = new Map()

  const persistentTabs = persistentSessions
    .map((session) => {
      const project = projectMap.get(session.projectId)
      if (!project) {
        return null
      }

      if (session.temporary) {
        const nextIndex = (temporaryIndexByProject.get(session.projectId) || 0) + 1
        temporaryIndexByProject.set(session.projectId, nextIndex)
        return {
          ...buildSessionTab(session.id, project, true),
          label: `${project.name} · 临时 ${nextIndex}`,
        }
      }

      const tab = buildSessionTab(session.id, project, false)
      if ((persistentCountByProject.get(session.projectId) || 0) > 1) {
        return {
          ...tab,
          label: `${project.name} · ${session.id}`,
        }
      }

      return tab
    })
    .filter(Boolean)

  if (extraTemporaryTab && !persistentTabs.some((tab) => tab.id === extraTemporaryTab.id)) {
    persistentTabs.push(extraTemporaryTab)
  }

  return persistentTabs
}

function App() {
  const [authReady, setAuthReady] = useState(false)
  const [auth, setAuth] = useState(null)
  const [authMode, setAuthMode] = useState('login')
  const [loginName, setLoginName] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)
  const [step, setStep] = useState('select')
  const [projects, setProjects] = useState([])
  const [sessions, setSessions] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [sessionTabs, setSessionTabs] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [connected, setConnected] = useState(false)
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [projectError, setProjectError] = useState('')
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [creatingProject, setCreatingProject] = useState(false)
  const [createProjectError, setCreateProjectError] = useState('')
  const [editingProjectTarget, setEditingProjectTarget] = useState(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState(null)
  const [deletingProject, setDeletingProject] = useState(false)
  const [deleteProjectError, setDeleteProjectError] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectPath, setNewProjectPath] = useState('')
  const [newProjectGitUrl, setNewProjectGitUrl] = useState('')
  const [newProjectRuntime, setNewProjectRuntime] = useState('claude')
  const [preferredProjectId, setPreferredProjectId] = useState(() => readStorage(PROJECT_STORAGE_KEY, LEGACY_PROJECT_STORAGE_KEY))
  const [gitState, setGitState] = useState(null)
  const [gitLoading, setGitLoading] = useState(false)
  const [gitError, setGitError] = useState('')
  const [gitActionLoading, setGitActionLoading] = useState('')
  const [gitActionResult, setGitActionResult] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [webTargets, setWebTargets] = useState([])
  const [webLoading, setWebLoading] = useState(false)
  const [webError, setWebError] = useState('')
  const [webActionLoading, setWebActionLoading] = useState(false)
  const [webRestartLoading, setWebRestartLoading] = useState(false)
  const [selectedWebTargetId, setSelectedWebTargetId] = useState('')
  const [codexSessions, setCodexSessions] = useState([])
  const [codexLoading, setCodexLoading] = useState(false)
  const [codexError, setCodexError] = useState('')
  const [codexResumeLoading, setCodexResumeLoading] = useState('')
  const [sidePanelTab, setSidePanelTab] = useState('git')
  const [sidebarWidth, setSidebarWidth] = useState(() => readNumberStorage(WORKSPACE_SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH))
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const wsRef = useRef(null)
  const keepAliveRef = useRef(null)
  const terminalHostRef = useRef(null)
  const terminalRef = useRef(null)
  const fitAddonRef = useRef(null)
  const pendingOutputRef = useRef([])
  const projectsRef = useRef([])
  const sessionsRef = useRef([])
  const sessionTabsRef = useRef([])
  const sessionIdRef = useRef(null)
  const workspaceShellRef = useRef(null)

  const saveAuth = (value) => {
    if (value) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value))
      localStorage.removeItem(LEGACY_AUTH_STORAGE_KEY)
      setAuth(value)
      return
    }

    clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
    setAuth(null)
  }

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

  const authHeaders = (extra = {}) => {
    if (!auth?.token) {
      return extra
    }

    return {
      ...extra,
      Authorization: `Bearer ${auth.token}`,
    }
  }

  const queueTerminalOutput = (text) => {
    if (!text) {
      return
    }

    const terminal = terminalRef.current
    if (terminal) {
      terminal.write(text, () => {
        terminal.scrollToBottom()
      })
      return
    }

    pendingOutputRef.current.push(text)
  }

  const writeTerminalLine = (text) => {
    queueTerminalOutput(`\r\n${text}\r\n`)
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
    localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    setSessionTabs((prev) => {
      if (prev.length === 0) {
        return prev
      }

      const next = composeSessionTabs(sessions, projects, prev)
      return sameSessionTabs(prev, next) ? prev : next
    })
  }, [projects, sessions])

  const resetTerminal = () => {
    pendingOutputRef.current = []
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
    }
    fitAddonRef.current = null
  }

  const clearAuthState = () => {
    saveAuth(null)
    setProjects([])
    setSessions([])
    setSessionTabs([])
    setSelectedProject(null)
    setSessionId(null)
    setConnected(false)
    setStep('select')
    setGitState(null)
    setGitError('')
    setGitActionResult('')
    setCommitMessage('')
    setWebTargets([])
    setWebError('')
    setWebRestartLoading(false)
    setSelectedWebTargetId('')
    setCodexSessions([])
    setCodexError('')
    setCodexResumeLoading('')
    resetTerminal()
  }

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

  const clearKeepAlive = () => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current)
      keepAliveRef.current = null
    }
  }

  const closeSocket = (manual = true) => {
    clearKeepAlive()

    const ws = wsRef.current
    wsRef.current = null

    if (ws) {
      ws._sparkyManualClose = manual
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }
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

  useEffect(() => {
    const raw = readStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
    if (!raw) {
      setAuthReady(true)
      return
    }

    let stored = null
    try {
      stored = JSON.parse(raw)
    } catch {
      clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
      setAuthReady(true)
      return
    }

    if (!stored?.token) {
      clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
      setAuthReady(true)
      return
    }

    fetch(`${API_BASE}/auth/me`, {
      headers: {
        Authorization: `Bearer ${stored.token}`,
      },
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data?.user) {
          throw new Error(data.error || '登录校验失败')
        }

        saveAuth({
          token: stored.token,
          user: data.user,
        })
      })
      .catch(() => {
        clearStorage(AUTH_STORAGE_KEY, LEGACY_AUTH_STORAGE_KEY)
      })
      .finally(() => {
        setAuthReady(true)
      })
  }, [])

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
    if (step === 'select' || !selectedProject?.id || !auth?.token) {
      setGitState(null)
      setGitError('')
      setGitActionResult('')
      setWebTargets([])
      setWebError('')
      setWebRestartLoading(false)
      setSelectedWebTargetId('')
      setCodexSessions([])
      setCodexError('')
      setCodexResumeLoading('')
      return
    }

    loadGitStatus(selectedProject)
    loadWebTargets(selectedProject)
    if (selectedProject.runtime === 'codex') {
      loadCodexSessions(selectedProject)
    } else {
      setCodexSessions([])
      setCodexError('')
      setCodexResumeLoading('')
      if (sidePanelTab === 'codex') {
        setSidePanelTab('git')
      }
    }
  }, [step, selectedProject?.id, selectedProject?.runtime, auth?.token])

  useEffect(() => {
    if (webTargets.length === 0) {
      if (selectedWebTargetId) {
        setSelectedWebTargetId('')
      }
      return
    }

    if (!webTargets.some((target) => target.id === selectedWebTargetId)) {
      setSelectedWebTargetId(webTargets[0].id)
    }
  }, [webTargets, selectedWebTargetId])

  useEffect(() => {
    if (step === 'select') {
      return undefined
    }

    const host = terminalHostRef.current
    if (!host || terminalRef.current) {
      return undefined
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
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddon.fit()
        })
      })
    }

    scheduleFit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const dataDisposable = terminal.onData((data) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return
      }

      ws.send(JSON.stringify({ type: 'input', content: data }))
    })

    for (const chunk of pendingOutputRef.current) {
      terminal.write(chunk, () => {
        terminal.scrollToBottom()
      })
    }
    pendingOutputRef.current = []

    const onResize = () => {
      scheduleFit()
    }
    const onFocus = () => {
      terminal.focus()
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

    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      host.removeEventListener('pointerdown', onFocus)
      resizeObserver.disconnect()
      dataDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [step])

  useEffect(() => {
    if (step !== 'select' && fitAddonRef.current) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit()
        })
      })
    }
  }, [step, connected, sidebarWidth, sidePanelTab, sessionId])

  useEffect(() => {
    if (!sidebarResizing) {
      return undefined
    }

    const onPointerUp = () => {
      setSidebarResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [sidebarResizing])

  const connectWs = (tab) => {
    const sid = tab.id
    const temporary = tab.temporary
    const tokenQuery = auth?.token ? `?token=${encodeURIComponent(auth.token)}` : ''
    const ws = new WebSocket(`${WS_BASE}/session/${encodeURIComponent(sid)}/ws${tokenQuery}`)
    ws._sparkyManualClose = false
    ws._sparkyExited = false
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setStep('chat')
      writeTerminalLine('PTY 已连接。')
      fitAddonRef.current?.fit()
      clearKeepAlive()
      keepAliveRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, KEEPALIVE_INTERVAL_MS)
    }

    ws.onclose = () => {
      const wasManualClose = ws._sparkyManualClose === true
      const hasExited = ws._sparkyExited === true
      if (wsRef.current === ws) {
        wsRef.current = null
      }
      clearKeepAlive()
      setConnected(false)
      if (!wasManualClose && hasExited) {
        setSessions((prev) => prev.filter((item) => item.id !== sid))
        setSessionTabs((prev) => prev.filter((item) => item.id !== sid))
        if (sessionIdRef.current === sid) {
          setSessionId(null)
        }
      }
      if (!wasManualClose) {
        if (hasExited) {
          writeTerminalLine(temporary ? '连接已关闭。临时 PTY 已结束。' : '连接已关闭。会话已结束。')
        } else {
          writeTerminalLine('连接已关闭。会话仍在保活，可重新连接。')
        }
      }
    }

    ws.onerror = () => {
      writeTerminalLine('WebSocket 连接异常。')
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'output' && typeof data.content === 'string') {
          queueTerminalOutput(data.content)
        } else if (data.type === 'pong') {
          return
        } else if (data.type === 'error') {
          writeTerminalLine(`错误：${data.msg || data.error || ''}`)
        } else if (data.type === 'done') {
          ws._sparkyExited = true
          writeTerminalLine('进程已结束。')
        } else if (typeof data.content === 'string') {
          queueTerminalOutput(data.content)
        }
      } catch {
        queueTerminalOutput(event.data)
      }
    }
  }

  const loadGitStatus = async (project = selectedProject) => {
    if (!auth?.token || !project?.id) {
      setGitState(null)
      return
    }

    setGitLoading(true)
    setGitError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/git/status`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok || !data?.status) {
        throw new Error(data.error || '加载 Git 状态失败')
      }

      setGitState(normalizeGitStatus(data.status))
    } catch (error) {
      setGitState(null)
      setGitError(error.message || '加载 Git 状态失败')
    } finally {
      setGitLoading(false)
    }
  }

  const runGitAction = async (action) => {
    if (!selectedProject?.id) {
      return
    }

    setGitActionLoading(action)
    setGitError('')
    setGitActionResult('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/git/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          action,
          message: action === 'commit' ? commitMessage : null,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok || !data?.status) {
        throw new Error(data.error || 'Git 操作失败')
      }

      setGitState(normalizeGitStatus(data.status))
      setGitActionResult(gitOutputPreview(data.output) || '已完成 Git 操作')
      if (action === 'commit') {
        setCommitMessage('')
      }
    } catch (error) {
      setGitError(error.message || 'Git 操作失败')
    } finally {
      setGitActionLoading('')
    }
  }

  const loadWebTargets = async (project = selectedProject) => {
    if (!auth?.token || !project?.id) {
      setWebTargets([])
      return
    }

    setWebLoading(true)
    setWebError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/web/targets`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok) {
        throw new Error(data.error || '加载 Web 调试目标失败')
      }

      setWebTargets(normalizeWebTargets(data))
    } catch (error) {
      setWebTargets([])
      setWebError(error.message || '加载 Web 调试目标失败')
    } finally {
      setWebLoading(false)
    }
  }

  const loadCodexSessions = async (project = selectedProject) => {
    if (!auth?.token || !project?.id || project.runtime !== 'codex') {
      setCodexSessions([])
      return
    }

    setCodexLoading(true)
    setCodexError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/codex/sessions`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok) {
        throw new Error(data.error || '加载 Codex 会话失败')
      }

      setCodexSessions(normalizeCodexSessions(data))
    } catch (error) {
      setCodexSessions([])
      setCodexError(error.message || '加载 Codex 会话失败')
    } finally {
      setCodexLoading(false)
    }
  }

  const openWebDebug = async () => {
    if (!selectedProject?.id || !selectedWebTargetId) {
      return
    }

    setWebActionLoading(true)
    setWebError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/web/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          candidate_id: selectedWebTargetId,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok || !data?.url) {
        throw new Error(data.error || '打开调试页失败')
      }

      const nextTargets = webTargets.map((target) =>
        target.id === selectedWebTargetId
          ? {
              ...target,
              running: true,
              url: data.url,
              port: data?.status?.port || target.port,
            }
          : target,
      )
      setWebTargets(nextTargets)
      window.open(new URL(data.url, API_BASE).toString(), '_blank', 'noopener,noreferrer')
    } catch (error) {
      setWebError(error.message || '打开调试页失败')
    } finally {
      setWebActionLoading(false)
    }
  }

  const restartWebDebug = async () => {
    if (!selectedProject?.id || !selectedWebTargetId) {
      return
    }

    setWebRestartLoading(true)
    setWebError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/web/restart`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          candidate_id: selectedWebTargetId,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok || !data?.url) {
        throw new Error(data.error || '重启调试页失败')
      }

      const nextTargets = webTargets.map((target) =>
        target.id === selectedWebTargetId
          ? {
              ...target,
              running: true,
              url: data.url,
              port: data?.status?.port || target.port,
            }
          : target,
      )
      setWebTargets(nextTargets)
    } catch (error) {
      setWebError(error.message || '重启调试页失败')
    } finally {
      setWebRestartLoading(false)
    }
  }

  const resizeSidebar = (clientX) => {
    const shell = workspaceShellRef.current
    if (!shell) {
      return
    }

    const rect = shell.getBoundingClientRect()
    const availableWidth = rect.width
    if (availableWidth <= 1100) {
      return
    }

    const maxWidth = Math.min(MAX_SIDEBAR_WIDTH, availableWidth - MIN_TERMINAL_WIDTH)
    const nextWidth = clamp(rect.right - clientX, MIN_SIDEBAR_WIDTH, maxWidth)
    setSidebarWidth(nextWidth)
  }

  const startSidebarResize = (event) => {
    if (window.innerWidth <= 1100) {
      return
    }

    event.preventDefault()
    setSidebarResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onPointerMove = (moveEvent) => {
      resizeSidebar(moveEvent.clientX)
    }

    const onPointerUp = () => {
      setSidebarResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const destroySessionById = async (sid) => {
    if (!sid) {
      return
    }

    try {
      await fetch(`${API_BASE}/session/${encodeURIComponent(sid)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
    } catch {
      // Best effort cleanup.
    }
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

    const announce = options.announce !== false
    const project = options.project
      || projectsRef.current.find((item) => item.id === tab.projectId)
      || null

    if (project?.id) {
      rememberProject(project.id)
      setSelectedProject(project)
    }

    closeSocket(true)
    setStep('connecting')
    setConnected(false)
    setSessionId(tab.id)
    resetTerminal()
    if (announce) {
      queueTerminalOutput(`正在连接 ${tab.label}...\r\n`)
    }
    connectWs(tab)
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
    const loadingMessage = options.loadingMessage
      || (temporary
        ? `正在打开 ${project.name} 的临时 Shell...\r\n`
        : fresh
          ? `正在新建 ${project.name} 的主会话...\r\n`
          : `正在启动 ${project.name}...\r\n`)
    const readyMessage = options.readyMessage
      || (temporary
        ? (data) => `临时会话 ${data.session_id} 已就绪，正在连接...\r\n`
        : (data) => `会话 ${data.session_id} 已就绪，正在连接...\r\n`)
    const failureMessage = options.failureMessage || '启动会话失败'
    const previousTabs = sessionTabsRef.current
    const previousTab = previousTabs.find((tab) => tab.id === sessionIdRef.current) || null
    const previousProject = selectedProject
    const nextProjects = mergeProjects(projectsRef.current, project)

    closeSocket(true)
    rememberProject(project.id)
    setSelectedProject(project)
    setStep('connecting')
    setSessionId(null)
    setConnected(false)
    setGitState(null)
    setGitError('')
    setGitActionResult('')
    setCodexError('')
    setCodexResumeLoading('')
    resetTerminal()
    queueTerminalOutput(loadingMessage)

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
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
        return
      }

      if (!response.ok || !data.session_id) {
        throw new Error(data.error || '创建会话失败')
      }

      const nextTemporary = Boolean(data.temporary)
      const tab = buildSessionTab(data.session_id, project, nextTemporary, sessionTabsRef.current)
      const nextSessions = nextTemporary
        ? [
            {
              id: data.session_id,
              projectId: project.id,
              createdAtMs: Date.now(),
              alive: true,
              temporary: true,
            },
            ...sessionsRef.current.filter((item) => item.id !== data.session_id),
          ].sort((a, b) => b.createdAtMs - a.createdAtMs)
        : [
            {
              id: data.session_id,
              projectId: project.id,
              createdAtMs: Date.now(),
              alive: true,
              temporary: false,
            },
            ...sessionsRef.current.filter((item) => item.id !== data.session_id),
          ].sort((a, b) => b.createdAtMs - a.createdAtMs)

      setSessions(nextSessions)

      setSessionTabs((prev) => {
        const preservedTabs = preserveTabs ? prev : prev.filter((item) => !item.temporary)
        return composeSessionTabs(nextSessions, nextProjects, preservedTabs, nextTemporary ? tab : null)
      })
      setSessionId(data.session_id)
      queueTerminalOutput(typeof readyMessage === 'function' ? readyMessage(data) : readyMessage)
      connectWs(tab)
      return data
    } catch (error) {
      queueTerminalOutput(`${failureMessage}：${error.message}\r\n`)
      if (previousTab) {
        setSessionTabs(previousTabs)
        setSelectedProject(previousProject)
        activateSessionTab(previousTab, { announce: false, project: previousProject })
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
      || sessionsRef.current.find((item) => item.projectId === project.id)
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

    setCodexResumeLoading(codexSessionId || '__latest__')
    setCodexError('')

    try {
      const result = await openSessionRequest(selectedProject, {
        temporary: false,
        preserveTabs: true,
        endpoint: `${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/codex/resume`,
        body: codexSessionId ? { session_id: codexSessionId } : {},
        loadingMessage: codexSessionId
          ? `正在恢复 Codex 会话 ${codexSessionId}...\r\n`
          : '正在恢复最近的 Codex 会话...\r\n',
        readyMessage: (data) => `Codex 会话 ${data.codex_session_id || codexSessionId || data.session_id} 已恢复，正在连接...\r\n`,
        failureMessage: '恢复 Codex 会话失败',
      })

      if (result?.session_id) {
        await loadCodexSessions(selectedProject)
      }
    } catch (error) {
      setCodexError(error.message || '恢复 Codex 会话失败')
    } finally {
      setCodexResumeLoading('')
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
    closeSocket(true)
    setStep('select')
    setConnected(false)
    setSessionId(null)
    setSessionTabs([])
    setSelectedProject(null)
    setGitState(null)
    setGitError('')
    setGitActionResult('')
    setCommitMessage('')
    setWebRestartLoading(false)
    setCodexSessions([])
    setCodexError('')
    setCodexResumeLoading('')
    resetTerminal()
    await loadWorkspaceState()
  }

  const destroyCurrentSession = async () => {
    const activeTab = sessionTabsRef.current.find((tab) => tab.id === sessionId)
    if (!activeTab?.temporary) {
      return
    }

    const remainingTabs = sessionTabsRef.current.filter((tab) => tab.id !== activeTab.id)
    closeSocket(true)
    await destroySessionById(activeTab.id)
    setSessions((prev) => prev.filter((item) => item.id !== activeTab.id))
    setSessionTabs(remainingTabs)
    setConnected(false)
    setSessionId(null)
    setGitState(null)
    setGitError('')
    setGitActionResult('')
    setCommitMessage('')
    setWebRestartLoading(false)
    setCodexError('')
    setCodexResumeLoading('')
    resetTerminal()

    const fallbackTab = remainingTabs.find((tab) => !tab.temporary && tab.projectId === activeTab.projectId)
      || remainingTabs.find((tab) => !tab.temporary)
      || remainingTabs[remainingTabs.length - 1]
    if (fallbackTab) {
      activateSessionTab(fallbackTab, {
        announce: false,
        project: projectsRef.current.find((item) => item.id === fallbackTab.projectId) || null,
      })
      return
    }

    setStep('select')
    setConnected(false)
    setSessionId(null)
    setSessionTabs([])
    setSelectedProject(null)
    setGitState(null)
    setGitError('')
    setGitActionResult('')
    setCommitMessage('')
    setWebRestartLoading(false)
    setCodexSessions([])
    setCodexError('')
    setCodexResumeLoading('')
    resetTerminal()
    await loadWorkspaceState()
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
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
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

  const submitAuth = async (event) => {
    event.preventDefault()
    const username = loginName.trim()
    const password = loginPassword

    if (!username) {
      setLoginError('请输入用户名')
      return
    }

    if (!password) {
      setLoginError('请输入密码')
      return
    }

    if (authMode === 'register' && password.length < 8) {
      setLoginError('密码至少需要 8 位')
      return
    }

    setLoggingIn(true)
    setLoginError('')

    try {
      const response = await fetch(`${API_BASE}/auth/${authMode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.token || !data?.user) {
        throw new Error(data.error || `${authMode} failed`)
      }

      saveAuth({
        token: data.token,
        user: data.user,
      })
      setLoginPassword('')
      setStep('select')
    } catch (error) {
      setLoginError(error.message || (authMode === 'login' ? '登录失败' : '注册失败'))
    } finally {
      setLoggingIn(false)
    }
  }

  const switchAuthMode = (mode) => {
    setAuthMode(mode)
    setLoginError('')
    setLoginPassword('')
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
        clearAuthState()
        setLoginError('登录已失效，请重新登录')
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
    closeSocket(true)
    setStep('select')
    setConnected(false)
    setSessionId(null)
    setSessionTabs([])
    setSelectedProject(null)
    setGitState(null)
    setGitError('')
    setGitActionResult('')
    setCommitMessage('')
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

  const totalProjects = projects.length
  const activeSessionCount = sessions.length
  const sessionByProjectId = new Map()
  const sessionCountByProjectId = new Map()
  sessions.forEach((session) => {
    if (!sessionByProjectId.has(session.projectId)) {
      sessionByProjectId.set(session.projectId, session)
    }
    sessionCountByProjectId.set(session.projectId, (sessionCountByProjectId.get(session.projectId) || 0) + 1)
  })
  const activeWebTarget = webTargets.find((target) => target.id === selectedWebTargetId) || null
  const hasWebTargets = webTargets.length > 0
  const hasCodexSessions = codexSessions.length > 0
  const workspaceShellStyle = {
    '--workspace-sidebar-width': `${sidebarWidth}px`,
  }
  const activeSessionTab = sessionTabs.find((tab) => tab.id === sessionId) || null
  const currentSessionTemporary = Boolean(activeSessionTab?.temporary)
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
  const isEditingProject = Boolean(editingProjectTarget?.id)
  const authModeCopy = authMode === 'register'
    ? {
        title: '创建工作区账号',
        subtitle: '首次使用请先注册。注册成功后会直接登录，并在刷新后自动恢复到工作台。',
        action: loggingIn ? '注册中...' : '注册并登录',
      }
    : {
        title: '进入工作区',
        subtitle: '使用用户名和密码登录。浏览器会保留 token，后续刷新自动恢复登录。',
        action: loggingIn ? '登录中...' : '登录',
      }
  const selectedProjectPath = selectedProject?.bindDirs?.find((dir) => dir !== '/tmp') || PROJECT_PATH_PREFIX
  const gitAvailable = gitState?.available !== false
  const gitHasRemote = Boolean(gitState?.upstream || selectedProject?.gitUrl)
  const gitOutput = gitOutputPreview(gitActionResult)

  if (!authReady) {
    return (
      <div className="app auth-page">
        <div className="app-aura app-aura-brand" />
        <div className="app-aura app-aura-signal" />
        <div className="auth-layout auth-layout-compact">
          <div className="auth-panel auth-panel-loading">
            <span className="eyebrow">Sparky</span>
            <h1 className="auth-title">检查登录状态</h1>
            <p className="auth-subtitle">正在恢复浏览器里的自动登录状态...</p>
          </div>
        </div>
      </div>
    )
  }

  if (!auth) {
    const isRegister = authMode === 'register'

    return (
      <div className="app auth-page">
        <div className="app-aura app-aura-brand" />
        <div className="app-aura app-aura-signal" />
        <div className="auth-layout">
          <section className="auth-hero">
            <div className="brand-mark">
              <span className="brand-mark-block">SP</span>
              <span className="brand-mark-text">Sparky</span>
            </div>
            <span className="eyebrow">AI 开发工作台</span>
            <h1 className="hero-title">一个入口，直接切到 Claude 或 Codex。</h1>
            <p className="hero-copy">
              登录后直接进入项目工作台。会话保活、项目快照和自动登录都默认接管，界面只保留项目和终端本身。
            </p>
            <div className="hero-rail">
              <div className="hero-stat">
                <span className="hero-stat-label">模型</span>
                <strong>Claude + Codex</strong>
              </div>
              <div className="hero-stat">
                <span className="hero-stat-label">状态</span>
                <strong>自动恢复登录</strong>
              </div>
              <div className="hero-stat">
                <span className="hero-stat-label">存储</span>
                <strong>项目目录快照</strong>
              </div>
            </div>
          </section>

          <form className="auth-panel" onSubmit={submitAuth}>
            <div className="panel-header">
              <span className="eyebrow">工作区访问</span>
              <h2 className="auth-title">{authModeCopy.title}</h2>
              <p className="auth-subtitle">{authModeCopy.subtitle}</p>
            </div>

            <div className="auth-switch" role="tablist" aria-label="Authentication mode">
              <button
                type="button"
                className={`auth-switch-btn ${!isRegister ? 'active' : ''}`}
                onClick={() => switchAuthMode('login')}
              >
                登录
              </button>
              <button
                type="button"
                className={`auth-switch-btn ${isRegister ? 'active' : ''}`}
                onClick={() => switchAuthMode('register')}
              >
                注册
              </button>
            </div>

            <label className="field-label" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              className="field-input"
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
              placeholder="例如 blue"
              autoComplete="username"
              autoFocus
            />

            <label className="field-label" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              className="field-input"
              value={loginPassword}
              onChange={(event) => setLoginPassword(event.target.value)}
              placeholder={isRegister ? '至少 8 位密码' : '输入密码'}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
            />

            {loginError && <div className="notice notice-error">{loginError}</div>}

            <button className="primary-btn auth-submit" type="submit" disabled={loggingIn}>
              {authModeCopy.action}
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (step === 'select') {
    return (
      <div className="app dashboard-page">
        <div className="app-aura app-aura-brand" />
        <div className="app-aura app-aura-signal" />
        <header className="topbar">
          <div className="topbar-brand">
            <div className="brand-mark">
              <span className="brand-mark-block">SP</span>
              <span className="brand-mark-text">Sparky</span>
            </div>
            <div className="topbar-copy">
              <span className="eyebrow">工作区</span>
              <span className="topbar-title">智能体终端</span>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="identity-chip">
              <span className="identity-user">@{auth.user.username}</span>
              <span className="identity-meta">会话自动保留</span>
            </div>
            <div className="topbar-stats">
              <div className="topbar-stat">
                <span className="topbar-stat-label">项目</span>
                <strong>{totalProjects}</strong>
              </div>
              <div className="topbar-stat">
                <span className="topbar-stat-label">进行中</span>
                <strong>{activeSessionCount}</strong>
              </div>
            </div>
            <button className="ghost-btn" onClick={logout}>
              退出
            </button>
          </div>
        </header>

        <main className="dashboard-shell">
          <section className="catalog-panel glass-panel">
            <div className="section-bar">
              <div>
                <span className="eyebrow">模型终端</span>
                <h2 className="section-title">智能体工作区目录</h2>
              </div>
              <div className="section-actions">
                <button className="primary-btn section-create-btn" onClick={openCreateProjectForm}>
                  新建项目
                </button>
                <button className="secondary-btn" onClick={loadWorkspaceState} disabled={loadingProjects}>
                  {loadingProjects ? '刷新中...' : '刷新'}
                </button>
              </div>
            </div>

            {projectError && <div className="notice notice-error">{projectError}</div>}

            {!loadingProjects && projects.length === 0 && !projectError && (
              <div className="notice">当前还没有配置任何项目。</div>
            )}

            <div className="project-grid">
              {orderedProjects.map((project) => {
                const activeSession = sessionByProjectId.get(project.id)
                const activeSessionCountForProject = sessionCountByProjectId.get(project.id) || 0
                const projectPath = project.bindDirs.find((dir) => dir !== '/tmp') || '/projects'

                return (
                  <article
                    key={project.id}
                    className={`project-card skill-card project-card-${project.accent} ${preferredProjectId === project.id ? 'preferred' : ''}`}
                    onClick={() => selectProject(project)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        selectProject(project)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <span className="skill-card__accent" aria-hidden="true" />
                    <div className="project-card-top">
                      <span className="project-provider skill-card__icon">{project.provider}</span>
                      <div className="project-card-top-actions">
                        {activeSession ? (
                          <span className="project-badge">{activeSessionCountForProject > 1 ? `${activeSessionCountForProject} 个会话` : '保留会话'}</span>
                        ) : preferredProjectId === project.id ? (
                          <span className="project-badge">上次使用</span>
                        ) : null}
                        {project.deletable && (
                          <>
                            <button
                              type="button"
                              className="project-card-edit"
                              aria-label={`编辑项目 ${project.name}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                openEditProjectForm(project)
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="project-card-delete"
                              aria-label={`删除项目 ${project.name}`}
                              onClick={(event) => {
                                event.stopPropagation()
                                requestDeleteProject(project)
                              }}
                            >
                              删除
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="project-card-body skill-card__description">
                      <div className="project-heading">
                        <h3 className="project-name">{project.name}</h3>
                        <span className="project-runtime">{runtimeLabel(project.runtime)}</span>
                      </div>
                      <p className="project-path">{projectPath}</p>
                      <div className="project-specs">
                        {activeSession && <span className="project-meta">{activeSessionCountForProject > 1 ? `${activeSessionCountForProject} 个会话进行中` : '会话保留中'}</span>}
                        {!activeSession && preferredProjectId === project.id && <span className="project-meta">上次使用</span>}
                        {project.gitUrl && <span className="project-meta">已配置 Git</span>}
                      </div>
                    </div>
                    <span className="project-launch skill-card__cta">{activeSession ? '恢复会话' : '进入工作区'}</span>
                  </article>
                )
              })}
            </div>
          </section>

          <section className="session-panel glass-panel">
            <div className="section-bar">
              <div>
                <span className="eyebrow">可恢复状态</span>
                <h2 className="section-title">活动会话清单</h2>
              </div>
            </div>

            {sessions.length === 0 ? (
              <div className="notice">当前没有保留中的 PTY 会话，启动任意项目后会自动出现在这里。</div>
            ) : (
              <div className="session-list">
                {sessions.map((session) => {
                  const project = projects.find((item) => item.id === session.projectId)

                  return (
                    <button
                      key={session.id}
                      className="session-row skill-card"
                      onClick={() => project && activatePersistentSession(project, session.id)}
                    >
                      <span className="skill-card__accent" aria-hidden="true" />
                      <div className="session-row-main skill-card__description">
                        <span className="session-row-title">{project?.name || session.projectId}</span>
                        <span className="session-row-subtitle">{session.temporary ? '临时 Shell' : `${project?.provider || '自定义'} 终端`}</span>
                      </div>
                      <div className="session-row-meta">
                        <span>{session.id}</span>
                        <span>恢复</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </main>

        {createProjectOpen && (
          <div className="modal-backdrop" onClick={resetCreateProjectForm}>
            <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <span className="eyebrow">项目创建</span>
                  <h3 className="modal-title">{isEditingProject ? '编辑项目工作区' : '新建项目工作区'}</h3>
                </div>
                <button className="modal-close" type="button" onClick={resetCreateProjectForm}>
                  关闭
                </button>
              </div>

              <form className="project-form" onSubmit={submitCreateProject}>
                <label className="field-label" htmlFor="project-name">
                  项目名称
                </label>
                <input
                  id="project-name"
                  className="field-input"
                  value={newProjectName}
                  onChange={(event) => setNewProjectName(event.target.value)}
                  placeholder="例如 meetlife-admin"
                  autoFocus
                />

                <label className="field-label" htmlFor="project-path">
                  项目路径
                </label>
                <div className="path-input-shell">
                  <span className="path-input-prefix">{PROJECT_PATH_PREFIX}</span>
                  <input
                    id="project-path"
                    className="field-input path-input-field"
                    value={newProjectPath}
                    onChange={(event) => setNewProjectPath(normalizeProjectPathInput(event.target.value))}
                    placeholder="例如 client/meetlife-admin"
                  />
                </div>

                <label className="field-label" htmlFor="project-runtime">
                  运行时
                </label>
                <select
                  id="project-runtime"
                  className="field-input field-select"
                  value={newProjectRuntime}
                  onChange={(event) => setNewProjectRuntime(event.target.value)}
                >
                  <option value="claude">Claude Code</option>
                  <option value="codex">OpenAI Codex</option>
                </select>

                <label className="field-label" htmlFor="project-git-url">
                  Git 仓库地址
                </label>
                <input
                  id="project-git-url"
                  className="field-input"
                  value={newProjectGitUrl}
                  onChange={(event) => setNewProjectGitUrl(event.target.value)}
                  placeholder="可选，例如 https://github.com/org/repo.git"
                />

                <p className="form-hint">
                  {isEditingProject
                    ? <>项目路径固定在 <code>{PROJECT_PATH_PREFIX}</code> 下。编辑只会更新工作区配置，并关闭该项目现有 PTY，不会移动或删除原目录文件。</>
                    : <>项目会创建在固定目录 <code>{PROJECT_PATH_PREFIX}</code> 下。这里只需要填写后半段路径；填写 Git 地址时会自动 clone 到目标目录。</>}
                </p>

                {createProjectError && <div className="notice notice-error">{createProjectError}</div>}

                <div className="modal-actions">
                  <button className="ghost-btn" type="button" onClick={resetCreateProjectForm} disabled={creatingProject}>
                    取消
                  </button>
                  <button className="primary-btn" type="submit" disabled={creatingProject}>
                    {creatingProject ? (isEditingProject ? '保存中...' : '创建中...') : (isEditingProject ? '保存修改' : '创建项目')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {deleteProjectTarget && (
          <div className="modal-backdrop" onClick={resetDeleteProjectState}>
            <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <div>
                  <span className="eyebrow">项目删除</span>
                  <h3 className="modal-title">删除项目卡片</h3>
                </div>
                <button className="modal-close" type="button" onClick={resetDeleteProjectState}>
                  关闭
                </button>
              </div>

              <p className="modal-copy">
                将从工作区目录移除 <strong>{deleteProjectTarget.name}</strong>，并关闭该项目关联的 PTY。
                项目目录文件不会被删除。
              </p>

              {deleteProjectError && <div className="notice notice-error">{deleteProjectError}</div>}

              <div className="modal-actions">
                <button className="ghost-btn" type="button" onClick={resetDeleteProjectState} disabled={deletingProject}>
                  取消
                </button>
                <button className="danger-btn" type="button" onClick={submitDeleteProject} disabled={deletingProject}>
                  {deletingProject ? '删除中...' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app workspace-page">
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
      <header className="topbar">
        <div className="topbar-brand">
            <div className="brand-mark">
              <span className="brand-mark-block">SP</span>
              <span className="brand-mark-text">{selectedProject?.name || selectedProject?.id || 'Sparky'}</span>
            </div>
          <div className="topbar-copy">
            <span className="eyebrow">{selectedProject?.provider || '终端'}</span>
            <span className="topbar-title">{runtimeLabel(selectedProject?.runtime)} 工作区</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`status-pill ${connected ? 'online' : 'offline'}`}>
            {connected ? '已连接' : step === 'connecting' ? '连接中' : '已断开'}
          </span>
          {selectedProject?.runtime === 'codex' ? (
            <button
              className="toolbar-btn"
              onClick={() => resumeCodexSession()}
              disabled={codexLoading || codexResumeLoading !== ''}
            >
              {codexResumeLoading === '__latest__' ? '恢复中' : '恢复最近会话'}
            </button>
          ) : null}
          <button
            className="toolbar-btn"
            onClick={openPrimarySession}
            disabled={!selectedProject?.id || step === 'connecting'}
          >
            新开主会话
          </button>
          <button className="toolbar-btn" onClick={leaveSessionView}>
            返回列表
          </button>
        </div>
      </header>

      <main
        ref={workspaceShellRef}
        className={`workspace-shell workspace-shell-resizable ${sidebarResizing ? 'is-resizing' : ''}`}
        style={workspaceShellStyle}
      >
        <section className="terminal-panel glass-panel">
          <div className="terminal-panel-bar">
            <div className="terminal-toolbar">
              <div className="terminal-dots">
                <button
                  type="button"
                  className="terminal-dot terminal-dot-close"
                  onClick={destroyCurrentSession}
                  disabled={!currentSessionTemporary}
                  aria-label={currentSessionTemporary ? '关闭临时 PTY 并返回默认会话' : '默认 PTY 不可关闭'}
                  title={currentSessionTemporary ? '关闭临时 PTY 并返回默认会话' : '默认 PTY 不可关闭'}
                />
                <button
                  type="button"
                  className="terminal-dot terminal-dot-minimize"
                  onClick={leaveSessionView}
                  aria-label="返回列表"
                  title="返回列表"
                />
                <button
                  type="button"
                  className="terminal-dot terminal-dot-expand"
                  onClick={openTemporarySession}
                  disabled={!selectedProject?.id || step === 'connecting'}
                  aria-label="打开新的临时 PTY"
                  title="打开新的临时 PTY"
                />
              </div>
              <div className="terminal-tabs" role="tablist" aria-label="PTY 标签">
                {sessionTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={tab.id === sessionId}
                    className={`terminal-tab ${tab.id === sessionId ? 'active' : ''}`}
                    onClick={() => switchSessionTab(tab)}
                    title={`${tab.label} · ${tab.id}`}
                  >
                    <span className={`terminal-tab-dot ${tab.temporary ? 'temporary' : 'default'}`} />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="terminal-panel-meta">
              <span>{currentSessionTemporary ? '临时 Shell' : `${selectedProject?.provider || '自定义'} 运行时`}</span>
              <span>{connected ? '实时流' : '等待流建立'}</span>
            </div>
          </div>

          <div ref={terminalHostRef} className="terminal-host" />
        </section>

        <div
          className={`workspace-resizer ${sidebarResizing ? 'active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左右栏宽度"
          onPointerDown={startSidebarResize}
          onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        >
          <span className="workspace-resizer-handle" />
        </div>

        <aside className="git-panel glass-panel">
          <div className="side-panel-tabs" role="tablist" aria-label="右侧面板">
            {selectedProject?.runtime === 'codex' ? (
              <button
                type="button"
                role="tab"
                aria-selected={sidePanelTab === 'codex'}
                className={`side-panel-tab ${sidePanelTab === 'codex' ? 'active' : ''}`}
                onClick={() => setSidePanelTab('codex')}
              >
                Codex
              </button>
            ) : null}
            <button
              type="button"
              role="tab"
              aria-selected={sidePanelTab === 'web'}
              className={`side-panel-tab ${sidePanelTab === 'web' ? 'active' : ''}`}
              onClick={() => setSidePanelTab('web')}
            >
              Web 开发
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidePanelTab === 'git'}
              className={`side-panel-tab ${sidePanelTab === 'git' ? 'active' : ''}`}
              onClick={() => setSidePanelTab('git')}
            >
              Git
            </button>
          </div>

          {sidePanelTab === 'codex' && selectedProject?.runtime === 'codex' ? (
            <div className="side-panel-body">
              <div className="codex-panel-header">
                <div>
                  <span className="eyebrow">Codex</span>
                  <h2 className="section-title">可恢复会话</h2>
                </div>
                <div className="web-debug-actions">
                  <button
                    className="secondary-btn git-btn git-refresh-btn"
                    type="button"
                    onClick={() => loadCodexSessions()}
                    disabled={codexLoading || !selectedProject?.id}
                  >
                    {codexLoading ? '同步中...' : '刷新'}
                  </button>
                  <button
                    className="primary-btn git-btn"
                    type="button"
                    onClick={() => resumeCodexSession()}
                    disabled={codexLoading || codexResumeLoading !== '' || !hasCodexSessions}
                  >
                    {codexResumeLoading === '__latest__' ? '恢复中...' : '恢复最近'}
                  </button>
                </div>
              </div>

              {codexError ? <div className="notice notice-error">{codexError}</div> : null}

              {codexLoading ? (
                <div className="notice">正在同步 `CODEX_HOME` 中的历史会话...</div>
              ) : hasCodexSessions ? (
                <div className="codex-session-list">
                  {codexSessions.map((item) => (
                    <div className="codex-session-card skill-card" key={item.sessionId}>
                      <span className="skill-card__accent" aria-hidden="true" />
                      <div className="codex-session-main">
                        <strong>{item.title}</strong>
                        <span className="codex-session-meta">{item.cwd}</span>
                        <span className="codex-session-meta">{formatDateTime(item.updatedAtMs)} · {item.sessionId}</span>
                      </div>
                      <button
                        className="secondary-btn git-btn"
                        type="button"
                        onClick={() => resumeCodexSession(item.sessionId)}
                        disabled={codexLoading || codexResumeLoading !== ''}
                      >
                        {codexResumeLoading === item.sessionId ? '恢复中...' : '恢复'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="notice">当前项目还没有可恢复的 Codex 会话。</div>
              )}
            </div>
          ) : sidePanelTab === 'web' ? (
            <div className="side-panel-body">
              <div className="web-debug-panel">
                <div className="web-debug-panel-header">
                  <div>
                    <span className="eyebrow">调试页</span>
                    <h2 className="section-title">Web 开发服务</h2>
                  </div>
                  <div className="web-debug-actions">
                    <button
                      className="secondary-btn git-btn git-refresh-btn"
                      type="button"
                      onClick={() => loadWebTargets()}
                      disabled={webLoading || !selectedProject?.id}
                    >
                      {webLoading ? '扫描中...' : '刷新'}
                    </button>
                    {activeWebTarget?.running ? (
                      <button
                        className="secondary-btn git-btn"
                        type="button"
                        onClick={restartWebDebug}
                        disabled={webLoading || webActionLoading || webRestartLoading || !activeWebTarget}
                      >
                        {webRestartLoading ? '重启中...' : '重启调试页'}
                      </button>
                    ) : null}
                    <button
                      className="primary-btn git-btn"
                      type="button"
                      onClick={openWebDebug}
                      disabled={webLoading || webActionLoading || webRestartLoading || !activeWebTarget}
                    >
                      {webActionLoading ? '启动中...' : activeWebTarget?.running ? '打开调试页' : '启动调试页'}
                    </button>
                  </div>
                </div>
                {webLoading ? (
                  <div className="notice">正在扫描项目里的 Web 工程...</div>
                ) : webError ? (
                  <div className="notice notice-error">{webError}</div>
                ) : hasWebTargets ? (
                  <>
                    <div className="web-debug-list">
                      {webTargets.map((target) => (
                        <button
                          key={target.id}
                          type="button"
                          className={`web-debug-target skill-card ${target.id === activeWebTarget?.id ? 'active' : ''}`}
                          onClick={() => setSelectedWebTargetId(target.id)}
                        >
                          <span className="skill-card__accent" aria-hidden="true" />
                          <div className="web-debug-target-main skill-card__description">
                            <strong>{target.name}</strong>
                            <span>{webFrameworkLabel(target.framework)} · {target.packageManager}</span>
                            <span>{target.relativePath || '/'}</span>
                          </div>
                          <div className="web-debug-target-meta">
                            <span className={`web-debug-badge ${target.running ? 'running' : ''}`}>
                              {target.running ? '运行中' : '未启动'}
                            </span>
                            {target.port ? <span className="web-debug-port">:{target.port}</span> : null}
                          </div>
                        </button>
                      ))}
                    </div>
                    {activeWebTarget ? (
                      <div className="web-debug-current skill-card">
                        <span className="skill-card__accent" aria-hidden="true" />
                        <span className="git-summary-label">当前目标</span>
                        <strong>{activeWebTarget.name}</strong>
                        <span>{activeWebTarget.relativePath || '/'}</span>
                      </div>
                    ) : null}
                    {activeWebTarget && activeWebTarget.supportLevel !== 'full' && (
                      <div className="notice">
                        当前为兼容模式。已接入自动转发，但对非 Vite/Astro 项目可能需要再补框架级参数。
                      </div>
                    )}
                  </>
                ) : (
                  <div className="notice">当前项目未检测到带 `dev` 脚本的 Web 工程。</div>
                )}
              </div>
            </div>
          ) : (
            <div className="side-panel-body">
              <div className="git-panel-header">
                <div>
                  <span className="eyebrow">Git</span>
                  <h2 className="section-title">仓库状态</h2>
                </div>
                <button
                  className="secondary-btn git-btn git-refresh-btn"
                  type="button"
                  onClick={() => loadGitStatus()}
                  disabled={gitLoading || !selectedProject?.id}
                >
                  {gitLoading ? '刷新中...' : '刷新'}
                </button>
              </div>

              <div className="git-repo-meta">
                <span className="git-branch">{gitAvailable ? gitState?.branch || '未识别分支' : '未检测到仓库'}</span>
                <span className="git-root">{gitState?.root || selectedProjectPath}</span>
              </div>

              {gitState && gitAvailable && (
                <div className="git-summary-grid">
                  <div className="git-summary-card skill-card">
                    <span className="skill-card__accent" aria-hidden="true" />
                    <span className="git-summary-label">已暂存</span>
                    <strong>{gitState.stagedCount}</strong>
                  </div>
                  <div className="git-summary-card skill-card">
                    <span className="skill-card__accent" aria-hidden="true" />
                    <span className="git-summary-label">未暂存</span>
                    <strong>{gitState.unstagedCount}</strong>
                  </div>
                  <div className="git-summary-card skill-card">
                    <span className="skill-card__accent" aria-hidden="true" />
                    <span className="git-summary-label">未跟踪</span>
                    <strong>{gitState.untrackedCount}</strong>
                  </div>
                  <div className="git-summary-card skill-card">
                    <span className="skill-card__accent" aria-hidden="true" />
                    <span className="git-summary-label">同步</span>
                    <strong>{gitState.ahead}/{gitState.behind}</strong>
                  </div>
                </div>
              )}

              {selectedProject?.gitUrl && (
                <div className="notice git-remote-notice">
                  远端仓库：{selectedProject.gitUrl}
                </div>
              )}

              {gitError && <div className="notice notice-error">{gitError}</div>}
              {!gitError && gitState?.message && <div className="notice">{gitState.message}</div>}
              {gitOutput && !gitError && <div className="notice git-output">{gitOutput}</div>}

              <div className="git-actions">
                <button
                  className="secondary-btn git-btn"
                  type="button"
                  onClick={() => runGitAction('fetch')}
                  disabled={gitActionLoading !== '' || gitLoading || !gitAvailable}
                >
                  {gitActionLoading === 'fetch' ? '执行中...' : 'Fetch'}
                </button>
                <button
                  className="secondary-btn git-btn"
                  type="button"
                  onClick={() => runGitAction('pull')}
                  disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !gitHasRemote}
                >
                  {gitActionLoading === 'pull' ? '执行中...' : 'Pull'}
                </button>
                <button
                  className="secondary-btn git-btn"
                  type="button"
                  onClick={() => runGitAction('push')}
                  disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !gitHasRemote}
                >
                  {gitActionLoading === 'push' ? '执行中...' : 'Push'}
                </button>
                <button
                  className="secondary-btn git-btn"
                  type="button"
                  onClick={() => runGitAction('stage_all')}
                  disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !gitState?.hasChanges}
                >
                  {gitActionLoading === 'stage_all' ? '执行中...' : '暂存全部'}
                </button>
              </div>

              <div className="git-commit-box">
                <label className="field-label" htmlFor="git-commit-message">
                  提交说明
                </label>
                <input
                  id="git-commit-message"
                  className="field-input"
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="例如 feat: 更新登录逻辑"
                />
                <button
                  className="primary-btn git-btn git-commit-btn"
                  type="button"
                  onClick={() => runGitAction('commit')}
                  disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !commitMessage.trim()}
                >
                  {gitActionLoading === 'commit' ? '提交中...' : '提交全部改动'}
                </button>
              </div>

              {gitAvailable && gitState?.lastCommit && (
                <div className="git-last-commit">
                  <span className="git-summary-label">最近提交</span>
                  <strong>{gitState.lastCommit.subject}</strong>
                  <span className="git-last-commit-meta">
                    {gitState.lastCommit.author} · {gitState.lastCommit.relativeTime} · {gitState.lastCommit.id.slice(0, 7)}
                  </span>
                </div>
              )}

              <div className="git-file-list">
                {gitLoading ? (
                  <div className="notice">正在读取仓库状态...</div>
                ) : gitAvailable && gitState?.changes?.length ? (
                  gitState.changes.map((change) => (
                    <div className="git-file-row" key={`${change.originalPath || ''}-${change.path}-${change.staged}-${change.unstaged}`}>
                      <div className="git-file-main">
                        <span className="git-file-path">{change.path}</span>
                        {change.originalPath && <span className="git-file-prev">{change.originalPath}</span>}
                      </div>
                      <div className="git-file-badges">
                        {gitCodeLabel(change.staged) && (
                          <span className="git-change-badge git-change-staged">{gitCodeLabel(change.staged)}</span>
                        )}
                        {gitCodeLabel(change.unstaged) && (
                          <span className="git-change-badge git-change-worktree">{gitCodeLabel(change.unstaged)}</span>
                        )}
                      </div>
                    </div>
                  ))
                ) : gitAvailable ? (
                  <div className="notice">当前没有未提交的改动。</div>
                ) : (
                  <div className="notice">配置了 Git 地址后，可重新保存项目配置触发 clone，或在终端内手动 clone。</div>
                )}
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}

export default App
