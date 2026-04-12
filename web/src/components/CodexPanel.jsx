import { formatDateTime } from '../app/data'

export function CodexPanel({
  codexError,
  codexLoading,
  codexResumeLoading,
  codexSessions,
  currentCodexSession,
  hasCodexSessions,
  onLoadCodexSessions,
  onReturnToCurrentSession,
  onResumeCodexSession,
  selectedProjectId,
}) {
  return (
    <div className="side-panel-body">
      <div className="side-panel-scroll codex-panel-scroll">
        <div className="codex-panel-header">
          <div className="panel-heading">
            <span className="panel-heading-title">Codex</span>
            <span className="panel-heading-subtitle">可恢复会话</span>
          </div>
          <div className="web-debug-actions">
            <button
              className="secondary-btn git-btn git-refresh-btn"
              type="button"
              onClick={onLoadCodexSessions}
              disabled={codexLoading || !selectedProjectId}
            >
              {codexLoading ? '同步中...' : '刷新'}
            </button>
            <button
              className="primary-btn git-btn"
              type="button"
              onClick={() => onResumeCodexSession()}
              disabled={codexLoading || codexResumeLoading !== '' || !hasCodexSessions}
            >
              {codexResumeLoading === '__latest__' ? '恢复中...' : '恢复最近'}
            </button>
          </div>
        </div>

        {codexError ? <div className="notice notice-error">{codexError}</div> : null}

        {currentCodexSession ? (
          <div className="codex-session-list codex-session-list-current">
            <div className="codex-session-card skill-card list-card">
              <span className="skill-card__accent" aria-hidden="true" />
              <div className="codex-session-main">
                <strong>当前会话</strong>
                <span className="codex-session-meta">实时 PTY</span>
                <span className="codex-session-meta">{currentCodexSession.cwd || currentCodexSession.sessionId}</span>
              </div>
              <button
                className="secondary-btn git-btn"
                type="button"
                onClick={onReturnToCurrentSession}
                disabled={!selectedProjectId}
              >
                回到当前
              </button>
            </div>
          </div>
        ) : null}

        {codexLoading ? (
          <div className="notice">正在同步 `CODEX_HOME` 中的历史会话...</div>
        ) : hasCodexSessions ? (
          <div className="codex-session-list">
            {codexSessions.map((item) => (
              <div className="codex-session-card skill-card list-card" key={item.sessionId}>
                <span className="skill-card__accent" aria-hidden="true" />
                <div className="codex-session-main">
                  <strong>{item.title}</strong>
                  <span className="codex-session-meta">{item.cwd}</span>
                  <span className="codex-session-meta">{formatDateTime(item.updatedAtMs)} · {item.sessionId}</span>
                </div>
                <button
                  className="secondary-btn git-btn"
                  type="button"
                  onClick={() => onResumeCodexSession(item.sessionId)}
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
    </div>
  )
}
