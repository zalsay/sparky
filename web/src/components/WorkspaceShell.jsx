import { TerminalPanel } from './TerminalPanel'
import { WorkspaceSidePanel } from './WorkspaceSidePanel'

export function WorkspaceShell({
  isMobileViewport,
  mobileSidePanelOpen,
  onCloseMobileSidePanel,
  onResetSidebarWidth,
  onStartSidebarResize,
  sidebarResizing,
  sidePanelProps,
  terminalPanelProps,
  workspaceShellRef,
  workspaceShellStyle,
}) {
  if (isMobileViewport) {
    return (
      <main
        ref={workspaceShellRef}
        className="workspace-shell workspace-shell-mobile"
        style={workspaceShellStyle}
      >
        <TerminalPanel {...terminalPanelProps} />

        {mobileSidePanelOpen ? (
          <div className="workspace-mobile-panel-drawer">
            <WorkspaceSidePanel
              {...sidePanelProps}
              isMobile
              onCloseMobilePanel={onCloseMobileSidePanel}
            />
          </div>
        ) : null}
      </main>
    )
  }

  return (
    <main
      ref={workspaceShellRef}
      className={`workspace-shell workspace-shell-resizable ${sidebarResizing ? 'is-resizing' : ''}`}
      style={workspaceShellStyle}
    >
      <TerminalPanel {...terminalPanelProps} />

      <div
        className={`workspace-resizer ${sidebarResizing ? 'active' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左右栏宽度"
        onPointerDown={onStartSidebarResize}
        onDoubleClick={onResetSidebarWidth || (() => {})}
      >
        <span className="workspace-resizer-handle" />
      </div>

      <WorkspaceSidePanel {...sidePanelProps} />
    </main>
  )
}
