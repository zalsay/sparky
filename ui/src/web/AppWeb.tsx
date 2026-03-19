import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Menu, Switch, Tag } from 'antd';
import { DesktopOutlined, EyeOutlined, MoonOutlined, ProjectOutlined, SunOutlined } from '@ant-design/icons';

import logo from '../../../logo.png';
import codeIcon from '../assets/Code.svg';
import { WebApiError } from '../services/webApi';
import WebApiKeyModal from './components/WebApiKeyModal';
import { useProjectEvents } from './hooks/useProjectEvents';
import { useProjectDetailRoute } from './hooks/useProjectDetailRoute';
import { useProjectIde } from './hooks/useProjectIde';
import { useWebApiKey } from './hooks/useWebApiKey';
import { useWebIdeEvents } from './hooks/useWebIdeEvents';
import {
  createProject,
  deleteProject,
  fetchProjectDetailWeb,
  fetchProjects,
} from './features/projects/services/projectService';
import ProjectDetailPage from './features/projects/pages/ProjectDetailPage';
import ProjectListPage from './features/projects/pages/ProjectListPage';
import WebIdePage from './features/web-ide/pages/WebIdePage';
import type { Project } from './types';

interface AppWebProps {
  isDarkMode: boolean;
  setIsDarkMode: (value: boolean) => void;
}

