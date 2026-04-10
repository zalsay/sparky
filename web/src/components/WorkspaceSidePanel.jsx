import { CodexPanel } from './CodexPanel'
import { FilePanel } from './FilePanel'
import { GitPanel } from './GitPanel'
import { SidePanelTabs } from './SidePanelTabs'
import { WebDebugPanel } from './WebDebugPanel'

export function WorkspaceSidePanel({
  codexPanelProps,
  filePanelProps,
  gitPanelProps,
  onSelectTab,
  selectedProject,
  sidePanelTab,
  webDebugPanelProps,
}) {
  return (
    <aside className="git-panel glass-panel">
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
