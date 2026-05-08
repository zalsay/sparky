import { CodexPanel } from './CodexPanel'
import { FilePanel } from './FilePanel'
import { GitPanel } from './GitPanel'
import { SidePanelTabs } from './SidePanelTabs'
import { WebDebugPanel } from './WebDebugPanel'

export function WorkspaceSidePanel({
  codexPanelProps,
  filePanelProps,
  gitPanelProps,
  isMobile,
  mobileActionProps,
  onCloseMobilePanel,
  onSelectTab,
  repoSelectorProps,
  selectedProject,
  sidePanelTab,
  webDebugPanelProps,
}) {
  const showRepoSelector = sidePanelTab !== 'codex' && repoSelectorProps?.enabled
  const autoRepoLabel = repoSelectorProps?.resolvedRepoPath
    ? `自动选择默认仓库（当前：${repoSelectorProps.resolvedRepoPath}）`
    : '自动选择默认仓库'

  return (
    <aside className={`git-panel glass-panel workspace-side-panel ${isMobile ? 'workspace-side-panel-mobile' : ''}`}>
      {isMobile ? (
        <div className="workspace-side-panel-mobile__header">
          <div>
            <span className="eyebrow">工作区面板</span>
            <strong className="workspace-side-panel-mobile__title">{selectedProject?.name || '项目面板'}</strong>
          </div>
          <button
            type="button"
            className="toolbar-btn toolbar-btn-icon"
            aria-label="关闭右侧面板"
            onClick={onCloseMobilePanel}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M6 6l8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}
      {isMobile ? (
        <div className="workspace-side-panel-mobile__actions">
          {mobileActionProps?.canResumeCodex ? (
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => {
                mobileActionProps.onResumeCodexSession()
                onCloseMobilePanel?.()
              }}
              disabled={mobileActionProps.codexLoading || mobileActionProps.codexResumeLoading !== ''}
            >
              {mobileActionProps.codexResumeLoading === '__latest__' ? '恢复中' : '恢复最近会话'}
            </button>
          ) : null}
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => {
              mobileActionProps?.onOpenPrimarySession?.()
              onCloseMobilePanel?.()
            }}
            disabled={!selectedProject?.id || mobileActionProps?.step === 'connecting'}
          >
            新开主会话
          </button>
        </div>
      ) : null}
      <SidePanelTabs
        isCodexProject={selectedProject?.runtime === 'codex'}
        onSelectTab={onSelectTab}
        sidePanelTab={sidePanelTab}
      />

      {showRepoSelector ? (
        <div className="side-panel-repo-selector">
          <div className="panel-heading side-panel-repo-selector__heading">
            <span className="panel-heading-title">仓库范围</span>
            <span className="panel-heading-subtitle">为 Web 开发、文件和 Git 面板切换目标仓库</span>
          </div>
          <div className="field-select-shell">
            <select
              className="field-input field-select field-select-mono"
              value={repoSelectorProps.selectedRepoPath || ''}
              onChange={(event) => repoSelectorProps.onSelectRepoPath?.(event.target.value)}
              disabled={repoSelectorProps.repoLoading || !repoSelectorProps.selectedProjectId}
            >
              <option value="">{autoRepoLabel}</option>
              {repoSelectorProps.repoOptions.map((repo) => (
                <option key={repo.path} value={repo.path}>
                  {repo.label}
                </option>
              ))}
            </select>
            <span className="field-select-shell__icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none">
                <path
                  d="M5 7.5l5 5 5-5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </div>
          {repoSelectorProps.repoLoading ? (
            <p className="side-panel-repo-selector__hint">正在扫描项目里的 Git 仓库...</p>
          ) : repoSelectorProps.repoError ? (
            <p className="side-panel-repo-selector__hint side-panel-repo-selector__hint-error">{repoSelectorProps.repoError}</p>
          ) : (
            <p className="side-panel-repo-selector__hint">切换后会同步刷新当前面板数据，并把操作落到选中的仓库根目录。</p>
          )}
        </div>
      ) : null}

      {sidePanelTab === 'codex' && selectedProject?.runtime === 'codex' ? (
        <CodexPanel {...codexPanelProps} />
      ) : sidePanelTab === 'web' ? (
        <WebDebugPanel {...webDebugPanelProps} />
      ) : sidePanelTab === 'files' ? (
        <FilePanel {...filePanelProps} />
      ) : (
        <GitPanel {...gitPanelProps} />
      )}
    </aside>
  )
}
