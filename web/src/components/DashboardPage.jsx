import { useEffect, useState } from 'react'
import { BRAND_LOGO_SRC } from '../app/constants'
import { formatDateTime, runtimeLabel } from '../app/data'

function projectSessionLabel(session, allSessions) {
  if (!session?.temporary) {
    const primarySessions = allSessions.filter((item) => !item.temporary)
    if (primarySessions.length > 1) {
      return `主会话 ${session.id.slice(0, 4)}`
    }

    return '主会话'
  }

  const temporarySessions = allSessions.filter((item) => item.temporary)
  const index = temporarySessions.findIndex((item) => item.id === session.id)
  return index >= 0 ? `终端 ${index + 1}` : '终端'
}

function ProjectSessionPickerModal({
  codexSessionTitlesByPtySessionId,
  onClose,
  onSelectSession,
  project,
  sessions,
}) {
  const latestSessionId = sessions[0]?.id || ''

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card glass-panel session-picker-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="eyebrow">选择会话</span>
            <h3 className="modal-title">{project?.name || '项目会话'}</h3>
          </div>
        </div>
        <p className="modal-copy">检测到多个保留中的会话，选择要进入的会话。</p>
        <div className="session-picker-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="session-picker-item list-card"
              onClick={() => onSelectSession(session)}
            >
              <div className="session-picker-item__main">
                <div className="session-picker-item__title-row">
                  <strong>{projectSessionLabel(session, sessions)}</strong>
                  {session.id === latestSessionId ? <span className="project-badge">最近会话</span> : null}
                  {session.temporary ? <span className="project-meta">临时 PTY</span> : null}
                </div>
                {codexSessionTitlesByPtySessionId?.[session.id] ? (
                  <span className="session-picker-item__meta">{codexSessionTitlesByPtySessionId[session.id]}</span>
                ) : null}
                <span className="session-picker-item__meta">{session.id}</span>
              </div>
              <div className="session-picker-item__side">
                <span>{formatDateTime(session.createdAtMs)}</span>
                <span>进入</span>
              </div>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="ghost-btn" type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

export function DashboardPage({
  activeSessionCount,
  auth,
  codexSessionTitlesByPtySessionId,
  loadingProjects,
  onActivatePersistentSession,
  onLoadCodexSessionTitles,
  onLoadWorkspaceState,
  onLogout,
  onOpenCreateProjectForm,
  onOpenEditProjectForm,
  onRequestDeleteProject,
  onSelectProject,
  orderedProjects,
  preferredProjectId,
  projectError,
  sessionByProjectId,
  sessionCountByProjectId,
  sessions,
  temporarySessionCountByProjectId,
  totalProjects,
}) {
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 780 : false
  ))
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [sessionPickerProject, setSessionPickerProject] = useState(null)

  useEffect(() => {
    const handleResize = () => {
      const nextIsMobile = window.innerWidth <= 780
      setIsMobileViewport(nextIsMobile)
      if (!nextIsMobile) {
        setMobileMenuOpen(false)
        setSessionPickerProject(null)
      }
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
    }
  }, [])

  const handleProjectEnter = async (project) => {
    const projectSessions = sessions
      .filter((session) => session.projectId === project.id)
      .sort((left, right) => right.createdAtMs - left.createdAtMs)

    if (projectSessions.length <= 1) {
      if (projectSessions[0]) {
        onActivatePersistentSession(project, projectSessions[0].id)
        return
      }

      onSelectProject(project)
      return
    }

    if (!isMobileViewport) {
      onActivatePersistentSession(project, projectSessions[0].id)
      return
    }

    let titleMap = codexSessionTitlesByPtySessionId || {}
    if (project.runtime === 'codex' && typeof onLoadCodexSessionTitles === 'function') {
      titleMap = await onLoadCodexSessionTitles(project, projectSessions)
    }

    setSessionPickerProject({
      project,
      sessions: projectSessions,
      titleMap,
    })
  }

  return (
    <div className="app dashboard-page">
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
      {isMobileViewport ? (
        <header className="topbar workspace-mobile-topbar dashboard-mobile-topbar">
          <div className="workspace-mobile-topbar-row">
            <div className="workspace-mobile-topbar-main">
              <div className="brand-mark">
                <img className="brand-mark-logo" src={BRAND_LOGO_SRC} alt="Sparky" />
                <span className="brand-mark-text">Sparky</span>
              </div>
            </div>

            <div className="workspace-mobile-topbar-meta dashboard-mobile-topbar-meta">
              <span className="workspace-mobile-tag workspace-mobile-tag-provider">
                <span>Codex</span>
              </span>
              <button
                type="button"
                className={`toolbar-btn toolbar-btn-icon workspace-mobile-panel-toggle workspace-mobile-topbar-icon-btn ${mobileMenuOpen ? 'active' : ''}`}
                onClick={() => setMobileMenuOpen((value) => !value)}
                aria-label={mobileMenuOpen ? '关闭菜单' : '打开菜单'}
                title={mobileMenuOpen ? '关闭菜单' : '打开菜单'}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M4 6h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M4 14h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        </header>
      ) : (
        <header className="topbar">
          <div className="topbar-brand">
            <div className="brand-mark">
              <img className="brand-mark-logo" src={BRAND_LOGO_SRC} alt="Sparky" />
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
            <button className="ghost-btn" onClick={onLogout}>
              退出
            </button>
          </div>
        </header>
      )}

      {isMobileViewport ? (
        <>
          <div
            className={`dashboard-mobile-menu-backdrop ${mobileMenuOpen ? 'is-open' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden={!mobileMenuOpen}
          />
          <div className={`dashboard-mobile-menu-drawer ${mobileMenuOpen ? 'is-open' : ''}`}>
            <aside className="glass-panel dashboard-mobile-menu">
              <div className="dashboard-mobile-menu__header">
                <span className="eyebrow">工作区</span>
                <strong className="dashboard-mobile-menu__title">账户与统计</strong>
              </div>
              <div className="identity-chip dashboard-mobile-menu__identity">
                <span className="identity-user">@{auth.user.username}</span>
              </div>
              <div className="topbar-stats dashboard-mobile-menu__stats">
                <div className="topbar-stat">
                  <span className="topbar-stat-label">项目</span>
                  <strong>{totalProjects}</strong>
                </div>
                <div className="topbar-stat">
                  <span className="topbar-stat-label">进行中</span>
                  <strong>{activeSessionCount}</strong>
                </div>
              </div>
              <div className="dashboard-mobile-menu__actions">
                <button
                  className="ghost-btn"
                  onClick={() => {
                    setMobileMenuOpen(false)
                    onLogout()
                  }}
                >
                  退出
                </button>
              </div>
            </aside>
          </div>
        </>
      ) : null}

      <main className="dashboard-shell">
        <section className="catalog-panel glass-panel">
          <div className="section-bar">
            <div>
              <span className="eyebrow">Codex</span>
              <h2 className="section-title">智能体工作区目录</h2>
            </div>
            <div className="section-actions dashboard-section-actions">
              <button className="primary-btn section-create-btn" onClick={onOpenCreateProjectForm}>
                新建项目
              </button>
              <button className="secondary-btn" onClick={onLoadWorkspaceState} disabled={loadingProjects}>
                {loadingProjects ? '刷新中...' : '刷新'}
              </button>
            </div>
          </div>

          {projectError ? <div className="notice notice-error">{projectError}</div> : null}

          {!loadingProjects && orderedProjects.length === 0 && !projectError ? (
            <div className="notice">当前还没有配置任何项目。</div>
          ) : null}

          <div className="project-grid">
            {orderedProjects.map((project) => {
              const activeSession = sessionByProjectId.get(project.id)
              const activeSessionCountForProject = sessionCountByProjectId.get(project.id) || 0
              const temporarySessionCountForProject = temporarySessionCountByProjectId.get(project.id) || 0
              const projectPath = project.bindDirs.find((dir) => dir !== '/tmp') || '/projects'

              return (
                <article
                  key={project.id}
                  className={`project-card skill-card list-card project-card-${project.accent} ${preferredProjectId === project.id ? 'preferred is-selected' : ''}`}
                  onClick={() => handleProjectEnter(project)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleProjectEnter(project)
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
                      {project.deletable ? (
                        <>
                          <button
                            type="button"
                            className="project-card-edit"
                            aria-label={`编辑项目 ${project.name}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenEditProjectForm(project)
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
                              onRequestDeleteProject(project)
                            }}
                          >
                            删除
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="project-card-body skill-card__description">
                    <div className="project-heading">
                      <h3 className="project-name">{project.name}</h3>
                      <span className="project-runtime">{runtimeLabel(project.runtime)}</span>
                    </div>
                    <p className="project-path">{projectPath}</p>
                    <div className="project-specs">
                      {activeSession ? <span className="project-meta">{activeSessionCountForProject > 1 ? `${activeSessionCountForProject} 个会话进行中` : '会话保留中'}</span> : null}
                      {!activeSession && temporarySessionCountForProject > 0 ? (
                        <span className="project-meta">{temporarySessionCountForProject > 1 ? `${temporarySessionCountForProject} 个临时 Shell 保活中` : '临时 Shell 保活中'}</span>
                      ) : null}
                      {!activeSession && preferredProjectId === project.id ? <span className="project-meta">上次使用</span> : null}
                      {project.gitUrl ? <span className="project-meta">已配置 Git</span> : null}
                    </div>
                  </div>
                  <span className="project-launch skill-card__cta">{activeSession ? '恢复会话' : '进入工作区'}</span>
                </article>
              )
            })}
          </div>

        </section>

        {!isMobileViewport ? (
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
                const project = orderedProjects.find((item) => item.id === session.projectId)

                return (
                  <button
                    key={session.id}
                    className="session-row skill-card list-card"
                    onClick={() => project && onActivatePersistentSession(project, session.id)}
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
        ) : null}
      </main>
      {isMobileViewport ? (
        <div className="dashboard-mobile-project-actions">
          <button className="primary-btn section-create-btn" onClick={onOpenCreateProjectForm}>
            新建项目
          </button>
          <button className="secondary-btn" onClick={onLoadWorkspaceState} disabled={loadingProjects}>
            {loadingProjects ? '刷新中...' : '刷新'}
          </button>
        </div>
      ) : null}
      {sessionPickerProject ? (
        <ProjectSessionPickerModal
          codexSessionTitlesByPtySessionId={sessionPickerProject.titleMap || codexSessionTitlesByPtySessionId}
          project={sessionPickerProject.project}
          sessions={sessionPickerProject.sessions}
          onClose={() => setSessionPickerProject(null)}
          onSelectSession={(session) => {
            setSessionPickerProject(null)
            onActivatePersistentSession(sessionPickerProject.project, session.id)
          }}
        />
      ) : null}
    </div>
  )
}
