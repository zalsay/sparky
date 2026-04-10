import { BRAND_LOGO_SRC } from '../app/constants'
import { runtimeLabel } from '../app/data'

export function DashboardPage({
  activeSessionCount,
  auth,
  loadingProjects,
  onActivatePersistentSession,
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
  return (
    <div className="app dashboard-page">
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
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

      <main className="dashboard-shell">
        <section className="catalog-panel glass-panel">
          <div className="section-bar">
            <div>
              <span className="eyebrow">模型终端</span>
              <h2 className="section-title">智能体工作区目录</h2>
            </div>
            <div className="section-actions">
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
                  onClick={() => onSelectProject(project)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectProject(project)
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
      </main>
    </div>
  )
}
