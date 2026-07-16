import { useEffect, useRef, useState } from 'react'
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
  mobileSessionActions,
  onLeaveSessionView,
  onOpenPrimarySession,
  onResumeCodexSession,
  onToggleMobileSidePanel,
  selectedProject,
  sidePanelTab,
  step,
}) {
  const functionMenuRef = useRef(null)
  const [functionMenuOpen, setFunctionMenuOpen] = useState(false)
  const isCodexProject = selectedProject?.runtime === 'codex'
  const connectionLabel = connected ? '已连接' : step === 'connecting' ? '连接中' : '已断开'

  useEffect(() => {
    if (!functionMenuOpen) return undefined
    const closeMenu = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      if (event.type === 'pointerdown' && functionMenuRef.current?.contains(event.target)) return
      setFunctionMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeMenu)
    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeMenu)
    }
  }, [functionMenuOpen])

  const runMobileAction = (action) => {
    setFunctionMenuOpen(false)
    action?.()
  }

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
            {isCodexProject ? (
              <div className="workspace-mobile-function-menu" ref={functionMenuRef}>
                <button
                  type="button"
                  className={`toolbar-btn toolbar-btn-icon workspace-mobile-topbar-icon-btn ${functionMenuOpen ? 'active' : ''}`}
                  onClick={() => setFunctionMenuOpen((value) => !value)}
                  aria-label={functionMenuOpen ? '关闭会话功能' : '打开会话功能'}
                  aria-expanded={functionMenuOpen}
                  aria-haspopup="menu"
                  title="会话功能"
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M5 4.5h2.5V7H5V4.5zm7.5 0H15V7h-2.5V4.5zM5 12.5h2.5V15H5v-2.5zm7.5 0H15V15h-2.5v-2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </button>
                {functionMenuOpen ? (
                  <div className="workspace-mobile-function-popover" role="menu">
                    <button type="button" role="menuitem" onClick={() => runMobileAction(mobileSessionActions?.onScrollToBottom)} disabled={!mobileSessionActions?.sessionId}>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4.25v9.1M6.3 10.7L10 14.45l3.7-3.75M5.25 16h9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <span>滚动到底部</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => runMobileAction(mobileSessionActions?.onRefreshTimeline)}>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.5 7.5A6 6 0 106.3 15M15.5 4.75v4h-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <span>刷新会话</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => runMobileAction(mobileSessionActions?.onOpenRawTerminal)} disabled={!mobileSessionActions?.sessionId}>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4.5 5.75h11A1.25 1.25 0 0116.75 7v6a1.25 1.25 0 01-1.25 1.25h-11A1.25 1.25 0 013.25 13V7A1.25 1.25 0 014.5 5.75zM6.25 8.4L8.1 10l-1.85 1.6M9.9 11.6H13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      <span>原始终端</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => runMobileAction(mobileSessionActions?.onOpenTemporarySession)} disabled={!selectedProject?.id || step === 'connecting'}>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                      <span>新建临时终端</span>
                    </button>
                    <button className="is-danger" type="button" role="menuitem" onClick={() => runMobileAction(mobileSessionActions?.onDestroyCurrentSession)} disabled={!mobileSessionActions?.sessionId}>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
                      <span>{mobileSessionActions?.currentSessionTemporary ? '关闭临时终端' : '关闭主会话'}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
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
