import { BRAND_LOGO_SRC } from '../app/constants'
import { runtimeLabel } from '../app/data'

export function WorkspaceTopbar({
  codexLoading,
  codexResumeLoading,
  connected,
  onLeaveSessionView,
  onOpenPrimarySession,
  onResumeCodexSession,
  selectedProject,
  step,
}) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <button
          className="toolbar-btn toolbar-btn-icon topbar-back-btn"
          onClick={onLeaveSessionView}
          aria-label="返回列表"
          title="返回列表"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M11.75 4.5L6.25 10L11.75 15.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="brand-mark">
          <img className="brand-mark-logo" src={BRAND_LOGO_SRC} alt="Sparky" />
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
            onClick={() => onResumeCodexSession()}
            disabled={codexLoading || codexResumeLoading !== ''}
          >
            {codexResumeLoading === '__latest__' ? '恢复中' : '恢复最近会话'}
          </button>
        ) : null}
        <button
          className="toolbar-btn"
          onClick={onOpenPrimarySession}
          disabled={!selectedProject?.id || step === 'connecting'}
        >
          新开主会话
        </button>
      </div>
    </header>
  )
}
