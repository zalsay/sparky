export function DeleteProjectModal({
  deleteProjectError,
  deleteProjectTarget,
  deletingProject,
  onClose,
  onSubmit,
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="eyebrow">项目删除</span>
            <h3 className="modal-title">删除项目卡片</h3>
          </div>
        </div>

        <p className="modal-copy">
          将从工作区目录移除 <strong>{deleteProjectTarget.name}</strong>，并关闭该项目关联的 PTY。
          项目目录文件不会被删除。
        </p>

        {deleteProjectError ? <div className="notice notice-error">{deleteProjectError}</div> : null}

        <div className="modal-actions">
          <button className="ghost-btn" type="button" onClick={onClose} disabled={deletingProject}>
            取消
          </button>
          <button className="danger-btn" type="button" onClick={onSubmit} disabled={deletingProject}>
            {deletingProject ? '删除中...' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
