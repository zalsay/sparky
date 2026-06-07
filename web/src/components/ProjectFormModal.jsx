import { PROJECT_PATH_PREFIX } from '../app/constants'

export function ProjectFormModal({
  createProjectError,
  creatingProject,
  isEditingProject,
  newProjectGitUrl,
  newProjectName,
  newProjectPath,
  onClose,
  onProjectGitUrlChange,
  onProjectNameChange,
  onProjectPathChange,
  onProjectRepoPathChange,
  projectRepoLoading,
  projectRepoOptions,
  selectedProjectRepoPath,
  onSubmit,
}) {
  const normalizedProjectPath = newProjectPath.replace(/^\/+/, '').replace(/^projects\/?/, '')
  const shouldShowRepoSelector = projectRepoLoading || projectRepoOptions.length > 0
  const needsExplicitRepoSelection = projectRepoOptions.length > 1 && !selectedProjectRepoPath
  const resolvedRepoDiffersFromInput = selectedProjectRepoPath && selectedProjectRepoPath !== normalizedProjectPath

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

          {shouldShowRepoSelector ? (
            <>
              <label className="field-label" htmlFor="project-repo-root">
                仓库根目录
              </label>
              <div className="field-select-shell">
                <select
                  id="project-repo-root"
                  className="field-input field-select field-select-mono"
                  value={selectedProjectRepoPath}
                  onChange={(event) => onProjectRepoPathChange(event.target.value)}
                  disabled={projectRepoLoading || projectRepoOptions.length === 0}
                >
                  {projectRepoOptions.length > 1 ? (
                    <option value="">请选择具体仓库根目录</option>
                  ) : null}
                  {projectRepoOptions.map((item) => (
                    <option key={item.path} value={item.path}>
                      {PROJECT_PATH_PREFIX}{item.label}
                    </option>
                  ))}
                </select>
                <span className="field-select-shell__icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none">
                    <path
                      d="M4 6.25L8 10.25l4-4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </div>
            </>
          ) : null}

          <label className="field-label" htmlFor="project-runtime">
            运行时
          </label>
          <div className="field-select-shell">
            <select
              id="project-runtime"
              className="field-input field-select"
              value="codex"
              disabled
            >
              <option value="codex">OpenAI Codex</option>
            </select>
            <span className="field-select-shell__icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 6.25L8 10.25l4-4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>

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

          {projectRepoLoading ? (
            <p className="form-hint">正在扫描该目录下的 Git 仓库...</p>
          ) : projectRepoOptions.length > 1 ? (
            <p className="form-hint">该目录下检测到多个 Git 仓库。项目目录会作为 executor 权限范围，所选仓库只作为运行和 Git 操作根目录。</p>
          ) : resolvedRepoDiffersFromInput ? (
            <p className="form-hint">运行和 Git 操作会定位到仓库根目录 <code>{PROJECT_PATH_PREFIX}{selectedProjectRepoPath}</code>，executor 权限仍覆盖项目路径。</p>
          ) : projectRepoOptions.length === 1 && selectedProjectRepoPath ? (
            <p className="form-hint">已自动定位到仓库根目录 <code>{PROJECT_PATH_PREFIX}{selectedProjectRepoPath}</code>。</p>
          ) : null}

          {createProjectError ? <div className="notice notice-error">{createProjectError}</div> : null}

          <div className="modal-actions">
            <button className="ghost-btn" type="button" onClick={onClose} disabled={creatingProject}>
              取消
            </button>
            <button className="primary-btn" type="submit" disabled={creatingProject || needsExplicitRepoSelection}>
              {creatingProject ? (isEditingProject ? '保存中...' : '创建中...') : (isEditingProject ? '保存修改' : '创建项目')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
