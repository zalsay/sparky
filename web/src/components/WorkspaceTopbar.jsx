import { BRAND_LOGO_SRC } from '../app/constants'
import { runtimeLabel } from '../app/data'

function sidePanelLabel(tab, isCodexProject) {
  if (tab === 'codex' && isCodexProject) {
    return 'Codex'
  }
  if (tab === 'web') {
    return 'Web'
  }
  if (tab === 'files') {
    return '文件'
  }
  return 'Git'
}

export function WorkspaceTopbar({
  codexLoading,
  codexBusy,
  codexResumeLoading,
  connected,
  isMobileViewport,
  mobileSidePanelOpen,
  onLeaveSessionView,
  onOpenPrimarySession,
  onResumeCodexSession,
  onToggleMobileSidePanel,
  selectedProject,
  sidePanelTab,
  step,
}) {
  const isCodexProject = selectedProject?.runtime === 'codex'
  const connectionLabel = connected ? '已连接' : step === 'connecting' ? '连接中' : '已断开'

  if (isMobileViewport) {
    return (
      <header className="topbar workspace-mobile-topbar">
        <div className="workspace-mobile-topbar-row">
          <button
            className="toolbar-btn toolbar-btn-icon topbar-back-btn workspace-mobile-topbar-icon-btn"
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

          <div className="workspace-mobile-topbar-main">
            <div className="brand-mark">
              <img className="brand-mark-logo" src={BRAND_LOGO_SRC} alt="Sparky" />
              <span className="brand-mark-text">{selectedProject?.name || selectedProject?.id || 'Sparky'}</span>
            </div>
          </div>

          <div className="workspace-mobile-topbar-meta">
            {isCodexProject ? (
              <span className={`workspace-mobile-tag workspace-mobile-tag-provider ${codexBusy ? 'is-busy' : ''}`}>
                {codexBusy ? <span className="workspace-mobile-tag-provider-dot" aria-hidden="true" /> : null}
                <span>Codex</span>
              </span>
            ) : null}
            <span className={`workspace-mobile-tag workspace-mobile-tag-status ${connected ? 'is-online' : 'is-offline'}`}>
              {connectionLabel}
            </span>
            <button
              type="button"
              className={`toolbar-btn toolbar-btn-icon workspace-mobile-panel-toggle workspace-mobile-topbar-icon-btn ${mobileSidePanelOpen ? 'active' : ''}`}
              onClick={onToggleMobileSidePanel}
              aria-label={mobileSidePanelOpen ? '关闭右侧面板' : '打开右侧面板'}
              title={`${mobileSidePanelOpen ? '关闭' : '打开'} ${sidePanelLabel(sidePanelTab, isCodexProject)} 面板`}
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
    )
  }

  return (
    <header className="topbar">
      <div className="topbar-brand workspace-topbar-brand">
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
        <div className="workspace-topbar-main">
          <div className="brand-mark">
            <img className="brand-mark-logo" src={BRAND_LOGO_SRC} alt="Sparky" />
            <span className="brand-mark-text workspace-brand-text">{selectedProject?.name || selectedProject?.id || 'Sparky'}</span>
            <span className={`topbar-runtime-chip runtime-${selectedProject?.runtime || 'generic'}`}>
              {runtimeLabel(selectedProject?.runtime)}
            </span>
          </div>
        </div>
        {isMobileViewport ? (
          <button
            type="button"
            className={`toolbar-btn toolbar-btn-icon workspace-mobile-panel-toggle ${mobileSidePanelOpen ? 'active' : ''}`}
            onClick={onToggleMobileSidePanel}
            aria-label={mobileSidePanelOpen ? '关闭右侧面板' : '打开右侧面板'}
            title={`${mobileSidePanelOpen ? '关闭' : '打开'} ${sidePanelLabel(sidePanelTab, isCodexProject)} 面板`}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M4 6h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4 10h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4 14h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="topbar-actions workspace-topbar-actions">
        <span className={`status-pill ${connected ? 'online' : 'offline'}`}>{connectionLabel}</span>
        {isCodexProject ? (
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