export default function AppWeb({ isDarkMode, setIsDarkMode }: AppWebProps) {
  const { message: messageApi, modal: modalApi } = AntApp.useApp();
  const [activeMenu, setActiveMenu] = useState<string>('project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeProjects, setActiveProjects] = useState<string[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [pendingProjectName, setPendingProjectName] = useState('');
  const [pendingProjectPath, setPendingProjectPath] = useState('');

  const {
    webApiKey,
    webApiKeyModalOpen,
    webApiKeyInput,
    webApiKeyMissing,
    setWebApiKeyInput,
    setWebApiKeyModalOpen,
    getWebApiKey,
    handleWebApiError,
    handleSaveWebApiKey,
  } = useWebApiKey({
    onSaved: () => {
      void loadProjects();
      const match = window.location.pathname.match(/^\/project\/(\d+)\/detail$/);
      if (match) {
        const projectId = Number(match[1]);
        if (Number.isFinite(projectId)) {
          void handleEnterProjectById(projectId);
        }
      }
    },
  });


  const handleWebRequestError = useCallback((error: unknown) => {
    if (error instanceof WebApiError) {
      handleWebApiError(error.status);
      return;
    }
    console.error('Web API request failed:', error);
  }, [handleWebApiError]);

  const loadProjects = useCallback(async () => {
    setProjectsLoaded(false);
    try {
      const apiKey = getWebApiKey();
      if (!apiKey) {
        setProjects([]);
        return;
      }
      const data = await fetchProjects(apiKey);
      setProjects(data || []);
    } catch (error) {
      handleWebRequestError(error);
      setProjects([]);
    } finally {
      setProjectsLoaded(true);
    }
  }, [getWebApiKey, handleWebRequestError]);

  const handleEnterProjectById = useCallback(async (projectId: number) => {
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      const data = await fetchProjectDetailWeb(apiKey, projectId);
      const project = data?.project;
      if (!project) return;
      setSelectedProject(project);
      setActiveMenu('project-detail');
      setActiveProjects((prev) => (prev.includes(project.path) ? prev : [...prev, project.path]));
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [getWebApiKey, handleWebRequestError]);

  const { webIdeProjects, refreshWebIdeSummary } = useWebIdeEvents({
    active: activeMenu === 'web-ide',
    getWebApiKey,
    handleWebRequestError,
  });

  const handleLeaveProjectDetail = useCallback(() => {
    setActiveMenu('project');
    setSelectedProject(null);
  }, []);

  const { openProjectDetailRoute, goProjectListRoute } = useProjectDetailRoute({
    onEnterProjectById: handleEnterProjectById,
    onLeaveProjectDetail: handleLeaveProjectDetail,
  });

  const projectEvents = useProjectEvents({
    active: activeMenu === 'project-detail',
    project: selectedProject,
    getWebApiKey,
    handleWebRequestError,
  });

  const projectIde = useProjectIde({
    project: selectedProject,
  });

  useEffect(() => {
    if (!webApiKey) return;
    void loadProjects();
  }, [webApiKey, loadProjects]);

  const handleEnterProject = useCallback(async (project: Project) => {
    openProjectDetailRoute(project.id);
    await handleEnterProjectById(project.id);
  }, [handleEnterProjectById, openProjectDetailRoute]);

  const handleAddProject = useCallback(() => {
    modalApi.confirm({
      title: '添加项目',
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>请输入项目名称和服务器可访问的项目路径。</div>
          <input className="ant-input" placeholder="项目名称" value={pendingProjectName} onChange={(e) => setPendingProjectName(e.target.value)} />
          <input className="ant-input" placeholder="项目路径，例如 /workspace/my-project" value={pendingProjectPath} onChange={(e) => setPendingProjectPath(e.target.value)} />
        </div>
      ),
      okText: '创建',
      cancelText: '取消',
      onOk: async () => {
        const name = pendingProjectName.trim();
        const path = pendingProjectPath.trim();
        if (!name || !path) {
          messageApi.warning('请填写项目名称和路径');
          throw new Error('INVALID_PROJECT_INPUT');
        }
        const apiKey = getWebApiKey();
        if (!apiKey) throw new Error('MISSING_WEB_ACCESS_TOKEN');
        try {
          const newProject = await createProject(apiKey, { name, path });
          setProjects((prev) => [...prev, newProject]);
          setPendingProjectName('');
          setPendingProjectPath('');
          messageApi.success(`项目 "${name}" 添加成功`);
        } catch (error) {
          handleWebRequestError(error);
          messageApi.error(`添加项目失败: ${error}`);
          throw error;
        }
      },
      onCancel: () => {
        setPendingProjectName('');
        setPendingProjectPath('');
      },
    });
  }, [getWebApiKey, handleWebRequestError, messageApi, modalApi, pendingProjectName, pendingProjectPath]);

  const handleDeleteProject = useCallback((id: number) => {
    modalApi.confirm({
      title: '确认删除',
      content: '确定要删除这个项目吗？',
      onOk: async () => {
        const apiKey = getWebApiKey();
        if (!apiKey) return;
        try {
          await deleteProject(apiKey, id);
          setProjects((prev) => prev.filter((p) => p.id !== id));
          if (selectedProject?.id === id) {
            goProjectListRoute();
            handleLeaveProjectDetail();
          }
          messageApi.success('删除成功');
        } catch (error) {
          handleWebRequestError(error);
          messageApi.error(`删除项目失败: ${error}`);
        }
      },
    });
  }, [getWebApiKey, goProjectListRoute, handleLeaveProjectDetail, handleWebRequestError, messageApi, modalApi, selectedProject]);

  return (
    <>
      <div className={`app-container ${isDarkMode ? 'dark-mode' : ''}`}>
        <header className="app-header">
          <div className="header-content" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="logo">
                <button type="button" className="logo-home-button" onClick={() => {
                  handleLeaveProjectDetail();
                  goProjectListRoute();
                }}>
                  <img src={logo} alt="logo" className="logo-img" />
                  <h1>Sparky</h1>
                </button>
                {activeProjects.length > 0 && (
                  <div className="header-active-projects-inline">
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginRight: 6, fontWeight: 500 }}>运行中:</span>
                    {activeProjects.map((path) => {
                      const name = path.split('/').pop() || path;
                      const isActive = selectedProject?.path === path;
                      return (
                        <Tag
                          key={path}
                          className={isActive ? 'active-project-tag' : 'inactive-project-tag'}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            const proj = projects.find((p) => p.path === path);
                            if (proj) {
                              void handleEnterProject(proj);
                              messageApi.success(`已切换至 ${proj.name} 项目`);
                            }
                          }}
                        >
                          {name}
                        </Tag>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              {activeMenu === 'project-detail' && (
                <div className="ide-status-wrapper connected">
                  <div className="ide-status-capsule connected">
                    <img src={codeIcon} alt="IDE" className="ide-capsule-icon" />
                    <span className="ide-capsule-label">Web 模式</span>
                    <span className="ide-capsule-dot" />
                  </div>
                </div>
              )}
              <Switch
                className="theme-switch"
                checked={isDarkMode}
                onChange={(checked) => setIsDarkMode(checked)}
                checkedChildren={<MoonOutlined />}
                unCheckedChildren={<SunOutlined />}
              />
            </div>
          </div>
        </header>

        <main className="app-main" style={activeMenu === 'project-detail' ? { padding: 0 } : undefined}>
          <div className="app-layout" style={activeMenu === 'project-detail' ? { gap: 0 } : undefined}>
            <aside className="app-sidebar" style={{ display: activeMenu === 'project-detail' ? 'none' : undefined }}>
              <Menu
                mode="inline"
                selectedKeys={[activeMenu]}
                onClick={(e) => setActiveMenu(e.key)}
                style={{ height: '100%', borderRight: 0 }}
                items={[
                  { key: 'project', icon: <ProjectOutlined />, label: '项目' },
                  { key: 'web-ide', icon: <DesktopOutlined />, label: 'WebIDE' },
                  { key: 'help', icon: <EyeOutlined />, label: '帮助' },
                ]}
              />
            </aside>

            <div className="app-content">
              {activeMenu === 'project' && (
                <ProjectListPage
                  projects={projects}
                  projectsLoaded={projectsLoaded}
                  onAddProject={handleAddProject}
                  onEnterProject={handleEnterProject}
                  onDeleteProject={handleDeleteProject}
                />
              )}

              {activeMenu === 'web-ide' && (
                <WebIdePage projects={webIdeProjects} onRefresh={refreshWebIdeSummary} />
              )}

              {activeMenu === 'project-detail' && selectedProject && (
                <ProjectDetailPage
                  project={selectedProject}
                  terminalId={projectEvents.terminalId}
                  historyLines={projectEvents.historyLines}
                  terminalReady={projectEvents.terminalStateReady}
                  terminalStatus={projectEvents.terminalStatus}
                  sessions={projectEvents.sessions}
                  sessionModalOpen={projectEvents.sessionModalOpen}
                  editingSessionId={projectEvents.editingSessionId}
                  editingSessionName={projectEvents.editingSessionName}
                  fullAuth={projectEvents.fullAuth}
                  splitterSizes={projectIde.splitterSizes}
                  ideTabs={projectIde.ideTabs}
                  activeIdeTabId={projectIde.activeIdeTabId}
                  newTabModalOpen={projectIde.newTabModalOpen}
                  newTabUrl={projectIde.newTabUrl}
                  recentUrlsForProject={projectIde.recentUrlsForProject}
                  onBack={() => {
                    handleLeaveProjectDetail();
                    goProjectListRoute();
                  }}
                  onToggleFullAuth={projectEvents.toggleFullAuth}
                  onStartSession={projectEvents.startClaudeSession}
                  onOpenSessionModal={projectEvents.openSessionModal}
                  onCloseSessionModal={projectEvents.closeSessionModal}
                  onResumeSession={projectEvents.resumeClaudeSession}
                  onUpdateSessionName={projectEvents.updateSessionName}
                  onDeleteSession={projectEvents.removeSession}
                  onEditingSessionIdChange={projectEvents.setEditingSessionId}
                  onEditingSessionNameChange={projectEvents.setEditingSessionName}
                  onSplitterResize={projectIde.updateSplitterSizes}
                  onActiveIdeTabChange={projectIde.setActiveIdeTabId}
                  onOpenNewTabModal={projectIde.openNewTabModal}
                  onCloseNewTabModal={projectIde.closeNewTabModal}
                  onNewTabUrlChange={projectIde.setNewTabUrl}
                  onCreateIdeTab={projectIde.createIdeTabFromUrl}
                  onRemoveIdeTab={projectIde.removeIdeTab}
                  onReloadIdeTab={projectIde.reloadIdeTab}
                  onIdeTabLoadErrorChange={projectIde.setTabLoadError}
                />
              )}

              {activeMenu === 'help' && (
                <div className="project-page">
                  <div className="projects-card app-card" style={{ padding: 24 }}>
                    <div style={{ color: 'var(--text-secondary)' }}>Web 版已改为通过服务器接口访问。请先输入服务端签发的 Bearer Token，再使用项目、会话、终端与 WebIDE 功能。默认 API 地址为 https://i.meetlife.com.cn:3010，也可通过 VITE_WEB_API_BASE_URL 覆盖。</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      <WebApiKeyModal
        open={webApiKeyModalOpen}
        value={webApiKeyInput}
        missing={webApiKeyMissing}
        onChange={setWebApiKeyInput}
        onCancel={() => setWebApiKeyModalOpen(false)}
        onOk={handleSaveWebApiKey}
      />
    </>
  );
}
