import { useEffect, useState } from 'react'
import { CodexConversationPanel } from './CodexConversationPanel'

function sessionTabLabel(tab, sessionTabs) {
  if (!tab.temporary) {
    const primaryTabs = sessionTabs.filter((item) => !item.temporary)
    if (primaryTabs.length > 1) {
      return `主 ${tab.id.slice(0, 4)}`
    }

    return '主会话'
  }

  const temporaryTabs = sessionTabs.filter((item) => item.temporary)
  const index = temporaryTabs.findIndex((item) => item.id === tab.id)
  return index >= 0 ? `终端 ${index + 1}` : '终端'
}

function MobilePtyManager({
  connected,
  currentSessionTemporary,
  onDestroyCurrentSession,
  onOpenTemporarySession,
  onOpenRawTerminal,
  onRefreshTimeline,
  onScrollToBottom,
  onSwitchSessionTab,
  selectedProject,
  sessionId,
  sessionTabs,
  step,
  variant = 'panel',
}) {
  if (!sessionTabs.length) {
    return null
  }

  const statusLabel = connected ? '运行中' : '未连接'

  return (
    <div className={`mobile-pty-manager mobile-pty-manager-${variant}`}>
      <div className="mobile-pty-manager__header">
        <span className="eyebrow">会话列表</span>
        <div className="mobile-pty-manager__actions">
          {variant === 'panel' ? (
            <>
              <button
                type="button"
                className="mobile-pty-manager__icon-btn"
                onClick={onScrollToBottom}
                aria-label="滚动到底部"
                title="滚动到底部"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 4.25v9.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M6.3 10.7L10 14.45l3.7-3.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5.25 16h9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className="mobile-pty-manager__icon-btn"
                onClick={onRefreshTimeline}
                aria-label="刷新"
                title="刷新"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M15.5 7.5A6 6 0 106.3 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M15.5 4.75v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="mobile-pty-manager__icon-btn"
                onClick={onOpenRawTerminal}
                aria-label="原始终端"
                title="原始终端"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M4.5 5.75h11a1.25 1.25 0 011.25 1.25v6a1.25 1.25 0 01-1.25 1.25h-11A1.25 1.25 0 013.25 13V7A1.25 1.25 0 014.5 5.75z" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M6.25 8.4l1.85 1.6-1.85 1.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9.9 11.6h3.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="mobile-pty-manager__icon-btn"
            onClick={onOpenTemporarySession}
            disabled={!selectedProject?.id || step === 'connecting'}
            aria-label="新开临时 PTY"
            title="新开临时 PTY"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 4.5v11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="mobile-pty-manager__icon-btn"
            onClick={onDestroyCurrentSession}
            disabled={!sessionId}
            aria-label={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
            title={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M6 6l8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="terminal-tabs mobile-pty-manager__tabs" role="tablist" aria-label="移动端会话列表">
        {sessionTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === sessionId}
            className={`terminal-tab ${tab.id === sessionId ? 'active' : ''}`}
            onClick={() => onSwitchSessionTab(tab)}
            title={`${tab.label} · ${tab.id}`}
          >
            <span className={`terminal-tab-dot ${tab.temporary ? 'temporary' : 'default'}`} />
            <span>{sessionTabLabel(tab, sessionTabs)}</span>
            {tab.id === sessionId ? (
              <span className={`terminal-tab-status ${connected ? 'is-online' : 'is-offline'}`}>
                {statusLabel}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

export function TerminalPanel({
  canReconnectCurrentSession,
  connected,
  codexTimeline,
  codexTimelineError,
  codexTimelineLoading,
  currentSessionTemporary,
  onDestroyCurrentSession,
  onLeaveSessionView,
  onRefreshCodexTimeline,
  onOpenTemporarySession,
  onReconnectCurrentSession,
  onSwitchSessionTab,
  reconnectNotice,
  selectedProject,
  sessionId,
  sessionTabs,
  step,
  registerTerminalHost,
}) {
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 780 : false
  ))
  const [showRawTerminal, setShowRawTerminal] = useState(false)
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0)
  const isCodexMobile = selectedProject?.runtime === 'codex' && isMobileViewport

  useEffect(() => {
    const handleResize = () => {
      setIsMobileViewport(window.innerWidth <= 780)
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
    }
  }, [])

  useEffect(() => {
    if (!isCodexMobile) {
      setShowRawTerminal(false)
    }
  }, [isCodexMobile, sessionId])

  if (isCodexMobile) {
    return (
      <section className="terminal-panel glass-panel terminal-panel-codex-mobile">
        <MobilePtyManager
          connected={connected}
          currentSessionTemporary={currentSessionTemporary}
          onDestroyCurrentSession={onDestroyCurrentSession}
          onOpenTemporarySession={onOpenTemporarySession}
          onOpenRawTerminal={() => setShowRawTerminal(true)}
          onRefreshTimeline={onRefreshCodexTimeline}
          onScrollToBottom={() => setScrollToBottomRequest((value) => value + 1)}
          onSwitchSessionTab={onSwitchSessionTab}
          selectedProject={selectedProject}
          sessionId={sessionId}
          sessionTabs={sessionTabs}
          step={step}
          variant="panel"
        />

        {showRawTerminal ? (
          <section className="codex-raw-terminal-sheet">
            <div className="codex-raw-terminal-sheet__header">
              <strong className="codex-raw-terminal-sheet__title">原始终端</strong>
              <button
                type="button"
                className="chat-panel__info-button codex-raw-terminal-sheet__close"
                onClick={() => setShowRawTerminal(false)}
              >
                关闭
              </button>
            </div>
            <div className="terminal-host-shell codex-raw-terminal-sheet__body">
              <div className="terminal-host-stack">
                {sessionTabs.length ? (
                  sessionTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`terminal-host ${tab.id === sessionId ? 'active' : 'inactive'}`}
                      aria-hidden={tab.id === sessionId ? undefined : 'true'}
                    >
                      <div ref={registerTerminalHost(tab.id)} className="terminal-host-canvas" />
                    </div>
                  ))
                ) : (
                  <div className="codex-conversation-state">当前没有可附着的终端会话。</div>
                )}
              </div>
            </div>
          </section>
        ) : (
          <CodexConversationPanel
            codexTimeline={codexTimeline}
            codexTimelineError={codexTimelineError}
            codexTimelineLoading={codexTimelineLoading}
            sessionId={sessionId}
            scrollToBottomRequest={scrollToBottomRequest}
          />
        )}

        {reconnectNotice ? (
          <div className="terminal-reconnect-banner codex-mobile-reconnect-banner" role="status" aria-live="polite">
            <span className="terminal-reconnect-text">{reconnectNotice.message}</span>
            <button
              type="button"
              className="toolbar-btn terminal-reconnect-btn"
              onClick={onReconnectCurrentSession}
              disabled={!canReconnectCurrentSession}
            >
              {step === 'connecting' ? '恢复中' : '恢复当前 PTY'}
            </button>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section className="terminal-panel glass-panel">
      <div className="terminal-panel-bar">
        <div className="terminal-toolbar">
          <div className="terminal-dots">
            <button
              type="button"
              className="terminal-dot terminal-dot-close"
              onClick={onDestroyCurrentSession}
              disabled={!sessionId}
              aria-label={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
              title={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
            />
            <button
              type="button"
              className="terminal-dot terminal-dot-minimize"
              onClick={onLeaveSessionView}
              aria-label="返回列表"
              title="返回列表"
            />
            <button
              type="button"
              className="terminal-dot terminal-dot-expand"
              onClick={onOpenTemporarySession}
              disabled={!selectedProject?.id || step === 'connecting'}
              aria-label="打开新的临时 PTY"
              title="打开新的临时 PTY"
            />
          </div>
          <div className="terminal-tabs" role="tablist" aria-label="PTY 标签">
            {sessionTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === sessionId}
                className={`terminal-tab ${tab.id === sessionId ? 'active' : ''}`}
                onClick={() => onSwitchSessionTab(tab)}
                title={`${tab.label} · ${tab.id}`}
              >
                <span className={`terminal-tab-dot ${tab.temporary ? 'temporary' : 'default'}`} />
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="terminal-panel-meta">
          <span>{currentSessionTemporary ? '临时 Shell' : `${selectedProject?.provider || '自定义'} 运行时`}</span>
          <span>{connected ? '实时流' : '等待流建立'}</span>
        </div>
      </div>

      <div className="terminal-host-shell">
        <div className="terminal-host-stack">
          {sessionTabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-host ${tab.id === sessionId ? 'active' : 'inactive'}`}
              aria-hidden={tab.id === sessionId ? undefined : 'true'}
            >
              <div ref={registerTerminalHost(tab.id)} className="terminal-host-canvas" />
            </div>
          ))}
        </div>
        {reconnectNotice ? (
          <div className="terminal-reconnect-banner" role="status" aria-live="polite">
            <span className="terminal-reconnect-text">{reconnectNotice.message}</span>
            <button
              type="button"
              className="toolbar-btn terminal-reconnect-btn"
              onClick={onReconnectCurrentSession}
              disabled={!canReconnectCurrentSession}
            >
              {step === 'connecting' ? '恢复中' : '恢复当前 PTY'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
