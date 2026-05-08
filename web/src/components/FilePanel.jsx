import { useRef } from 'react'
import { FileTree } from './FileTree'

export function FilePanel({
  editorLoadingPath,
  fileDeleteLoadingPath,
  fileDeleteTarget,
  fileDownloadLoadingPath,
  fileUploadLoading,
  fileUploadProgress,
  fileTreeEntries,
  fileTreeError,
  fileTreeExpanded,
  fileTreeLoadingPaths,
  fileTreeNodes,
  fileTreeRoot,
  onDownloadFile,
  onCancelDeleteFile,
  onConfirmDeleteFile,
  onOpenEditor,
  onRefresh,
  onRequestDeleteFile,
  onToggleFileTreeDirectory,
  onUploadFiles,
  selectedProjectId,
}) {
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const uploadDisabled = fileUploadLoading || !selectedProjectId
  const deleteName = fileDeleteTarget?.split('/').filter(Boolean).pop() || fileDeleteTarget

  const handleUploadInputChange = (event) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length > 0) {
      onUploadFiles(files)
    }
  }

  return (
    <div className="side-panel-body">
      <div className="side-panel-scroll file-panel-scroll">
        <div className="git-panel-header">
          <div className="panel-heading git-panel-header-meta">
            <span className="panel-heading-title">文件</span>
            <span className="panel-heading-subtitle">{fileTreeRoot?.root || '仓库文件树'}</span>
          </div>
          <div className="web-debug-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="file-upload-input"
              onChange={handleUploadInputChange}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              className="file-upload-input"
              onChange={handleUploadInputChange}
            />
            <button
              className="secondary-btn git-btn"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadDisabled}
            >
              {fileUploadLoading ? '上传中...' : '上传文件'}
            </button>
            <button
              className="secondary-btn git-btn"
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={uploadDisabled}
            >
              上传文件夹
            </button>
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

        {fileUploadLoading ? (
          <div className="file-upload-progress" role="status" aria-live="polite">
            <div className="file-upload-progress__meta">
              <span>上传中...</span>
              {fileUploadProgress > 0 ? <span>{fileUploadProgress}%</span> : <span>准备上传</span>}
            </div>
            <div className="file-upload-progress__track">
              <span
                className="file-upload-progress__bar"
                style={{ width: `${fileUploadProgress > 0 ? fileUploadProgress : 8}%` }}
              />
            </div>
          </div>
        ) : null}

        {fileTreeLoadingPaths[''] && !fileTreeRoot ? (
          <div className="notice">正在读取仓库文件树...</div>
        ) : fileTreeEntries.length > 0 ? (
          <div className="file-tree-list skill-card">
            <span className="skill-card__accent" aria-hidden="true" />
            <FileTree
              fileDeleteLoadingPath={fileDeleteLoadingPath}
              fileDownloadLoadingPath={fileDownloadLoadingPath}
              editorLoadingPath={editorLoadingPath}
              fileTreeExpanded={fileTreeExpanded}
              fileTreeLoadingPaths={fileTreeLoadingPaths}
              fileTreeNodes={fileTreeNodes}
              onDownloadFile={onDownloadFile}
              onOpenFile={onOpenEditor}
              onRequestDeleteFile={onRequestDeleteFile}
              onToggleDirectory={onToggleFileTreeDirectory}
            />
          </div>
        ) : (
          <div className="notice">当前目录没有可展示的文件。</div>
        )}
      </div>
      {fileDeleteTarget ? (
        <div className="modal-backdrop" onClick={onCancelDeleteFile}>
          <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className="eyebrow">文件删除</span>
                <h3 className="modal-title">确认删除文件</h3>
              </div>
            </div>
            <p className="modal-copy">
              将从当前项目目录删除 <strong>{deleteName}</strong>。此操作会直接移除文件。
            </p>
            <div className="file-delete-path">{fileDeleteTarget}</div>
            <div className="modal-actions">
              <button className="ghost-btn" type="button" onClick={onCancelDeleteFile} disabled={Boolean(fileDeleteLoadingPath)}>
                取消
              </button>
              <button className="danger-btn" type="button" onClick={onConfirmDeleteFile} disabled={Boolean(fileDeleteLoadingPath)}>
                {fileDeleteLoadingPath ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
