import { useEffect, useRef, useState } from 'react'
import { SetiFileIcon, SetiFolderIcon, TreeChevronIcon } from '../app/seti.jsx'

function copyWithTextarea(value) {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('复制失败')
}

async function copyToClipboard(value) {
  if (!navigator.clipboard?.writeText) {
    copyWithTextarea(value)
    return
  }

  try {
    await navigator.clipboard.writeText(value)
  } catch {
    copyWithTextarea(value)
  }
}

function FileTreeNode({
  depth,
  fileDeleteLoadingPath,
  fileDownloadLoadingPath,
  editorLoadingPath,
  entry,
  fileTreeExpanded,
  fileTreeLoadingPaths,
  fileTreeNodes,
  onDownloadFile,
  onOpenFile,
  onRequestDeleteFile,
  onToggleDirectory,
}) {
  const actionMenuRef = useRef(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const isDirectory = entry.kind === 'directory'
  const expanded = Boolean(fileTreeExpanded[entry.path])
  const loading = Boolean(fileTreeLoadingPaths[entry.path])
  const opening = editorLoadingPath === entry.path
  const downloading = fileDownloadLoadingPath === entry.path
  const deleting = fileDeleteLoadingPath === entry.path

  useEffect(() => {
    if (!actionMenuOpen) {
      return undefined
    }

    const handlePointerDown = (event) => {
      if (!actionMenuRef.current?.contains(event.target)) {
        setActionMenuOpen(false)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setActionMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [actionMenuOpen])

  useEffect(() => {
    if (!copyStatus) return undefined
    const timeout = window.setTimeout(() => setCopyStatus(''), 1600)
    return () => window.clearTimeout(timeout)
  }, [copyStatus])

  return (
    <div className="file-tree-node" key={entry.path} ref={actionMenuRef}>
      <button
        type="button"
        className={`file-tree-row ${isDirectory ? 'directory' : 'file'} ${actionMenuOpen ? 'active' : ''}`}
        style={{ '--file-tree-depth': depth }}
        onClick={() => {
          if (isDirectory) {
            onToggleDirectory(entry.path)
            return
          }
          setActionMenuOpen((value) => !value)
        }}
        aria-expanded={!isDirectory ? actionMenuOpen : undefined}
        aria-haspopup={!isDirectory ? 'menu' : undefined}
        title={entry.path}
      >
        <span className={`file-tree-caret ${expanded ? 'expanded' : ''}`}>
          {isDirectory ? (loading ? '…' : entry.hasChildren ? <TreeChevronIcon expanded={expanded} /> : null) : null}
        </span>
        <span className={`file-tree-icon ${isDirectory ? 'directory' : 'file'}`}>
          {isDirectory ? <SetiFolderIcon expanded={expanded} /> : <SetiFileIcon name={entry.name} />}
        </span>
        <span className="file-tree-name">{entry.name}</span>
        {!isDirectory && opening ? <span className="file-tree-status">打开中...</span> : null}
        {!isDirectory && downloading ? <span className="file-tree-status">下载中...</span> : null}
        {!isDirectory && deleting ? <span className="file-tree-status">删除中...</span> : null}
        {!isDirectory && copyStatus ? <span className="file-tree-status">{copyStatus}</span> : null}
      </button>
      {!isDirectory && actionMenuOpen ? (
        <div className="file-tree-action-menu" role="menu" style={{ '--file-tree-depth': depth }}>
          <button
            type="button"
            className="file-tree-action"
            role="menuitem"
            onClick={async () => {
              setActionMenuOpen(false)
              try {
                await copyToClipboard(entry.path)
                setCopyStatus('已复制')
              } catch {
                setCopyStatus('复制失败')
              }
            }}
          >
            复制相对路径
          </button>
          <button
            type="button"
            className="file-tree-action"
            role="menuitem"
            onClick={() => {
              setActionMenuOpen(false)
              onOpenFile(entry.path)
            }}
            disabled={opening}
          >
            {opening ? '打开中...' : '打开'}
          </button>
          <button
            type="button"
            className="file-tree-action"
            role="menuitem"
            onClick={() => {
              setActionMenuOpen(false)
              onDownloadFile(entry.path)
            }}
            disabled={downloading}
          >
            {downloading ? '下载中...' : '下载'}
          </button>
          <button
            type="button"
            className="file-tree-action danger"
            role="menuitem"
            onClick={() => {
              setActionMenuOpen(false)
              onRequestDeleteFile(entry.path)
            }}
            disabled={deleting}
          >
            {deleting ? '删除中...' : '删除'}
          </button>
        </div>
      ) : null}
      {isDirectory && expanded ? (
        <FileTree
          depth={depth + 1}
          fileDeleteLoadingPath={fileDeleteLoadingPath}
          fileDownloadLoadingPath={fileDownloadLoadingPath}
          editorLoadingPath={editorLoadingPath}
          fileTreeExpanded={fileTreeExpanded}
          fileTreeLoadingPaths={fileTreeLoadingPaths}
          fileTreeNodes={fileTreeNodes}
          onDownloadFile={onDownloadFile}
          onOpenFile={onOpenFile}
          onRequestDeleteFile={onRequestDeleteFile}
          onToggleDirectory={onToggleDirectory}
          parentPath={entry.path}
        />
      ) : null}
    </div>
  )
}

export function FileTree({
  depth = 0,
  fileDeleteLoadingPath,
  fileDownloadLoadingPath,
  editorLoadingPath,
  fileTreeExpanded,
  fileTreeLoadingPaths,
  fileTreeNodes,
  onDownloadFile,
  onOpenFile,
  onRequestDeleteFile,
  onToggleDirectory,
  parentPath = '',
}) {
  const entries = fileTreeNodes[parentPath] || []
  if (entries.length === 0) {
    return null
  }

  return entries.map((entry) => (
    <FileTreeNode
      key={entry.path}
      depth={depth}
      fileDeleteLoadingPath={fileDeleteLoadingPath}
      fileDownloadLoadingPath={fileDownloadLoadingPath}
      editorLoadingPath={editorLoadingPath}
      entry={entry}
      fileTreeExpanded={fileTreeExpanded}
      fileTreeLoadingPaths={fileTreeLoadingPaths}
      fileTreeNodes={fileTreeNodes}
      onDownloadFile={onDownloadFile}
      onOpenFile={onOpenFile}
      onRequestDeleteFile={onRequestDeleteFile}
      onToggleDirectory={onToggleDirectory}
    />
  ))
}
