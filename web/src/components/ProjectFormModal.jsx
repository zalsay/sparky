import { PROJECT_PATH_PREFIX } from '../app/constants'

export function ProjectFormModal({
  createProjectError,
  creatingProject,
  isEditingProject,
  newProjectGitUrl,
  newProjectName,
  newProjectPath,
  newProjectRuntime,
  onClose,
  onProjectGitUrlChange,
  onProjectNameChange,
  onProjectPathChange,
  onProjectRuntimeChange,
  onSubmit,
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="eyebrow">项目创建</span>
            <h3 className="modal-title">{isEditingProject ? '编辑项目工作区' : '新建项目工作区'}</h3>
          </div>
        </div>

        <form className="project-form" onSubmit={onSubmit}>
          <label className="field-label" htmlFor="project-name">
            项目名称
          </label>
          <input
            id="project-name"
            className="field-input"
            value={newProjectName}
            onChange={(event) => onProjectNameChange(event.target.value)}
            placeholder="例如 meetlife-admin"
            autoFocus
          />

          <label className="field-label" htmlFor="project-path">
            项目路径
          </label>
          <div className="path-input-shell">
            <span className="path-input-prefix">{PROJECT_PATH_PREFIX}</span>
            <input
              id="project-path"
              className="field-input path-input-field"
              value={newProjectPath}
              onChange={(event) => onProjectPathChange(event.target.value)}
              placeholder="例如 client/meetlife-admin"
            />
          </div>

          <label className="field-label" htmlFor="project-runtime">
            运行时
          </label>
          <select
            id="project-runtime"
            className="field-input field-select"
            value={newProjectRuntime}
            onChange={(event) => onProjectRuntimeChange(event.target.value)}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">OpenAI Codex</option>
          </select>

          <label className="field-label" htmlFor="project-git-url">
            Git 仓库地址
          </label>
          <input
            id="project-git-url"
            className="field-input"
            value={newProjectGitUrl}
            onChange={(event) => onProjectGitUrlChange(event.target.value)}
            placeholder="可选，例如 https://github.com/org/repo.git"
          />

          <p className="form-hint">
            {isEditingProject
              ? <>项目路径固定在 <code>{PROJECT_PATH_PREFIX}</code> 下。编辑只会更新工作区配置，并关闭该项目现有 PTY，不会移动或删除原目录文件。</>
              : <>项目会创建在固定目录 <code>{PROJECT_PATH_PREFIX}</code> 下。这里只需要填写后半段路径；填写 Git 地址时会自动 clone 到目标目录。</>}
          </p>

          {createProjectError ? <div className="notice notice-error">{createProjectError}</div> : null}

          <div className="modal-actions">
            <button className="ghost-btn" type="button" onClick={onClose} disabled={creatingProject}>
              取消
            </button>
            <button className="primary-btn" type="submit" disabled={creatingProject}>
              {creatingProject ? (isEditingProject ? '保存中...' : '创建中...') : (isEditingProject ? '保存修改' : '创建项目')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
