import '@xterm/xterm/css/xterm.css'
import { useAuthController } from './app/hooks/useAuthController'
import { useWorkspaceController } from './app/hooks/useWorkspaceController'
import { AuthLoadingPage } from './components/AuthLoadingPage'
import { AuthPage } from './components/AuthPage'
import { DashboardModals } from './components/DashboardModals'
import { DashboardPage } from './components/DashboardPage'
import { WorkspacePage } from './components/WorkspacePage'
import './App.css'

function App() {
  const auth = useAuthController()
  const workspace = useWorkspaceController({
    auth: auth.auth,
    authHeaders: auth.authHeaders,
    clearAuth: auth.clearAuth,
    setLoginError: auth.setLoginError,
  })

  if (!auth.authReady) {
    return <AuthLoadingPage />
  }

  if (!auth.auth) {
    return (
      <AuthPage
        authMode={auth.authMode}
        authModeCopy={auth.authModeCopy}
        loginError={auth.loginError}
        loggingIn={auth.loggingIn}
        loginName={auth.loginName}
        loginPassword={auth.loginPassword}
        onLoginNameChange={auth.setLoginName}
        onLoginPasswordChange={auth.setLoginPassword}
        onSubmit={auth.submitAuth}
        onSwitchAuthMode={auth.switchAuthMode}
      />
    )
  }

  if (workspace.step === 'select') {
    return (
      <>
        <DashboardPage
          activeSessionCount={workspace.activeSessionCount}
          auth={auth.auth}
          codexSessionTitlesByPtySessionId={workspace.codexSessionTitlesByPtySessionId}
          loadingProjects={workspace.loadingProjects}
          onActivatePersistentSession={workspace.activatePersistentSession}
          onLoadCodexSessionTitles={workspace.loadCodexSessionTitlesForProject}
          onLoadWorkspaceState={workspace.loadWorkspaceState}
          onLogout={workspace.logout}
          onOpenCreateProjectForm={workspace.openCreateProjectForm}
          onOpenEditProjectForm={workspace.openEditProjectForm}
          onRequestDeleteProject={workspace.requestDeleteProject}
          onSelectProject={workspace.selectProject}
          orderedProjects={workspace.orderedProjects}
          preferredProjectId={workspace.preferredProjectId}
          projectError={workspace.projectError}
          sessionByProjectId={workspace.sessionByProjectId}
          sessionCountByProjectId={workspace.sessionCountByProjectId}
          sessions={workspace.sessions}
          temporarySessionCountByProjectId={workspace.temporarySessionCountByProjectId}
          totalProjects={workspace.totalProjects}
        />

        <DashboardModals
          createProjectError={workspace.createProjectError}
          createProjectOpen={workspace.createProjectOpen}
          creatingProject={workspace.creatingProject}
          deleteProjectError={workspace.deleteProjectError}
          deleteProjectTarget={workspace.deleteProjectTarget}
          deletingProject={workspace.deletingProject}
          isEditingProject={workspace.isEditingProject}
          newProjectGitUrl={workspace.newProjectGitUrl}
          newProjectName={workspace.newProjectName}
          newProjectPath={workspace.newProjectPath}
          newProjectRuntime={workspace.newProjectRuntime}
          onCloseCreateProject={workspace.resetCreateProjectForm}
          onCloseDeleteProject={workspace.resetDeleteProjectState}
          onDeleteProject={workspace.submitDeleteProject}
          onProjectGitUrlChange={workspace.setNewProjectGitUrl}
          onProjectNameChange={workspace.setNewProjectName}
          onProjectPathChange={workspace.onProjectPathInputChange}
          onProjectRepoPathChange={workspace.onProjectRepoPathChange}
          onProjectRuntimeChange={workspace.setNewProjectRuntime}
          projectRepoLoading={workspace.projectRepoLoading}
          projectRepoOptions={workspace.projectRepoOptions}
          selectedProjectRepoPath={workspace.selectedProjectRepoPath}
          onSubmitCreateProject={workspace.submitCreateProject}
        />
      </>
    )
  }

  return (
    <WorkspacePage
      codexLoading={workspace.panels.codexLoading}
      codexResumeLoading={workspace.panels.codexResumeLoading}
      connected={workspace.connected}
      onLeaveSessionView={workspace.leaveSessionView}
      onOpenPrimarySession={workspace.openPrimarySession}
      onResetSidebarWidth={workspace.resetSidebarWidth}
      onResumeCodexSession={workspace.resumeCodexSession}
      selectedProject={workspace.selectedProject}
      sidePanelProps={workspace.sidePanelProps}
      sidebarResizing={workspace.panels.sidebarResizing}
      sessionCloseModalProps={workspace.sessionCloseModalProps}
      startSidebarResize={workspace.panels.startSidebarResize}
      step={workspace.step}
      terminalPanelProps={workspace.terminalPanelProps}
      workspaceShellRef={workspace.workspaceShellRef}
      workspaceShellStyle={workspace.panels.workspaceShellStyle}
    />
  )
}

export default App
