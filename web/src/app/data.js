import { PROJECT_PRESETS } from './constants'

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

export function runtimeLabel(runtime) {
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

export function normalizeProjects(payload) {
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

export function normalizeSessions(payload) {
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

export function sameSessionTabs(left, right) {
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

export function normalizeProjectPathInput(value) {
  return value
    .replace(/^\/+/, '')
    .replace(/^projects\/?/, '')
}

export function normalizeGitStatus(payload) {
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

export function normalizeWebTargets(payload) {
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

export function normalizeCodexSessions(payload) {
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

export function normalizeFileTree(payload) {
  const tree = payload?.tree || payload || {}

  return {
    root: tree.root || '',
    rootName: tree.root_name || '项目',
    currentPath: tree.current_path || '',
    source: tree.source || 'project',
    entries: Array.isArray(tree.entries)
      ? tree.entries
          .map((entry) => ({
            name: entry.name || '',
            path: entry.path || '',
            kind: entry.kind === 'directory' ? 'directory' : 'file',
            hasChildren: Boolean(entry.has_children),
          }))
          .filter((entry) => entry.name && entry.path !== undefined)
      : [],
  }
}

export function formatDateTime(value) {
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

export function webFrameworkLabel(framework) {
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

export function gitCodeLabel(code) {
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

export function gitOutputPreview(value) {
  return String(value || '').trim()
}

export function buildSessionTab(sessionId, project, temporary, existingTabs = []) {
  void existingTabs
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

  return {
    ...baseTab,
    label: `${projectName} · 终端`,
  }
}

export function composeSessionTabs(persistentSessions, projects, existingTabs = [], extraTemporaryTab = null) {
  void existingTabs
  const projectMap = new Map(projects.map((project) => [project.id, project]))
  const persistentCountByProject = persistentSessions.reduce((map, session) => {
    if (!session.temporary) {
      map.set(session.projectId, (map.get(session.projectId) || 0) + 1)
    }
    return map
  }, new Map())
  const primaryTabs = persistentSessions
    .filter((session) => !session.temporary)
    .map((session) => {
      const project = projectMap.get(session.projectId)
      if (!project) {
        return null
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

  const temporaryTabs = persistentSessions
    .filter((session) => session.temporary)
    .map((session) => {
      const project = projectMap.get(session.projectId)
      if (!project) {
        return null
      }

      return buildSessionTab(session.id, project, true)
    })
    .filter(Boolean)

  if (extraTemporaryTab && !temporaryTabs.some((tab) => tab.id === extraTemporaryTab.id)) {
    temporaryTabs.push(extraTemporaryTab)
  }

  return [...primaryTabs, ...temporaryTabs]
}
