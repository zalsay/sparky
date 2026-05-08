import { useEffect, useRef, useState } from 'react'
import {
  API_BASE,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_TERMINAL_WIDTH,
  PROJECT_PATH_PREFIX,
  WORKSPACE_SIDEBAR_WIDTH_KEY,
} from '../constants'
import {
  clamp,
  gitOutputPreview,
  normalizeCodexSessionPayload,
  normalizeFileTree,
  normalizeGitStatus,
  normalizeWebTargets,
} from '../data'
import { readNumberStorage } from '../storage'

export function useWorkspacePanels({
  auth,
  authHeaders,
  onUnauthorized,
  selectedProject,
  step,
  workspaceShellRef,
}) {
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
  const [codexLiveSessions, setCodexLiveSessions] = useState([])
  const [codexLoading, setCodexLoading] = useState(false)
  const [codexError, setCodexError] = useState('')
  const [codexResumeLoading, setCodexResumeLoading] = useState('')

  const [fileTreeRoot, setFileTreeRoot] = useState(null)
  const [fileTreeNodes, setFileTreeNodes] = useState({})
  const [fileTreeExpanded, setFileTreeExpanded] = useState({})
  const [fileTreeLoadingPaths, setFileTreeLoadingPaths] = useState({})
  const [fileTreeError, setFileTreeError] = useState('')
  const [editorLoadingPath, setEditorLoadingPath] = useState('')
  const [fileDownloadLoadingPath, setFileDownloadLoadingPath] = useState('')
  const [fileUploadLoading, setFileUploadLoading] = useState(false)
  const [fileUploadProgress, setFileUploadProgress] = useState(0)
  const [fileDeleteTarget, setFileDeleteTarget] = useState('')
  const [fileDeleteLoadingPath, setFileDeleteLoadingPath] = useState('')
  const [repoOptions, setRepoOptions] = useState([])
  const [repoLoading, setRepoLoading] = useState(false)
  const [repoError, setRepoError] = useState('')
  const [selectedRepoPathsByProjectId, setSelectedRepoPathsByProjectId] = useState({})

  const [sidePanelTab, setSidePanelTab] = useState('git')
  const [sidebarWidth, setSidebarWidth] = useState(() => readNumberStorage(WORKSPACE_SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH))
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const repoDiscoveryRequestIdRef = useRef(0)

  const selectedProjectPath = selectedProject?.bindDirs?.find((dir) => dir !== '/tmp') || PROJECT_PATH_PREFIX
  const resolveSelectedRepoPath = (project = selectedProject) => {
    if (!project?.id) {
      return ''
    }

    return selectedRepoPathsByProjectId[project.id] || ''
  }
  const selectedRepoPath = resolveSelectedRepoPath(selectedProject)
  const setSelectedRepoPath = (path, project = selectedProject) => {
    if (!project?.id) {
      return
    }

    const nextPath = String(path || '').trim()
    setSelectedRepoPathsByProjectId((prev) => {
      const next = { ...prev }
      if (nextPath) {
        next[project.id] = nextPath
      } else {
        delete next[project.id]
      }
      return next
    })
  }
  const buildProjectSearch = (project = selectedProject, extraParams) => {
    const params = new URLSearchParams(extraParams || {})
    const repoPath = resolveSelectedRepoPath(project)
    if (repoPath) {
      params.set('repo_path', repoPath)
    }

    const search = params.toString()
    return search ? `?${search}` : ''
  }

  const resetWorkspacePanels = () => {
    setGitState(null)
    setGitLoading(false)
    setGitError('')
    setGitActionLoading('')
    setGitActionResult('')
    setCommitMessage('')
    setWebTargets([])
    setWebLoading(false)
    setWebError('')
    setWebActionLoading(false)
    setWebRestartLoading(false)
    setSelectedWebTargetId('')
    setCodexSessions([])
    setCodexLiveSessions([])
    setCodexLoading(false)
    setCodexError('')
    setCodexResumeLoading('')
    setFileTreeRoot(null)
    setFileTreeNodes({})
    setFileTreeExpanded({})
    setFileTreeLoadingPaths({})
    setFileTreeError('')
    setEditorLoadingPath('')
    setFileDownloadLoadingPath('')
    setFileUploadLoading(false)
    setFileUploadProgress(0)
    setFileDeleteTarget('')
    setFileDeleteLoadingPath('')
    setRepoOptions([])
    setRepoLoading(false)
    setRepoError('')
  }

  const discoverProjectRepositories = async (project = selectedProject) => {
    if (!auth?.token || !project?.id) {
      setRepoOptions([])
      setRepoLoading(false)
      setRepoError('')
      return []
    }

    const projectPath = project.bindDirs?.find((dir) => dir !== '/tmp') || PROJECT_PATH_PREFIX
    const requestId = repoDiscoveryRequestIdRef.current + 1
    repoDiscoveryRequestIdRef.current = requestId
    setRepoOptions([])
    setRepoLoading(true)
    setRepoError('')

    try {
      const response = await fetch(`${API_BASE}/projects/git/repositories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          path: projectPath,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
        return []
      }

      if (repoDiscoveryRequestIdRef.current !== requestId) {
        return []
      }

      if (!response.ok) {
        throw new Error(data.error || '加载仓库列表失败')
      }

      const nextOptions = Array.isArray(data?.repositories)
        ? data.repositories
          .map((item) => ({
            path: item.path || '',
            label: item.relative_path || item.path || '',
          }))
          .filter((item) => item.path)
        : []

      setRepoOptions(nextOptions)
      setSelectedRepoPathsByProjectId((prev) => {
        const currentPath = prev[project.id] || ''
        if (currentPath && nextOptions.some((item) => item.path === currentPath)) {
          return prev
        }

        if (nextOptions.length === 1) {
          return {
            ...prev,
            [project.id]: nextOptions[0].path,
          }
        }

        const next = { ...prev }
        delete next[project.id]
        return next
      })
      return nextOptions
    } catch (error) {
      if (repoDiscoveryRequestIdRef.current === requestId) {
        setRepoOptions([])
        setRepoError(error.message || '加载仓库列表失败')
      }
      return []
    } finally {
      if (repoDiscoveryRequestIdRef.current === requestId) {
        setRepoLoading(false)
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
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/git/status${buildProjectSearch(project)}`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
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
          repo_path: selectedRepoPath || null,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
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
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/web/targets${buildProjectSearch(project)}`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
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
      setCodexLiveSessions([])
      return {
        historySessions: [],
        liveSessions: [],
      }
    }

    setCodexLoading(true)
    setCodexError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/codex/sessions`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
        return null
      }

      if (!response.ok) {
        throw new Error(data.error || '加载 Codex 会话失败')
      }

      const normalized = normalizeCodexSessionPayload(data)
      setCodexSessions(normalized.historySessions)
      setCodexLiveSessions(normalized.liveSessions)
      return normalized
    } catch (error) {
      setCodexSessions([])
      setCodexLiveSessions([])
      setCodexError(error.message || '加载 Codex 会话失败')
      return null
    } finally {
      setCodexLoading(false)
    }
  }

  const loadFileTree = async (project = selectedProject, path = '', options = {}) => {
    if (!auth?.token || !project?.id) {
      setFileTreeRoot(null)
      setFileTreeNodes({})
      setFileTreeExpanded({})
      setFileTreeLoadingPaths({})
      return
    }

    const currentPath = String(path || '')
    setFileTreeLoadingPaths((prev) => ({
      ...prev,
      [currentPath]: true,
    }))
    if (options.replace) {
      setFileTreeError('')
    }

    try {
      const search = buildProjectSearch(project, currentPath ? { path: currentPath } : undefined)
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project.id)}/files/tree${search}`, {
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
        return
      }

      if (!response.ok) {
        throw new Error(data.error || '加载文件树失败')
      }

      const tree = normalizeFileTree(data)
      setFileTreeRoot((prev) => (options.replace || !prev ? tree : { ...prev, ...tree, entries: prev.entries || tree.entries }))
      setFileTreeNodes((prev) => ({
        ...(options.replace ? {} : prev),
        [tree.currentPath]: tree.entries,
      }))
      setFileTreeExpanded((prev) => ({
        ...(options.replace ? {} : prev),
        [tree.currentPath]: true,
      }))
      setFileTreeError('')
    } catch (error) {
      if (options.replace) {
        setFileTreeRoot(null)
        setFileTreeNodes({})
        setFileTreeExpanded({})
      }
      setFileTreeError(error.message || '加载文件树失败')
    } finally {
      setFileTreeLoadingPaths((prev) => {
        const next = { ...prev }
        delete next[currentPath]
        return next
      })
    }
  }

  const toggleFileTreeDirectory = async (entryPath) => {
    if (!entryPath) {
      return
    }

    if (fileTreeExpanded[entryPath]) {
      setFileTreeExpanded((prev) => ({
        ...prev,
        [entryPath]: false,
      }))
      return
    }

    if (!fileTreeNodes[entryPath] && !fileTreeLoadingPaths[entryPath]) {
      await loadFileTree(selectedProject, entryPath)
      return
    }

    setFileTreeExpanded((prev) => ({
      ...prev,
      [entryPath]: true,
    }))
  }

  const openEditor = async (path = '') => {
    if (!selectedProject?.id) {
      return
    }

    const targetPath = String(path || '')
    setEditorLoadingPath(targetPath || '__root__')
    setFileTreeError('')

    try {
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/editor/open`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          path: targetPath || null,
          repo_path: selectedRepoPath || null,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
        return
      }

      if (!response.ok || !data?.url) {
        throw new Error(data.error || '打开编辑器失败')
      }

      window.open(new URL(data.url, API_BASE).toString(), '_blank', 'noopener,noreferrer')
    } catch (error) {
      setFileTreeError(error.message || '打开编辑器失败')
    } finally {
      setEditorLoadingPath('')
    }
  }

  const downloadFile = async (path = '') => {
    if (!selectedProject?.id || !path) {
      return
    }

    const targetPath = String(path || '')
    setFileDownloadLoadingPath(targetPath)
    setFileTreeError('')

    try {
      const search = buildProjectSearch(selectedProject, { path: targetPath })
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/files/download${search}`, {
        headers: authHeaders(),
      })

      if (response.status === 401) {
        onUnauthorized()
        return
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || '下载文件失败')
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = targetPath.split('/').filter(Boolean).pop() || 'download'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
    } catch (error) {
      setFileTreeError(error.message || '下载文件失败')
    } finally {
      setFileDownloadLoadingPath('')
    }
  }

  const uploadFiles = async (files = []) => {
    if (!selectedProject?.id || files.length === 0) {
      return
    }

    const formData = new FormData()
    files.forEach((file) => {
      formData.append('files', file, file.webkitRelativePath || file.name)
    })

    setFileUploadLoading(true)
    setFileUploadProgress(0)
    setFileTreeError('')

    try {
      const search = buildProjectSearch(selectedProject)
      const uploadResult = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/files/upload${search}`)
        Object.entries(authHeaders()).forEach(([name, value]) => {
          xhr.setRequestHeader(name, value)
        })

        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable || event.total <= 0) {
            return
          }
          setFileUploadProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
        }
        xhr.onload = () => {
          let data = {}
          try {
            data = xhr.responseText ? JSON.parse(xhr.responseText) : {}
          } catch {
            data = {}
          }
          if (xhr.status === 401) {
            resolve({ unauthorized: true })
            return
          }

          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(data.error || '上传文件失败'))
            return
          }

          resolve(data)
        }
        xhr.onerror = () => reject(new Error('上传文件失败'))
        xhr.onabort = () => reject(new Error('上传已取消'))
        xhr.send(formData)
      })

      if (uploadResult?.unauthorized) {
        onUnauthorized()
        return
      }

      setFileUploadProgress(100)
      await loadFileTree(selectedProject, '', { replace: true })
    } catch (error) {
      setFileTreeError(error.message || '上传文件失败')
    } finally {
      setFileUploadLoading(false)
      setFileUploadProgress(0)
    }
  }

  const requestDeleteFile = (path = '') => {
    const targetPath = String(path || '')
    if (!targetPath) {
      return
    }

    setFileDeleteTarget(targetPath)
    setFileTreeError('')
  }

  const cancelDeleteFile = () => {
    if (fileDeleteLoadingPath) {
      return
    }

    setFileDeleteTarget('')
  }

  const confirmDeleteFile = async () => {
    if (!selectedProject?.id || !fileDeleteTarget) {
      return
    }

    const targetPath = fileDeleteTarget
    setFileDeleteLoadingPath(targetPath)
    setFileTreeError('')

    try {
      const search = buildProjectSearch(selectedProject, { path: targetPath })
      const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(selectedProject.id)}/files/delete${search}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
        return
      }

      if (!response.ok) {
        throw new Error(data.error || '删除文件失败')
      }

      setFileDeleteTarget('')
      await loadFileTree(selectedProject, '', { replace: true })
    } catch (error) {
      setFileTreeError(error.message || '删除文件失败')
    } finally {
      setFileDeleteLoadingPath('')
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
          repo_path: selectedRepoPath || null,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
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
          repo_path: selectedRepoPath || null,
        }),
      })
      const data = await response.json().catch(() => ({}))

      if (response.status === 401) {
        onUnauthorized()
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

  useEffect(() => {
    localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    if (step === 'select' || !selectedProject?.id || !auth?.token) {
      setRepoOptions([])
      setRepoLoading(false)
      setRepoError('')
      return
    }

    discoverProjectRepositories(selectedProject)
  }, [auth?.token, selectedProject?.id, selectedProjectPath, step])

  useEffect(() => {
    if (step === 'select' || !selectedProject?.id || !auth?.token) {
      resetWorkspacePanels()
      return
    }

    loadGitStatus(selectedProject)
    loadFileTree(selectedProject, '', { replace: true })
    loadWebTargets(selectedProject)
    if (selectedProject.runtime === 'codex') {
      loadCodexSessions(selectedProject)
    } else {
      setCodexSessions([])
      setCodexLiveSessions([])
      setCodexError('')
      setCodexResumeLoading('')
      if (sidePanelTab === 'codex') {
        setSidePanelTab('git')
      }
    }
  }, [auth?.token, selectedProject?.id, selectedProject?.runtime, selectedRepoPath, step])

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
  }, [selectedWebTargetId, webTargets])

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

  const activeWebTarget = webTargets.find((target) => target.id === selectedWebTargetId) || null
  const hasWebTargets = webTargets.length > 0
  const hasCodexSessions = codexSessions.length > 0
  const fileTreeEntries = fileTreeNodes[''] || []
  const workspaceShellStyle = {
    '--workspace-sidebar-width': `${sidebarWidth}px`,
  }
  const gitAvailable = gitState?.available !== false
  const gitHasRemote = Boolean(gitState?.upstream || selectedProject?.gitUrl)
  const gitOutput = gitOutputPreview(gitActionResult)
  const repoSelectionEnabled = repoLoading || repoOptions.length > 1 || Boolean(repoError)
  const resolvedRepoPath = gitState?.root || fileTreeRoot?.root || ''

  return {
    activeWebTarget,
    codexError,
    codexLiveSessions,
    codexLoading,
    codexResumeLoading,
    codexSessions,
    commitMessage,
    editorLoadingPath,
    fileDeleteLoadingPath,
    fileDeleteTarget,
    fileDownloadLoadingPath,
    fileUploadLoading,
    fileUploadProgress,
    fileTreeEntries,
    fileTreeError,
    fileTreeExpanded,
    fileTreeLoadingPaths,
    fileTreeNodes,
    fileTreeRoot,
    gitActionLoading,
    gitAvailable,
    gitError,
    gitHasRemote,
    gitLoading,
    gitOutput,
    gitState,
    hasCodexSessions,
    hasWebTargets,
    discoverProjectRepositories,
    loadCodexSessions,
    loadFileTree,
    loadGitStatus,
    loadWebTargets,
    cancelDeleteFile,
    confirmDeleteFile,
    downloadFile,
    uploadFiles,
    openEditor,
    openWebDebug,
    resetWorkspacePanels,
    repoError,
    repoLoading,
    repoOptions,
    repoSelectionEnabled,
    resolvedRepoPath,
    restartWebDebug,
    requestDeleteFile,
    runGitAction,
    selectedProjectPath,
    selectedRepoPath,
    selectedWebTargetId,
    setCodexError,
    setCodexResumeLoading,
    setCommitMessage,
    setFileTreeError,
    setEditorLoadingPath,
    setGitActionResult,
    setGitError,
    setSelectedRepoPath,
    setSelectedWebTargetId,
    setSidePanelTab,
    setSidebarWidth,
    setWebError,
    setWebRestartLoading,
    sidePanelTab,
    sidebarWidth,
    sidebarResizing,
    startSidebarResize,
    toggleFileTreeDirectory,
    webActionLoading,
    webError,
    webLoading,
    webRestartLoading,
    webTargets,
    workspaceShellStyle,
  }
}
