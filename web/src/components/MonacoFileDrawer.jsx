import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

loader.config({ monaco })

const LANGUAGE_BY_EXTENSION = {
  bash: 'shell', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', dockerfile: 'dockerfile',
  go: 'go', h: 'c', hpp: 'cpp', html: 'html', ini: 'ini', java: 'java', js: 'javascript',
  json: 'json', jsx: 'javascript', kt: 'kotlin', less: 'less', lua: 'lua', md: 'markdown',
  php: 'php', py: 'python', rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'shell', sql: 'sql',
  toml: 'ini', ts: 'typescript', tsx: 'typescript', vue: 'html', xml: 'xml', yaml: 'yaml', yml: 'yaml',
}

function languageForPath(path) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  const extension = name.includes('.') ? name.split('.').pop() : ''
  return LANGUAGE_BY_EXTENSION[extension] || 'plaintext'
}

function isMarkdownPath(path) {
  const name = path.split('/').pop()?.toLowerCase() || ''
  return name.endsWith('.md') || name.endsWith('.markdown')
}

function formatFileSize(size) {
  if (!Number.isFinite(size)) return ''
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`
}

export function MonacoFileDrawer({
  content,
  error,
  onChange,
  onClose,
  onSave,
  open,
  path,
  saving,
  size,
  savedContent,
}) {
  const editorRef = useRef(null)
  const [sourceViewPath, setSourceViewPath] = useState('')
  const dirty = content !== savedContent
  const language = useMemo(() => languageForPath(path), [path])
  const markdown = useMemo(() => isMarkdownPath(path), [path])
  const previewingMarkdown = markdown && sourceViewPath !== path

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (dirty && !saving) onSave()
      }
      if (event.key === 'Escape' && !dirty) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [dirty, onClose, onSave, open, saving])

  const requestClose = () => {
    if (dirty && !window.confirm('文件尚未保存，确定关闭吗？')) return
    onClose()
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className={`file-editor-layer ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <button className="file-editor-backdrop" type="button" aria-label="关闭文件编辑器" onClick={requestClose} />
      <aside className="file-editor-drawer" aria-label="文件编辑器">
        <header className="file-editor-header">
          <div className="file-editor-heading">
            <strong title={path}>{path || '文件'}</strong>
            <span>{language} · {formatFileSize(size)}{dirty ? ' · 未保存' : ''}</span>
          </div>
          <div className="file-editor-actions">
            {markdown ? (
              <div className="file-editor-view-switch" role="group" aria-label="Markdown 查看模式">
                <button
                  className={previewingMarkdown ? 'is-active' : ''}
                  type="button"
                  onClick={() => setSourceViewPath('')}
                >
                  预览
                </button>
                <button
                  className={!previewingMarkdown ? 'is-active' : ''}
                  type="button"
                  onClick={() => setSourceViewPath(path)}
                >
                  源码
                </button>
              </div>
            ) : null}
            <button className="primary-btn file-editor-save" type="button" onClick={onSave} disabled={!dirty || saving}>
              {saving ? '保存中...' : dirty ? '保存' : '已保存'}
            </button>
            <button className="toolbar-btn toolbar-btn-icon" type="button" onClick={requestClose} aria-label="关闭编辑器" title="关闭编辑器">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>
        {error ? <div className="notice notice-error file-editor-error">{error}</div> : null}
        {previewingMarkdown ? (
          <div className="file-editor-markdown-scroll">
            <article className="file-editor-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ children, href, title }) => (
                    <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
                  ),
                  img: ({ alt, src, title }) => <img alt={alt || ''} src={src} title={title} loading="lazy" />,
                }}
              >
                {content}
              </ReactMarkdown>
            </article>
          </div>
        ) : (
          <div className="file-editor-monaco">
            <Editor
              height="100%"
              language={language}
              path={path}
              theme="vs-dark"
              value={content}
              onChange={(value) => onChange(value ?? '')}
              onMount={(editor) => {
                editorRef.current = editor
                editor.focus()
              }}
              options={{
                automaticLayout: true,
                fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
                fontSize: 13,
                minimap: { enabled: true },
                padding: { top: 14, bottom: 14 },
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                tabSize: 2,
                wordWrap: 'on',
              }}
            />
          </div>
        )}
        <footer className="file-editor-footer">
          <span>{previewingMarkdown ? 'Markdown 预览' : 'Ctrl/⌘ + S 保存'}</span>
          <span>{dirty ? '有未保存更改' : '内容已同步'}</span>
        </footer>
      </aside>
    </div>,
    document.body,
  )
}
