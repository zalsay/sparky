export function SessionCloseModal({
  closeSessionError,
  closeSessionTarget,
  closingSession,
  onClose,
  onSubmit,
}) {
  if (!closeSessionTarget) {
    return null
  }

  return (
    <div className="modal-backdrop" onClick={closingSession ? undefined : onClose}>
      <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="eyebrow">会话关闭</span>
            <h3 className="modal-title">关闭当前会话</h3>
          </div>
        </div>

        <p className="modal-copy">
          即将关闭 <strong>{closeSessionTarget.label}</strong>。
          {closeSessionTarget.temporary
            ? ' 临时 PTY 会被直接结束。'
            : ' 主会话关闭后需要重新打开或恢复，当前运行态会结束。'}
        </p>

        {closeSessionError ? <div className="notice notice-error">{closeSessionError}</div> : null}

        <div className="modal-actions">
          <button className="ghost-btn" type="button" onClick={onClose} disabled={closingSession}>
            保留会话
          </button>
          <button className="danger-btn" type="button" onClick={onSubmit} disabled={closingSession}>
            {closingSession ? '关闭中...' : '确认关闭'}
          </button>
        </div>
      </div>
    </div>
  )
}
