import { SessionCloseModal } from './SessionCloseModal'
import { DEFAULT_SIDEBAR_WIDTH } from '../app/constants'
import { WorkspaceShell } from './WorkspaceShell'
import { WorkspaceTopbar } from './WorkspaceTopbar'

export function WorkspacePage({
  codexLoading,
  codexResumeLoading,
  connected,
  onLeaveSessionView,
  onOpenPrimarySession,
  onResetSidebarWidth,
  onResumeCodexSession,
  selectedProject,
  sidePanelProps,
  sidebarResizing,
  startSidebarResize,
  step,
  sessionCloseModalProps,
  terminalPanelProps,
  workspaceShellRef,
  workspaceShellStyle,
}) {
  return (
    <div className="app workspace-page">
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
      <WorkspaceTopbar
        codexLoading={codexLoading}
        codexResumeLoading={codexResumeLoading}
        connected={connected}
        onLeaveSessionView={onLeaveSessionView}
        onOpenPrimarySession={onOpenPrimarySession}
        onResumeCodexSession={onResumeCodexSession}
        selectedProject={selectedProject}
        step={step}
      />

      <WorkspaceShell
        onResetSidebarWidth={onResetSidebarWidth || (() => DEFAULT_SIDEBAR_WIDTH)}
        onStartSidebarResize={startSidebarResize}
        sidebarResizing={sidebarResizing}
        sidePanelProps={sidePanelProps}
        terminalPanelProps={terminalPanelProps}
        workspaceShellRef={workspaceShellRef}
        workspaceShellStyle={workspaceShellStyle}
      />
      <SessionCloseModal {...sessionCloseModalProps} />
    </div>
  )
}
