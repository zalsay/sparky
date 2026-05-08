import { DeleteProjectModal } from './DeleteProjectModal'
import { ProjectFormModal } from './ProjectFormModal'

export function DashboardModals({
  createProjectError,
  createProjectOpen,
  creatingProject,
  deleteProjectError,
  deleteProjectTarget,
  deletingProject,
  isEditingProject,
  newProjectGitUrl,
  newProjectName,
  newProjectPath,
  newProjectRuntime,
  onProjectRepoPathChange,
  onCloseCreateProject,
  onCloseDeleteProject,
  onDeleteProject,
  onProjectGitUrlChange,
  onProjectNameChange,
  onProjectPathChange,
  onProjectRuntimeChange,
  projectRepoLoading,
  projectRepoOptions,
  selectedProjectRepoPath,
  onSubmitCreateProject,
}) {
  return (
    <>
      {createProjectOpen ? (
        <ProjectFormModal
          createProjectError={createProjectError}
          creatingProject={creatingProject}
          isEditingProject={isEditingProject}
          newProjectGitUrl={newProjectGitUrl}
          newProjectName={newProjectName}
          newProjectPath={newProjectPath}
          newProjectRuntime={newProjectRuntime}
          onClose={onCloseCreateProject}
          onProjectGitUrlChange={onProjectGitUrlChange}
          onProjectNameChange={onProjectNameChange}
          onProjectPathChange={onProjectPathChange}
          onProjectRepoPathChange={onProjectRepoPathChange}
          onProjectRuntimeChange={onProjectRuntimeChange}
          projectRepoLoading={projectRepoLoading}
          projectRepoOptions={projectRepoOptions}
          selectedProjectRepoPath={selectedProjectRepoPath}
          onSubmit={onSubmitCreateProject}
        />
      ) : null}

      {deleteProjectTarget ? (
        <DeleteProjectModal
          deleteProjectError={deleteProjectError}
          deleteProjectTarget={deleteProjectTarget}
          deletingProject={deletingProject}
          onClose={onCloseDeleteProject}
          onSubmit={onDeleteProject}
        />
      ) : null}
    </>
  )
}
