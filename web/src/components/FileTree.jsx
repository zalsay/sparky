import { SetiFileIcon, SetiFolderIcon, TreeChevronIcon } from '../app/seti.jsx'

function FileTreeNode({
  depth,
  editorLoadingPath,
  entry,
  fileTreeExpanded,
  fileTreeLoadingPaths,
  fileTreeNodes,
  onOpenFile,
  onToggleDirectory,
}) {
  const isDirectory = entry.kind === 'directory'
  const expanded = Boolean(fileTreeExpanded[entry.path])
  const loading = Boolean(fileTreeLoadingPaths[entry.path])
  const opening = editorLoadingPath === entry.path

  return (
    <div className="file-tree-node" key={entry.path}>
      <button
        type="button"
        className={`file-tree-row ${isDirectory ? 'directory' : 'file'}`}
        style={{ '--file-tree-depth': depth }}
        onClick={() => {
          if (isDirectory) {
            onToggleDirectory(entry.path)
            return
          }
          onOpenFile(entry.path)
        }}
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
      </button>
      {isDirectory && expanded ? (
        <FileTree
          depth={depth + 1}
          editorLoadingPath={editorLoadingPath}
          fileTreeExpanded={fileTreeExpanded}
          fileTreeLoadingPaths={fileTreeLoadingPaths}
          fileTreeNodes={fileTreeNodes}
          onOpenFile={onOpenFile}
          onToggleDirectory={onToggleDirectory}
          parentPath={entry.path}
        />
      ) : null}
    </div>
  )
}

export function FileTree({
  depth = 0,
  editorLoadingPath,
  fileTreeExpanded,
  fileTreeLoadingPaths,
  fileTreeNodes,
  onOpenFile,
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
      editorLoadingPath={editorLoadingPath}
      entry={entry}
      fileTreeExpanded={fileTreeExpanded}
      fileTreeLoadingPaths={fileTreeLoadingPaths}
      fileTreeNodes={fileTreeNodes}
      onOpenFile={onOpenFile}
      onToggleDirectory={onToggleDirectory}
    />
  ))
}
