import { gitCodeLabel } from '../app/data'

export function GitPanel({
  commitMessage,
  gitActionLoading,
  gitAvailable,
  gitError,
  gitHasRemote,
  gitLoading,
  gitOutput,
  gitState,
  onCommitMessageChange,
  onLoadGitStatus,
  onRunGitAction,
  selectedProject,
}) {
  const gitBranchLabel = gitAvailable ? gitState?.branch || '未识别分支' : '未检测到仓库'

  return (
    <div className="side-panel-body">
      <div className="side-panel-scroll git-panel-scroll">
        <div className="git-panel-header">
          <div className="panel-heading">
            <span className="panel-heading-title">Git</span>
            <span className="panel-heading-subtitle">{`当前分支: ${gitBranchLabel}`}</span>
          </div>
          <button
            className="secondary-btn git-btn git-refresh-btn"
            type="button"
            onClick={onLoadGitStatus}
            disabled={gitLoading || !selectedProject?.id}
          >
            {gitLoading ? '刷新中...' : '刷新'}
          </button>
        </div>

        {gitState && gitAvailable ? (
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
        ) : null}

        {selectedProject?.gitUrl ? (
          <div className="notice git-remote-notice">
            远端仓库：{selectedProject.gitUrl}
          </div>
        ) : null}

        {gitError ? <div className="notice notice-error">{gitError}</div> : null}
        {!gitError && gitState?.message ? <div className="notice">{gitState.message}</div> : null}
        {gitOutput && !gitError ? <div className="notice git-output">{gitOutput}</div> : null}

        <div className="git-actions">
          <button
            className="secondary-btn git-btn"
            type="button"
            onClick={() => onRunGitAction('fetch')}
            disabled={gitActionLoading !== '' || gitLoading || !gitAvailable}
          >
            {gitActionLoading === 'fetch' ? '执行中...' : 'Fetch'}
          </button>
          <button
            className="secondary-btn git-btn"
            type="button"
            onClick={() => onRunGitAction('pull')}
            disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !gitHasRemote}
          >
            {gitActionLoading === 'pull' ? '执行中...' : 'Pull'}
          </button>
          <button
            className="secondary-btn git-btn"
            type="button"
            onClick={() => onRunGitAction('push')}
            disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !gitHasRemote}
          >
            {gitActionLoading === 'push' ? '执行中...' : 'Push'}
          </button>
          <button
            className="secondary-btn git-btn"
            type="button"
            onClick={() => onRunGitAction('stage_all')}
            disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !gitState?.hasChanges}
          >
            {gitActionLoading === 'stage_all' ? '执行中...' : '暂存全部'}
          </button>
        </div>

        <div className="git-commit-box">
          <label className="panel-heading-title git-section-title" htmlFor="git-commit-message">
            提交说明
          </label>
          <input
            id="git-commit-message"
            className="field-input"
            value={commitMessage}
            onChange={(event) => onCommitMessageChange(event.target.value)}
            placeholder="例如 feat: 更新登录逻辑"
          />
          <button
            className="primary-btn git-btn git-commit-btn"
            type="button"
            onClick={() => onRunGitAction('commit')}
            disabled={gitActionLoading !== '' || gitLoading || !gitAvailable || !commitMessage.trim()}
          >
            {gitActionLoading === 'commit' ? '提交中...' : '提交全部改动'}
          </button>
        </div>

        {gitAvailable && gitState?.lastCommit ? (
          <div className="git-last-commit">
            <span className="panel-heading-title git-section-title">最近提交</span>
            <strong>{gitState.lastCommit.subject}</strong>
            <span className="git-last-commit-meta">
              {gitState.lastCommit.author} · {gitState.lastCommit.relativeTime} · {gitState.lastCommit.id.slice(0, 7)}
            </span>
          </div>
        ) : null}

        <div className="git-file-list">
          {gitLoading ? (
            <div className="notice">正在读取仓库状态...</div>
          ) : gitAvailable && gitState?.changes?.length ? (
            gitState.changes.map((change) => (
              <div className="git-file-row" key={`${change.originalPath || ''}-${change.path}-${change.staged}-${change.unstaged}`}>
                <div className="git-file-main">
                  <span className="git-file-path">{change.path}</span>
                  {change.originalPath ? <span className="git-file-prev">{change.originalPath}</span> : null}
                </div>
                <div className="git-file-badges">
                  {gitCodeLabel(change.staged) ? (
                    <span className="git-change-badge git-change-staged">{gitCodeLabel(change.staged)}</span>
                  ) : null}
                  {gitCodeLabel(change.unstaged) ? (
                    <span className="git-change-badge git-change-worktree">{gitCodeLabel(change.unstaged)}</span>
                  ) : null}
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
    </div>
  )
}
