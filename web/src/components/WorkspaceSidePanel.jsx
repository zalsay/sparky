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
  selectedProject,
  sidePanelTab,
  webDebugPanelProps,
}) {
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
