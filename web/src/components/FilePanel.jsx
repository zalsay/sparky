import { FileTree } from './FileTree'

export function FilePanel({
  editorLoadingPath,
  fileTreeEntries,
  fileTreeError,
  fileTreeExpanded,
  fileTreeLoadingPaths,
  fileTreeNodes,
  fileTreeRoot,
  onOpenEditor,
  onRefresh,
  onToggleFileTreeDirectory,
  selectedProjectId,
}) {
  return (
    <div className="side-panel-body">
      <div className="side-panel-scroll file-panel-scroll">
        <div className="git-panel-header">
          <div className="panel-heading git-panel-header-meta">
            <span className="panel-heading-title">文件</span>
            <span className="panel-heading-subtitle">{fileTreeRoot?.root || '仓库文件树'}</span>
          </div>
          <div className="web-debug-actions">
            <button
              className="secondary-btn git-btn git-refresh-btn"
              type="button"
              onClick={onRefresh}
              disabled={Boolean(fileTreeLoadingPaths['']) || !selectedProjectId}
            >
              {fileTreeLoadingPaths[''] ? '刷新中...' : '刷新'}
            </button>
            <button
              className="primary-btn git-btn"
              type="button"
              onClick={() => onOpenEditor('')}
              disabled={editorLoadingPath === '__root__' || !selectedProjectId}
            >
              {editorLoadingPath === '__root__' ? '打开中...' : '打开编辑器'}
            </button>
          </div>
        </div>

        {fileTreeError ? <div className="notice notice-error">{fileTreeError}</div> : null}

        {fileTreeLoadingPaths[''] && !fileTreeRoot ? (
          <div className="notice">正在读取仓库文件树...</div>
        ) : fileTreeEntries.length > 0 ? (
          <div className="file-tree-list skill-card">
            <span className="skill-card__accent" aria-hidden="true" />
            <FileTree
              editorLoadingPath={editorLoadingPath}
              fileTreeExpanded={fileTreeExpanded}
              fileTreeLoadingPaths={fileTreeLoadingPaths}
              fileTreeNodes={fileTreeNodes}
              onOpenFile={onOpenEditor}
              onToggleDirectory={onToggleFileTreeDirectory}
            />
          </div>
        ) : (
          <div className="notice">当前目录没有可展示的文件。</div>
        )}
      </div>
    </div>
  )
}
