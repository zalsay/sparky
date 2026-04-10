export function TerminalPanel({
  canReconnectCurrentSession,
  connected,
  currentSessionTemporary,
  onDestroyCurrentSession,
  onLeaveSessionView,
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
