import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Menu, Switch, Tag, Typography } from 'antd';
import { DesktopOutlined, EyeOutlined, LogoutOutlined, MoonOutlined, ProjectOutlined, SunOutlined, UserOutlined } from '@ant-design/icons';

import logo from '../../../logo.png';
import codeIcon from '../assets/Code.svg';
import { WebApiError } from '../services/webApi';
import { useAuth } from '../features/auth';
import { useProjectEvents } from './hooks/useProjectEvents';
import { useProjectDetailRoute } from './hooks/useProjectDetailRoute';
import { useProjectIde } from './hooks/useProjectIde';
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

function mergeProject(base: Project | undefined | null, next: Project | undefined | null): Project | null {
  if (!base && !next) {
    return null;
  }

  return {
    ...(base || {}),
    ...(next || {}),
    id: next?.id ?? base?.id ?? 0,
    name: next?.name ?? base?.name ?? '',
    path: next?.path || base?.path || '',
    hooks_enabled: next?.hooks_enabled ?? next?.hooks_installed ?? base?.hooks_enabled ?? base?.hooks_installed ?? false,
    hooks_installed: next?.hooks_installed ?? next?.hooks_enabled ?? base?.hooks_installed ?? base?.hooks_enabled ?? false,
    members: next?.members ?? base?.members,
    description: next?.description ?? base?.description ?? null,
    created_at: next?.created_at ?? base?.created_at ?? null,
  };
}

export default function AppWeb({ isDarkMode, setIsDarkMode }: AppWebProps) {
  const { message: messageApi, modal: modalApi } = AntApp.useApp();
  const { user, logout } = useAuth();
  const [activeMenu, setActiveMenu] = useState<string>('project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [activeProjects, setActiveProjects] = useState<string[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [pendingProjectName, setPendingProjectName] = useState('');
  const [pendingProjectPath, setPendingProjectPath] = useState('');

  const handleWebRequestError = useCallback((error: unknown) => {
    if (error instanceof WebApiError) {
      if (error.status === 401) {
        return;
      }
      messageApi.error(error.message || '请求失败');
      return;
    }
    console.error('Web API request failed:', error);
    messageApi.error(error instanceof Error ? error.message : '请求失败');
  }, [messageApi]);

  const loadProjects = useCallback(async () => {
    setProjectsLoaded(false);
    try {
      const data = await fetchProjects();
      setProjects(data || []);
    } catch (error) {
      handleWebRequestError(error);
      setProjects([]);
    } finally {
      setProjectsLoaded(true);
    }
  }, [handleWebRequestError]);

  const handleLeaveProjectDetail = useCallback(() => {
    setActiveMenu('project');
    setSelectedProject(null);
  }, []);

  const handleEnterProjectById = useCallback(async (projectId: number) => {
    try {
      const data = await fetchProjectDetailWeb(projectId);
      const projectFromList = projects.find((item) => item.id === projectId);
      const project = mergeProject(projectFromList, data?.project);
      if (!project) {
        messageApi.warning('项目不存在或暂无访问权限');
        return;
      }
      setSelectedProject(project);
      setActiveMenu('project-detail');
      if (project.path) {
        setActiveProjects((prev) => (prev.includes(project.path) ? prev : [...prev, project.path]));
      }
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [handleWebRequestError, messageApi, projects]);

  const { openProjectDetailRoute, goProjectListRoute } = useProjectDetailRoute({
    isAuthenticated: true,
    onEnterProjectById: handleEnterProjectById,
    onLeaveProjectDetail: handleLeaveProjectDetail,
  });

  const { webIdeProjects, activeInstances, refreshWebIdeSummary } = useWebIdeEvents({
    active: activeMenu === 'web-ide',
    handleWebRequestError,
  });

  const projectEvents = useProjectEvents({
    active: activeMenu === 'project-detail',
    project: selectedProject,
    handleWebRequestError,
  });

  const projectIde = useProjectIde({
    project: selectedProject,
  });

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    const nextProject = projects.find((item) => item.id === selectedProject.id);
    if (!nextProject) {
      return;
    }
    setSelectedProject((prev) => mergeProject(prev, nextProject));
  }, [projects, selectedProject]);

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
        try {
          const newProject = await createProject({ name, path });
          setProjects((prev) => [...prev, newProject]);
          setPendingProjectName('');
          setPendingProjectPath('');
          messageApi.success(`项目 "${name}" 添加成功`);
        } catch (error) {
          handleWebRequestError(error);
          throw error;
        }
      },
      onCancel: () => {
        setPendingProjectName('');
        setPendingProjectPath('');
      },
    });
  }, [handleWebRequestError, messageApi, modalApi, pendingProjectName, pendingProjectPath]);

  const handleDeleteProject = useCallback((id: number) => {
    modalApi.confirm({
      title: '确认删除',
      content: '确定要删除这个项目吗？',
      onOk: async () => {
        try {
          await deleteProject(id);
          setProjects((prev) => prev.filter((project) => project.id !== id));
          if (selectedProject?.id === id) {
            goProjectListRoute();
            handleLeaveProjectDetail();
          }
          messageApi.success('删除成功');
        } catch (error) {
          handleWebRequestError(error);
        }
      },
    });
  }, [goProjectListRoute, handleLeaveProjectDetail, handleWebRequestError, messageApi, modalApi, selectedProject]);

  const displayName = useMemo(() => user?.display_name || user?.username || '已登录用户', [user]);

  return (
    <div className={`app-container ${isDarkMode ? 'dark-mode' : ''}`}>
      <header className="app-header">
        <div className="header-content" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="logo">
              <button
                type="button"
                className="logo-home-button"
                onClick={() => {
                  handleLeaveProjectDetail();
                  goProjectListRoute();
                }}
              >
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
                          const project = projects.find((item) => item.path === path);
                          if (project) {
                            void handleEnterProject(project);
                            messageApi.success(`已切换至 ${project.name} 项目`);
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {activeMenu === 'project-detail' && (
              <div className="ide-status-wrapper connected">
                <div className="ide-status-capsule connected">
                  <img src={codeIcon} alt="IDE" className="ide-capsule-icon" />
                  <span className="ide-capsule-label">Web 模式</span>
                  <span className="ide-capsule-dot" />
                </div>
              </div>
            )}
            <Tag icon={<UserOutlined />} style={{ margin: 0 }}>
              {displayName}
            </Tag>
            <Button size="small" icon={<LogoutOutlined />} onClick={() => void logout()}>
              退出登录
            </Button>
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
              onClick={(event) => {
                if (event.key === 'project') {
                  goProjectListRoute();
                  handleLeaveProjectDetail();
                }
                setActiveMenu(event.key);
              }}
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
              <WebIdePage projects={webIdeProjects} activeInstances={activeInstances} onRefresh={refreshWebIdeSummary} />
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
                  <Typography.Paragraph style={{ marginBottom: 12 }}>
                    Web 版已切换为统一账号登录。登录后会自动读取本地会话、校验 `GET /api/me`，并在 access token 过期时尝试 refresh。
                  </Typography.Paragraph>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                    当前项目、会话、终端与 WebIDE 请求统一走服务端 `/api/*` 接口，认证头只发送 `Authorization: Bearer &lt;access_token&gt;`。
                  </Typography.Paragraph>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
