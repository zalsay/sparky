import { webFrameworkLabel } from '../app/data'

export function WebDebugPanel({
  activeWebTarget,
  hasWebTargets,
  onLoadWebTargets,
  onOpenWebDebug,
  onRestartWebDebug,
  onSelectTarget,
  selectedProjectId,
  webActionLoading,
  webError,
  webLoading,
  webRestartLoading,
  webTargets,
}) {
  return (
    <div className="side-panel-body">
      <div className="web-debug-panel side-panel-scroll">
        <div className="web-debug-panel-header">
          <div className="panel-heading">
            <span className="panel-heading-title">调试页</span>
            <span className="panel-heading-subtitle">Web 开发服务</span>
          </div>
          <div className="web-debug-actions">
            <button
              className="secondary-btn git-btn git-refresh-btn"
              type="button"
              onClick={onLoadWebTargets}
              disabled={webLoading || !selectedProjectId}
            >
              {webLoading ? '扫描中...' : '刷新'}
            </button>
            {activeWebTarget?.running ? (
              <button
                className="secondary-btn git-btn"
                type="button"
                onClick={onRestartWebDebug}
                disabled={webLoading || webActionLoading || webRestartLoading || !activeWebTarget}
              >
                {webRestartLoading ? '重启中...' : '重启调试页'}
              </button>
            ) : null}
            <button
              className="primary-btn git-btn"
              type="button"
              onClick={onOpenWebDebug}
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
                  className={`web-debug-target skill-card list-card ${target.id === activeWebTarget?.id ? 'active is-selected' : ''}`}
                  onClick={() => onSelectTarget(target.id)}
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
            {activeWebTarget && activeWebTarget.supportLevel !== 'full' ? (
              <div className="notice">
                当前为兼容模式。已接入自动转发，但对非 Vite/Astro 项目可能需要再补框架级参数。
              </div>
            ) : null}
          </>
        ) : (
          <div className="notice">当前项目未检测到带 `dev` 脚本的 Web 工程。</div>
        )}
      </div>
    </div>
  )
}
