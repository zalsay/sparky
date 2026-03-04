import { useState, useEffect, useRef } from 'react';
import { Form, Input, Button, Card, Divider, Tag, Table, Empty, Modal, Space, Menu, Tabs, Checkbox, ConfigProvider, theme, Switch, App as AntApp, Typography, Tooltip, ColorPicker, Slider, Dropdown } from 'antd';
import { SaveOutlined, ApiOutlined, SettingOutlined, DeleteOutlined, EyeOutlined, FolderOutlined, ArrowLeftOutlined, SunOutlined, MoonOutlined, PlusOutlined, ProjectOutlined, FullscreenOutlined, FullscreenExitOutlined, RightOutlined, PoweroffOutlined, MenuFoldOutlined, MenuUnfoldOutlined, InfoCircleOutlined, CopyOutlined, ReloadOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, ExperimentOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, ThunderboltOutlined, CheckOutlined, CloseOutlined, ArrowDownOutlined, MenuOutlined, WarningOutlined } from '@ant-design/icons';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

import TerminalComponent from './components/Terminal';
import logo from '../../logo.png';
import codeIcon from './assets/Code.svg';
import claudeIcon from './assets/Claude.svg';
import claudeDeactiveIcon from './assets/claude-deactive.svg';
import './App.css';

interface AppConfig {
  app_id: string;
  app_secret: string;
  app_name?: string;
  encrypt_key?: string;
  verification_token?: string;
  chat_id?: string;
  project_path?: string;
  open_id?: string;
  hook_events_filter?: string;
  anthropic_logo_img_key?: string;
  terminal_bg_color?: string;
  terminal_fg_color?: string;
  terminal_font_size?: number;
}

interface Project {
  id: number;
  name: string;
  path: string;
  hooks_installed: boolean;
  agent_teams_enabled?: boolean;
}

interface HookRecord {
  id: number;
  event_name: string;
  session_id: string;
  notification_text: string;
  transcript_path: string;
  content: string;
  result: string;
  created_at: number;
}

interface HookRecordsResponse {
  records: HookRecord[];
  total: number;
  page: number;
  page_size: number;
}

interface SessionInfo {
  id: number;
  session_id: string;
  project_path: string;
  started_at: number;
  ended_at: number | null;
  reason: string | null;
  name: string | null;
  project_name: string | null;
}

function AppContent({ isDarkMode, setIsDarkMode }: { isDarkMode: boolean, setIsDarkMode: (v: boolean) => void }) {
  const { message: messageApi, modal: modalApi } = AntApp.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string>('project');
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [showCoderIde, setShowCoderIde] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<Record<string, string[]>>({});

  interface TerminalTab {
    id: string;
    title: string | React.ReactNode;
  }
  const [projectTerminals, setProjectTerminals] = useState<Record<string, TerminalTab[]>>({});
  const [activeTerminalId, setActiveTerminalId] = useState<Record<string, string>>({});
  const [externalFileTabs, setExternalFileTabs] = useState<{ path: string, folderPath: string }[]>([]);
  const [showDetailTab, setShowDetailTab] = useState<Record<string, boolean>>({});

  const [hookRecords, setHookRecords] = useState<HookRecord[]>([]);
  const [hookRecordsTotal, setHookRecordsTotal] = useState(0);
  const [hookRecordsPage, setHookRecordsPage] = useState(1);
  const [hookRecordsLoading, setHookRecordsLoading] = useState(false);
  const [hookRecordSelection, setHookRecordSelection] = useState<number[]>([]);
  const [hookDetailOpen, setHookDetailOpen] = useState(false);
  const [hookDetailRecord, setHookDetailRecord] = useState<HookRecord | null>(null);

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');

  // Watch color picker fields to dynamically display color tags
  const watchedBgColor = Form.useWatch('terminal_bg_color', form);
  const watchedFgColor = Form.useWatch('terminal_fg_color', form);
  const watchedFontSize = Form.useWatch('terminal_font_size', form);

  const tauriAvailable = isTauri();
  const terminalRefs = useRef<Record<string, { scrollToBottom: () => void }>>({});
  const inputBufferRef = useRef<Record<string, string>>({});
  const [lastCommand, setLastCommand] = useState<Record<string, string>>({});
  const [wsConnected, setWsConnected] = useState(false);
  const [activeProjects, setActiveProjects] = useState<string[]>([]);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('sparky-sidebar-collapsed');
    return saved === 'true';
  });

  // Session management state
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [fullAuth, setFullAuth] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('sparky-full-auth');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // Testing state
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [curlCommand, setCurlCommand] = useState('curl -s https://httpbin.org/get');
  const [curlResult, setCurlResult] = useState('');
  const [curlLoading, setCurlLoading] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<{ installed: boolean; running: boolean; path: string } | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpStarting, setMcpStarting] = useState(false);

  useEffect(() => {
    localStorage.setItem('sparky-sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Dependency check
  const [missingDependencies, setMissingDependencies] = useState<{ claude: boolean, code_server: boolean } | null>(null);

  useEffect(() => {
    localStorage.setItem('sparky-full-auth', JSON.stringify(fullAuth));
  }, [fullAuth]);

  // Check dependencies once on mount
  useEffect(() => {
    if (!tauriAvailable) return;
    invoke<{ claude: boolean, code_server: boolean }>('check_dependencies')
      .then((status) => {
        if (!status.claude || !status.code_server) {
          setMissingDependencies(status);
        }
      })
      .catch((e) => console.error('Failed to check dependencies:', e));
  }, [tauriAvailable]);

  // Poll WebSocket connection status and active projects
  useEffect(() => {
    if (!tauriAvailable) return;
    const poll = async () => {
      try {
        const connected = await invoke<boolean>('get_ws_connected');
        setWsConnected(connected);
        const active = await invoke<string[]>('get_active_projects');
        setActiveProjects(active);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [tauriAvailable]);


  useEffect(() => {
    if (isDarkMode) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }, [isDarkMode]);

  useEffect(() => {
    if (!tauriAvailable) {
      return;
    }
    loadConfig();
    fetchProjects();

    const unlistenPromise = listen<{ projectPath: string; terminalId: string }>('pty-exit', (event) => {
      const { projectPath, terminalId } = event.payload;

      setProjectTerminals(prev => {
        const next = (prev[projectPath] || []).filter(t => t.id !== terminalId);

        setActiveTerminalId(activePrev => {
          if (activePrev[projectPath] === terminalId) {
            return {
              ...activePrev,
              [projectPath]: next.length > 0 ? next[next.length - 1].id : ''
            };
          }
          return activePrev;
        });

        return { ...prev, [projectPath]: next };
      });
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'project-detail' || !selectedProject) {
      return;
    }

    // 初始化项目的终端
    const pTerminals = projectTerminals[selectedProject.path] || [];
    if (pTerminals.length === 0) {
      const newId = crypto.randomUUID();
      setProjectTerminals(prev => ({
        ...prev,
        [selectedProject.path]: [{ id: newId, title: 'Claude-1' }]
      }));
      setActiveTerminalId(prev => ({
        ...prev,
        [selectedProject.path]: newId
      }));
    }

    // load history
    invoke<string[]>('get_terminal_history', { project_path: selectedProject.path })
      .then((history) => {
        setTerminalHistory(prev => ({ ...prev, [selectedProject.path]: history }));
      })
      .catch(() => {
        setTerminalHistory(prev => ({ ...prev, [selectedProject.path]: [] }));
      });
  }, [activeMenu, selectedProject, tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'project-detail' || !selectedProject) {
      setHookRecords([]);
      setHookRecordsTotal(0);
      setHookRecordsPage(1);
      setHookRecordSelection([]);
      return;
    }
    fetchHookRecords(1);
  }, [activeMenu, selectedProject, tauriAvailable]);

  const handleTerminalInput = (data: string) => {
    if (!tauriAvailable || !selectedProject) {
      return;
    }
    const currentTerminal = activeTerminalId[selectedProject.path];
    if (!currentTerminal) return;

    let buffer = inputBufferRef.current[currentTerminal] || '';
    let i = 0;
    while (i < data.length) {
      const code = data.charCodeAt(i);
      if (code === 0x1b) {
        i++;
        if (i < data.length && data[i] === '[') {
          i++;
          while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++;
          i++;
        } else if (i < data.length) {
          i++;
        }
        continue;
      }
      if (data[i] === '\r' || data[i] === '\n') {
        if (buffer.trim()) {
          const finalBuffer = buffer.trim();
          setLastCommand(prev => ({
            ...prev,
            [currentTerminal]: finalBuffer,
            [selectedProject.path]: finalBuffer
          }));
        }
        buffer = '';
        i++;
        continue;
      }
      if (code === 127) {
        buffer = buffer.slice(0, -1);
        i++;
        continue;
      }
      if (code < 32) {
        i++;
        continue;
      }
      buffer += data[i];
      i++;
    }
    inputBufferRef.current[currentTerminal] = buffer;
  };

  const handleEnterProject = (project: Project) => {
    setSelectedProject(project);
    setActiveMenu('project-detail');
  };

  const handleBackToProjects = () => {
    setSelectedProject(null);
    setActiveMenu('project');
  };

  const handleCloseTerminal = async () => {
    if (!selectedProject || !tauriAvailable) return;
    try {
      const pTerminals = projectTerminals[selectedProject.path] || [];
      for (const t of pTerminals) {
        await invoke('pty_kill', { terminal_id: t.id });
      }
      messageApi.success(`项目 ${selectedProject.name} 已关闭`);
      // Update UI optimistically
      setProjectTerminals(prev => ({ ...prev, [selectedProject.path]: [] }));
      setActiveTerminalId(prev => ({ ...prev, [selectedProject.path]: '' }));
      setActiveProjects(activeProjects.filter(p => p !== selectedProject.path));
      setActiveMenu('project');
      setSelectedProject(null);
    } catch (e) {
      messageApi.error(`关闭终端失败: ${e}`);
    }
  };

  const loadConfig = async () => {
    if (!tauriAvailable) {
      return;
    }
    try {
      const config = await invoke<AppConfig>('get_config');
      form.setFieldsValue(config);
      setAppConfig(config);
      appConfigRef.current = config;
    } catch (error) {
      messageApi.error(`加载配置失败: ${error}`);
    }
  };

  const fetchProjects = async () => {
    if (!tauriAvailable) {
      setProjects([]);
      return;
    }
    try {
      const projectsData = await invoke<Project[]>('get_projects');
      setProjects(projectsData);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  };

  const fetchHookRecords = async (page: number) => {
    if (!tauriAvailable || !selectedProject) {
      setHookRecords([]);
      setHookRecordsTotal(0);
      setHookRecordsPage(1);
      return;
    }
    setHookRecordsLoading(true);
    try {
      const response = await invoke<HookRecordsResponse>('get_hook_records', { project_path: selectedProject.path, page, page_size: 20 });
      setHookRecords(response.records);
      setHookRecordsTotal(response.total);
      setHookRecordsPage(response.page);
    } catch (error) {
      messageApi.error(`加载 Hooks 记录失败: ${error}`);
      setHookRecords([]);
      setHookRecordsTotal(0);
    } finally {
      setHookRecordsLoading(false);
    }
  };

  const formatHookTime = (value: number) => {
    const time = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(time).toLocaleString();
  };

  const fetchSessions = async (projectPath: string) => {
    if (!tauriAvailable || !selectedProject) return;
    try {
      const result = await invoke<SessionInfo[]>('get_project_sessions', { project_path: projectPath });
      // Deduplicate sessions by ID and filter by project name if present
      const filteredResult = result.filter(s => {
        if (!s.project_name) return true; // Keep old sessions without project_name
        return s.project_name === selectedProject.name;
      });
      const uniqueSessions = Array.from(new Map(filteredResult.map(s => [s.session_id, s])).values());
      setSessions(uniqueSessions);
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
      setSessions([]);
    }
  };

  const handleUpdateSessionName = async (session_id: string, newName: string) => {
    if (!tauriAvailable || !selectedProject) return;
    try {
      await invoke('update_session_name', { session_id, name: newName });
      messageApi.success('会话名称更新成功');
      setEditingSessionId(null);
      fetchSessions(selectedProject.path);
    } catch (error) {
      console.error('Failed to update session name:', error);
      messageApi.error('更新会话名称失败');
    }
  };

  const handleDeleteHookRecord = async (id: number) => {
    if (!tauriAvailable || !selectedProject) {
      messageApi.warning('请在桌面应用中删除记录');
      return;
    }
    modalApi.confirm({
      title: '确认删除',
      content: '确定要删除这条 Hooks 记录吗？',
      onOk: async () => {
        try {
          await invoke('delete_hook_record', { project_path: selectedProject.path, id });
          messageApi.success('删除成功');
          setHookRecordSelection((prev) => prev.filter((item) => item !== id));
          fetchHookRecords(hookRecordsPage);
        } catch (error) {
          messageApi.error(`删除失败: ${error}`);
        }
      },
    });
  };

  const handleDeleteHookRecords = async () => {
    if (!tauriAvailable || !selectedProject) {
      messageApi.warning('请在桌面应用中删除记录');
      return;
    }
    if (hookRecordSelection.length === 0) {
      return;
    }
    modalApi.confirm({
      title: '确认批量删除',
      content: `确定要删除选中的 ${hookRecordSelection.length} 条 Hooks 记录吗？`,
      onOk: async () => {
        try {
          await invoke('delete_hook_records', { project_path: selectedProject.path, ids: hookRecordSelection });
          messageApi.success('批量删除成功');
          setHookRecordSelection([]);
          fetchHookRecords(hookRecordsPage);
        } catch (error) {
          messageApi.error(`批量删除失败: ${error}`);
        }
      },
    });
  };

  const handleSave = async (values: any) => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中保存配置');
      return;
    }
    setLoading(true);
    try {
      const configToSave = {
        ...values,
        terminal_bg_color: typeof values.terminal_bg_color === 'string' ? values.terminal_bg_color : values.terminal_bg_color?.toHexString(),
        terminal_fg_color: typeof values.terminal_fg_color === 'string' ? values.terminal_fg_color : values.terminal_fg_color?.toHexString(),
        terminal_font_size: values.terminal_font_size ?? 13,
      };
      await invoke('save_config', { config: configToSave });
      setAppConfig(configToSave);
      messageApi.success('配置已保存');
    } catch (error) {
      messageApi.error(`保存配置失败: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const [uploadingLogo, setUploadingLogo] = useState(false);

  const handleUploadAnthropicLogo = async () => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中使用此功能');
      return;
    }
    setUploadingLogo(true);
    try {
      const imgKey = await invoke<string>('upload_anthropic_logo');
      messageApi.success(`Logo 上传成功: ${imgKey}`);
    } catch (error) {
      messageApi.error(`上传失败: ${error}`);
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleTestConnection = async () => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中测试连接');
      return;
    }
    const appId = form.getFieldValue('app_id');
    const appSecret = form.getFieldValue('app_secret');

    if (!appId || !appSecret) {
      messageApi.warning('请先填写 App ID 和 App Secret');
      return;
    }

    setTestingConnection(true);
    try {
      const result = await invoke<string>('test_feishu_connection', { app_id: appId, app_secret: appSecret });
      messageApi.success(result);
    } catch (error) {
      messageApi.error(`测试失败: ${error}`);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleAddProject = async () => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中添加项目');
      return;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择项目文件夹',
    });
    if (selected && typeof selected === 'string') {
      const name = selected.split('/').pop() || '未命名项目';
      try {
        const newProject = await invoke<Project>('add_project', { name, path: selected });
        setProjects([...projects, newProject]);
        messageApi.success(`项目 "${name}" 添加成功`);
      } catch (error) {
        messageApi.error(`添加项目失败: ${error}`);
      }
    }
  };

  const handleDeleteProject = (id: number) => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中删除项目');
      return;
    }
    modalApi.confirm({
      title: '确认删除',
      content: '确定要删除这个项目吗？',
      onOk: async () => {
        try {
          await invoke('delete_project', { id });
          setProjects(projects.filter(p => p.id !== id));
          messageApi.success('删除成功');
        } catch (error) {
          messageApi.error(`删除项目失败: ${error}`);
        }
      },
    });
  };

  const handleInstallHooks = async (project: Project) => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中安装推送服务');
      return;
    }
    try {
      await invoke('install_hooks', { project_path: project.path });
      await invoke('set_project_hooks_status', { id: project.id, hooks_installed: true });
      setProjects(projects.map(p => p.id === project.id ? { ...p, hooks_installed: true } : p));
      messageApi.success('Hooks 安装成功');
    } catch (error) {
      messageApi.error(`安装推送服务失败: ${error}`);
    }
  };

  const handleUninstallHooks = async (project: Project) => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中卸载推送服务');
      return;
    }
    try {
      await invoke('uninstall_hooks', { project_path: project.path });
      await invoke('set_project_hooks_status', { id: project.id, hooks_installed: false });
      setProjects(projects.map(p => p.id === project.id ? { ...p, hooks_installed: false } : p));
      messageApi.success('Hooks 已卸载');
    } catch (error) {
      messageApi.error(`卸载推送服务失败: ${error}`);
    }
  };

  const handleToggleAgentTeams = async (project: Project) => {
    if (!tauriAvailable) return;
    try {
      const nextValue = await invoke<boolean>('toggle_agent_teams', { project_path: project.path });
      setProjects(projects.map(p =>
        p.id === project.id ? { ...p, agent_teams_enabled: nextValue } : p
      ));
      messageApi.success(`项目 ${project.name} 的 Sub agents 已${nextValue ? '开启' : '关闭'}`);
    } catch (error) {
      messageApi.error(`操作失败: ${error}`);
    }
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: isDarkMode ? '#ffffff' : '#000000',
          colorBgBase: isDarkMode ? '#1e1e1e' : '#ffffff',
          colorTextBase: isDarkMode ? '#e0e0e0' : '#000000',
        },
        components: {
          Button: {
            primaryColor: isDarkMode ? '#000' : '#fff', // Button text on primary
            contentFontSize: 14,
          },
          Tabs: {
            itemColor: isDarkMode ? '#a0a0a0' : '#000000',
            itemSelectedColor: isDarkMode ? '#ffffff' : '#000000',
            itemHoverColor: isDarkMode ? '#ffffff' : '#000000',
          }
        }
      }}
    >
      <div className={`app-container ${isDarkMode ? 'dark-mode' : ''} ${terminalFullscreen ? 'terminal-fullscreen' : ''}`}>
        <header className="app-header">
          <div className="header-content" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="logo">
                <img src={logo} alt="logo" className="logo-img" />
                <h1>Sparky</h1>
                {activeProjects.length > 0 && (
                  <div className="header-active-projects-inline">
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginRight: 6, fontWeight: 500 }}>运行中:</span>
                    {activeProjects.map(path => {
                      const name = path.split('/').pop() || path;
                      const isActive = selectedProject?.path === path;
                      return (
                        <Tag
                          key={path}
                          className={isActive ? "active-project-tag" : "inactive-project-tag"}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            const proj = projects.find(p => p.path === path);
                            if (proj) {
                              handleEnterProject(proj);
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
              {/* <p className="subtitle">多渠道集成 · 随时随地链接 Claude Code</p> */}
            </div>
            <Switch
              className="theme-switch"
              checked={isDarkMode}
              onChange={(checked) => setIsDarkMode(checked)}
              checkedChildren={<MoonOutlined />}
              unCheckedChildren={<SunOutlined />}
            />
          </div>
        </header>

        <main className="app-main">
          <div className="app-layout">
            <aside className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
              <Menu
                mode="inline"
                inlineCollapsed={sidebarCollapsed}
                selectedKeys={[activeMenu]}
                onClick={(e) => setActiveMenu(e.key)}
                style={{ height: '100%', borderRight: 0 }}
                items={[
                  { key: 'project', icon: <ProjectOutlined />, label: '项目' },
                  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
                  { key: 'help', icon: <EyeOutlined />, label: '帮助' },
                ]}
              />
              <div className="sidebar-toggle-container">
                <Button
                  type="text"
                  icon={sidebarCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                  onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                  className="sidebar-toggle-btn"
                />
              </div>
            </aside>
            <div className="app-content">
              {activeMenu === 'project' && (
                <div className="project-page">
                  <Card className="projects-card" variant="borderless">
                    <div className="card-header">
                      <ProjectOutlined className="card-icon" />
                      <h2>项目管理</h2>
                      <Button type="primary" icon={<PlusOutlined />} onClick={handleAddProject} style={{ marginLeft: 'auto' }}>
                        添加项目
                      </Button>
                    </div>
                    <p className="card-description">管理您的项目，每个项目可以独立配置 Claude Code Hooks</p>
                    <Divider />
                    {projects.length === 0 ? (
                      <Empty description="暂无项目，请添加项目" />
                    ) : (
                      <Table
                        dataSource={projects}
                        rowKey="id"
                        pagination={false}
                        columns={[
                          {
                            title: '项目名称', dataIndex: 'name', key: 'name',
                            render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>
                          },
                          {
                            title: '路径', dataIndex: 'path', key: 'path',
                            render: (path: string) => <span style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{path}</span>
                          },
                          {
                            title: '推送服务',
                            key: 'hooks',
                            width: 140,
                            render: (_: any, record: Project) => (
                              <Space size={4}>
                                <Tag className={`hooks-tag ${record.hooks_installed ? 'installed' : ''}`} style={{ margin: 0 }}>
                                  {record.hooks_installed ? '已安装' : '未安装'}
                                </Tag>
                                {record.hooks_installed && (
                                  <Tooltip title="重新安装">
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<ReloadOutlined style={{ fontSize: 13 }} />}
                                      onClick={() => handleInstallHooks(record)}
                                      style={{ padding: '0 4px', height: 22, color: 'var(--text-secondary)' }}
                                    />
                                  </Tooltip>
                                )}
                              </Space>
                            ),
                          },
                          {
                            title: 'Claude 配置',
                            key: 'claude_config',
                            width: 140,
                            render: (_: any, record: Project) => (
                              <Button size="small" onClick={() => handleToggleAgentTeams(record)}>
                                {record.agent_teams_enabled ? '关闭 Sub agents' : '开启 Sub agents'}
                              </Button>
                            ),
                          },
                          {
                            title: '操作',
                            key: 'action',
                            width: 180,
                            render: (_: any, record: Project) => (
                              <Space>
                                <Button size="small" type="primary" onClick={() => handleEnterProject(record)}>
                                  Go <RightOutlined style={{ fontSize: 10 }} />
                                </Button>
                                {!record.hooks_installed && (
                                  <Button size="small" type="text" className="action-btn-text" onClick={() => handleInstallHooks(record)}>
                                    配置
                                  </Button>
                                )}
                                <Button size="small" className="action-btn-outline danger" icon={<DeleteOutlined />} onClick={() => handleDeleteProject(record.id)} />
                              </Space>
                            ),
                          },
                        ]}
                      />
                    )}
                  </Card>
                </div>
              )}

              {activeMenu === 'project-detail' && selectedProject && (
                <div className="project-detail-page">
                  <Card className="project-detail-card" variant="borderless">
                    <div className="project-detail-header">
                      <Button
                        type="text"
                        icon={<ArrowLeftOutlined />}
                        onClick={handleBackToProjects}
                        className="back-button"
                      />
                      <span className="header-divider" />
                      <span className="project-title-badge">{selectedProject.name}</span>
                      <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => {
                        const tid = activeTerminalId[selectedProject.path];
                        const isFullAuth = fullAuth[selectedProject.path] || false;
                        const cmd = isFullAuth ? 'claude --dangerously-skip-permissions\n' : 'claude\n';
                        if (tid) invoke('pty_write', { terminal_id: tid, data: cmd });
                      }} className="action-btn-outline" style={{ marginLeft: 8 }}>
                        新建会话
                      </Button>
                      <Button size="small" type="default" onClick={async () => {
                        await fetchSessions(selectedProject.path);
                        setSessionModalOpen(true);
                      }} icon={<HistoryOutlined />} className="action-btn-outline" style={{ marginLeft: 4 }}>
                        继续会话
                      </Button>
                      <Button size="small" type="default" onClick={() => {
                        setTestModalOpen(true);
                        if (tauriAvailable) {
                          invoke<{ installed: boolean; running: boolean; path: string }>('check_mcp_status').then(setMcpStatus).catch(() => { });
                        }
                      }} icon={<ExperimentOutlined />} className="action-btn-outline" style={{ marginLeft: 4 }}>
                        测试会话
                      </Button>
                      <Divider type="vertical" style={{ marginLeft: 16, marginRight: 12 }} />
                      <Tooltip title={fullAuth[selectedProject.path] ? '完全授权模式 (--dangerously-skip-permissions)' : '安全模式 (进行权限管控)'}>
                        <Button
                          size="small"
                          type={fullAuth[selectedProject.path] ? 'primary' : 'default'}
                          danger={fullAuth[selectedProject.path] || false}
                          className={fullAuth[selectedProject.path] ? 'auth-btn-danger' : 'action-btn-outline'}
                          onClick={() => setFullAuth(prev => ({ ...prev, [selectedProject.path]: !(prev[selectedProject.path] || false) }))}
                          style={{ margin: '0 4px' }}
                        >
                          {fullAuth[selectedProject.path] ? '完全授权' : '安全模式'}
                        </Button>
                      </Tooltip>

                      <Button
                        size="small"
                        type={activeTerminalId[selectedProject.path] === 'vscode' ? 'primary' : 'default'}
                        onClick={() => {
                          setShowCoderIde(true);
                          setActiveTerminalId(prev => ({
                            ...prev,
                            [selectedProject.path]: 'vscode'
                          }));
                        }}
                        className="action-btn-outline"
                        style={{ marginRight: 12, display: 'flex', alignItems: 'center', gap: 8 }}
                      >
                        <img src={codeIcon} width={18} height={18} alt="Coder IDE" />
                        Coder IDE
                      </Button>

                      <span className={`ws-status-badge ${wsConnected ? 'connected' : 'disconnected'}`}>
                        <span className="ws-status-dot" />
                        {wsConnected ? '已连接' : '未连接'}
                      </span>
                      <Dropdown
                        menu={{
                          items: [
                            {
                              key: 'update',
                              label: '更新 Claude',
                              icon: <ReloadOutlined />,
                              onClick: () => {
                                const tid = activeTerminalId[selectedProject.path];
                                if (tid) invoke('pty_write', { terminal_id: tid, data: 'claude update\n' });
                              }
                            },
                            {
                              key: 'records',
                              label: 'Claude 记录',
                              icon: <HistoryOutlined />,
                              onClick: () => {
                                setShowDetailTab(prev => ({ ...prev, [selectedProject.path]: true }));
                                setActiveTerminalId(prev => ({
                                  ...prev,
                                  [selectedProject.path]: 'detail'
                                }));
                              }
                            },
                            {
                              type: 'divider'
                            },
                            {
                              key: 'close',
                              label: '关闭项目',
                              icon: <PoweroffOutlined />,
                              danger: true,
                              onClick: handleCloseTerminal
                            }
                          ]
                        }}
                        placement="bottomRight"
                        trigger={['click']}
                      >
                        <Button
                          type="text"
                          size="small"
                          icon={<MenuOutlined />}
                          style={{ marginLeft: 12 }}
                        />
                      </Dropdown>
                    </div>

                    {/* Session Picker Modal */}
                    <Modal
                      title="选择要继续的会话"
                      open={sessionModalOpen}
                      onCancel={() => setSessionModalOpen(false)}
                      footer={null}
                      width={600}
                    >
                      {sessions.length === 0 ? (
                        <Empty description="暂无历史会话" />
                      ) : (
                        <Table
                          dataSource={sessions}
                          rowKey="id"
                          size="small"
                          pagination={{ pageSize: 10 }}
                          columns={[
                            {
                              title: '会话名称',
                              dataIndex: 'name',
                              key: 'name',
                              width: 220,
                              render: (text: string | null, record: SessionInfo) => (
                                editingSessionId === record.session_id ? (
                                  <Space.Compact style={{ width: '100%' }}>
                                    <Input
                                      size="small"
                                      autoFocus
                                      value={editingSessionName}
                                      onChange={(e) => setEditingSessionName(e.target.value)}
                                      onPressEnter={() => handleUpdateSessionName(record.session_id, editingSessionName)}
                                    />
                                    <Button
                                      size="small"
                                      type="primary"
                                      icon={<CheckOutlined />}
                                      onClick={() => handleUpdateSessionName(record.session_id, editingSessionName)}
                                    />
                                    <Button
                                      size="small"
                                      icon={<CloseOutlined />}
                                      onClick={() => setEditingSessionId(null)}
                                    />
                                  </Space.Compact>
                                ) : (
                                  <Space>
                                    <span style={{ fontWeight: 500 }}>
                                      {text || (
                                        <Typography.Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
                                          未命名会话
                                        </Typography.Text>
                                      )}
                                    </span>
                                    <Button
                                      type="text"
                                      size="small"
                                      icon={<EditOutlined style={{ fontSize: 12 }} />}
                                      onClick={() => {
                                        setEditingSessionName(text || '');
                                        setEditingSessionId(record.session_id);
                                      }}
                                    />
                                  </Space>
                                )
                              ),
                            },
                            {
                              title: 'Session ID',
                              dataIndex: 'session_id',
                              key: 'session_id',
                              width: 140,
                              render: (text: string) => (
                                <Typography.Text copyable style={{ fontSize: 12 }}>
                                  {text.length > 8 ? text.slice(0, 8) + '...' : text}
                                </Typography.Text>
                              ),
                            },
                            {
                              title: '开始时间',
                              dataIndex: 'started_at',
                              key: 'started_at',
                              width: 160,
                              render: (value: number) => formatHookTime(value),
                            },
                            {
                              title: '状态',
                              key: 'status',
                              width: 100,
                              render: (_: any, record: SessionInfo) => (
                                <Tag color={record.ended_at ? 'default' : 'green'}>
                                  {record.ended_at ? (record.reason || '已结束') : '运行中'}
                                </Tag>
                              ),
                            },
                            {
                              title: '操作',
                              key: 'action',
                              width: 80,
                              render: (_: any, record: SessionInfo) => (
                                <Button
                                  size="small"
                                  type="primary"
                                  onClick={() => {
                                    const tid = activeTerminalId[selectedProject.path];
                                    const isFullAuth = fullAuth[selectedProject.path] || false;
                                    const cmd = isFullAuth
                                      ? `claude --dangerously-skip-permissions --resume ${record.session_id}\n`
                                      : `claude --resume ${record.session_id}\n`;
                                    if (tid) invoke('pty_write', { terminal_id: tid, data: cmd });
                                    setSessionModalOpen(false);
                                  }}
                                >
                                  继续
                                </Button>
                              ),
                            },
                          ]}
                        />
                      )}
                    </Modal>

                    {/* Testing Modal */}
                    <Modal
                      title={
                        <Space>
                          <ExperimentOutlined style={{ color: 'var(--ant-color-primary)' }} />
                          <span>项目测试</span>
                        </Space>
                      }
                      open={testModalOpen}
                      onCancel={() => { setTestModalOpen(false); setCurlResult(''); }}
                      footer={null}
                      width={720}
                      destroyOnClose
                      className="test-modal" styles={{ mask: { backdropFilter: "blur(4px)" }, header: { background: "transparent", borderBottom: 0, marginBottom: 0, paddingBottom: 0 }, content: { background: "var(--header-bg)" } }}
                    >
                      <Tabs
                        defaultActiveKey="mcp"
                        items={[
                          {
                            key: 'mcp',
                            label: <span><EyeOutlined /> 页面测试 (MCP)</span>,
                            children: (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                <Card size="small" className="mcp-status-card" variant="borderless">
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <span style={{ fontWeight: 500 }}>Chrome DevTools MCP 状态</span>
                                      <Button
                                        size="small"
                                        icon={<ReloadOutlined />}
                                        loading={mcpLoading}
                                        onClick={async () => {
                                          if (!tauriAvailable) return;
                                          setMcpLoading(true);
                                          try {
                                            const status = await invoke<{ installed: boolean; running: boolean; path: string }>('check_mcp_status');
                                            setMcpStatus(status);
                                          } catch (err) {
                                            messageApi.error(`检查失败: ${err}`);
                                          } finally {
                                            setMcpLoading(false);
                                          }
                                        }}
                                      >
                                        刷新状态
                                      </Button>
                                    </div>
                                    {mcpStatus ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          {mcpStatus.installed
                                            ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                                            : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
                                          <span>安装状态：{mcpStatus.installed ? '已安装' : '未安装'}</span>
                                        </div>
                                        {mcpStatus.installed && (
                                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', paddingLeft: 22 }}>
                                            路径: {mcpStatus.path}
                                          </div>
                                        )}
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                          {mcpStatus.running
                                            ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                                            : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
                                          <span>运行状态：{mcpStatus.running ? '运行中' : '未运行'}</span>
                                        </div>
                                      </div>
                                    ) : (
                                      <div style={{ color: 'var(--text-secondary)' }}>点击刷新状态以检查</div>
                                    )}
                                  </div>
                                </Card>
                                <Button
                                  type="primary"
                                  size="large"
                                  icon={<ExperimentOutlined />}
                                  loading={mcpStarting}
                                  onClick={async () => {
                                    if (!tauriAvailable || !selectedProject) return;
                                    setMcpStarting(true);
                                    try {
                                      // 1. Check & start MCP if not running
                                      const status = await invoke<{ installed: boolean; running: boolean; path: string }>('check_mcp_status');
                                      setMcpStatus(status);
                                      if (!status.installed) {
                                        messageApi.error('chrome-devtools-mcp 未安装，请先安装');
                                        return;
                                      }
                                      if (!status.running) {
                                        try {
                                          await invoke<string>('start_mcp_server');
                                          const newStatus = await invoke<{ installed: boolean; running: boolean; path: string }>('check_mcp_status');
                                          setMcpStatus(newStatus);
                                        } catch (err) {
                                          messageApi.error(`MCP 启动失败: ${err}`);
                                          return;
                                        }
                                      }

                                      // 2. Create or reuse terminal tab named "MCP 测试"
                                      const current = projectTerminals[selectedProject.path] || [];
                                      const existingTab = current.find(t => t.title === "MCP 测试");
                                      let targetTerminalId = existingTab?.id;

                                      if (!targetTerminalId) {
                                        targetTerminalId = crypto.randomUUID();
                                        setProjectTerminals(prev => ({
                                          ...prev,
                                          [selectedProject.path]: [...current, { id: targetTerminalId as string, title: "MCP 测试" }]
                                        }));
                                      }

                                      setActiveTerminalId(prev => ({
                                        ...prev,
                                        [selectedProject.path]: targetTerminalId
                                      }));

                                      // 3. Close the test modal and switch to claude tab
                                      setTestModalOpen(false);

                                      // 4. Wait for terminal to be ready, then send claude command
                                      setTimeout(async () => {
                                        try {
                                          // Check for existing testing session
                                          const existingSession = await invoke<string | null>('get_testing_session', {
                                            project_path: selectedProject.path,
                                          });

                                          const isFullAuth = fullAuth[selectedProject.path] || false;
                                          let cmd: string;

                                          if (existingSession) {
                                            // Resume existing testing session
                                            cmd = isFullAuth
                                              ? `claude --dangerously-skip-permissions --resume ${existingSession}\n`
                                              : `claude --resume ${existingSession}\n`;
                                            messageApi.info(`恢复测试会话: ${existingSession.slice(0, 12)}...`);
                                          } else {
                                            // Start new claude session - capture current sessions first to avoid saving old session
                                            const currentSessions = await invoke<SessionInfo[]>('get_project_sessions', {
                                              project_path: selectedProject.path,
                                            }).catch(() => [] as SessionInfo[]);
                                            const topId = currentSessions.length > 0 ? currentSessions[0].id : 0;

                                            cmd = isFullAuth
                                              ? 'claude --dangerously-skip-permissions\n'
                                              : 'claude\n';
                                            messageApi.info('启动新的 MCP 测试会话，正在连接...');

                                            // Poll for up to 15 seconds to find the newly created session
                                            let attempts = 0;
                                            const pollInterval = setInterval(async () => {
                                              attempts++;
                                              try {
                                                const sessions = await invoke<SessionInfo[]>('get_project_sessions', {
                                                  project_path: selectedProject.path,
                                                });
                                                if (sessions.length > 0 && sessions[0].id > topId && sessions[0].session_id) {
                                                  clearInterval(pollInterval);
                                                  await invoke('save_testing_session', {
                                                    project_path: selectedProject.path,
                                                    session_id: sessions[0].session_id,
                                                  });
                                                  messageApi.success(`测试会话已记录: ${sessions[0].session_id.slice(0, 12)}...`);
                                                }
                                              } catch { /* ignore */ }

                                              if (attempts >= 15) {
                                                clearInterval(pollInterval);
                                                console.log("MCP Test session polling timed out");
                                              }
                                            }, 1000);
                                          }

                                          await invoke('pty_write', { terminal_id: targetTerminalId, data: cmd });
                                        } catch (err) {
                                          messageApi.error(`启动会话失败: ${err}`);
                                        }
                                      }, 1500);
                                    } catch (err) {
                                      messageApi.error(`操作失败: ${err}`);
                                    } finally {
                                      setMcpStarting(false);
                                    }
                                  }}
                                  style={{ height: 48, fontSize: 16 }}
                                >
                                  开启 MCP 测试
                                </Button>
                                {!mcpStatus?.installed && (
                                  <div style={{ padding: '12px 16px', background: 'var(--bg-secondary, #f5f5f5)', borderRadius: 8, fontSize: 13 }}>
                                    <strong>安装说明：</strong>
                                    <br />
                                    请运行以下命令安装 chrome-devtools-mcp：
                                    <pre style={{ margin: '8px 0 0', padding: '8px 12px', background: 'var(--bg-tertiary, #e8e8e8)', borderRadius: 4, fontSize: 12 }}>
                                      npm install -g chrome-devtools-mcp</pre>
                                  </div>
                                )}
                              </div>
                            ),
                          },
                          {
                            key: 'curl',
                            label: <span><ApiOutlined /> 接口测试 (curl)</span>,
                            children: (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                <div>
                                  <label style={{ fontWeight: 500, marginBottom: 6, display: 'block' }}>curl 命令</label>
                                  <Input.TextArea
                                    value={curlCommand}
                                    onChange={(e) => setCurlCommand(e.target.value)}
                                    placeholder="输入 curl 命令，例如: curl -s https://httpbin.org/get"
                                    autoSize={{ minRows: 3, maxRows: 8 }}
                                    style={{ fontFamily: 'monospace', fontSize: 13 }}
                                  />
                                </div>
                                <div>
                                  <Button
                                    type="primary"
                                    icon={curlLoading ? <LoadingOutlined /> : <ThunderboltOutlined />}
                                    loading={curlLoading}
                                    onClick={async () => {
                                      if (!tauriAvailable || !selectedProject) return;
                                      setCurlLoading(true);
                                      setCurlResult('');
                                      try {
                                        const result = await invoke<string>('run_curl_command', {
                                          command: curlCommand,
                                          cwd: selectedProject.path,
                                        });
                                        setCurlResult(result);
                                      } catch (err) {
                                        setCurlResult(`执行失败: ${err}`);
                                      } finally {
                                        setCurlLoading(false);
                                      }
                                    }}
                                  >
                                    执行
                                  </Button>
                                </div>
                                {curlResult && (
                                  <div className="curl-result-box">
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                      <span style={{ fontWeight: 500, fontSize: 13 }}>执行结果</span>
                                      <Button
                                        size="small"
                                        type="text"
                                        icon={<CopyOutlined />}
                                        onClick={() => {
                                          navigator.clipboard.writeText(curlResult);
                                          messageApi.success('已复制到剪贴板');
                                        }}
                                      >
                                        复制
                                      </Button>
                                    </div>
                                    <pre className="curl-result-pre">{curlResult}</pre>
                                  </div>
                                )}
                              </div>
                            ),
                          },
                        ]}
                      />
                    </Modal>

                    <div className={`terminal-wrapper ${terminalFullscreen ? 'fullscreen' : ''}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
                      <Tabs
                        type="editable-card"
                        size="small"
                        activeKey={activeTerminalId[selectedProject.path] || 'detail'}
                        onChange={(key) => setActiveTerminalId(prev => ({ ...prev, [selectedProject.path]: key }))}
                        onEdit={(targetKey, action) => {
                          if (action === 'add') {
                            const newId = crypto.randomUUID();
                            const current = projectTerminals[selectedProject!.path] || [];
                            setProjectTerminals(prev => ({
                              ...prev,
                              [selectedProject!.path]: [...current, { id: newId, title: `Claude-${current.length + 1}` }]
                            }));
                            setActiveTerminalId(prev => ({
                              ...prev,
                              [selectedProject!.path]: newId
                            }));
                          } else if (action === 'remove' && typeof targetKey === 'string') {
                            if (targetKey === 'vscode') {
                              setShowCoderIde(false);
                              if (activeTerminalId[selectedProject!.path] === 'vscode') {
                                setActiveTerminalId(prev => ({ ...prev, [selectedProject!.path]: 'detail' }));
                              }
                              return;
                            }
                            if (targetKey === 'detail') {
                              setShowDetailTab(prev => ({ ...prev, [selectedProject!.path]: false }));
                              if (activeTerminalId[selectedProject!.path] === 'detail') {
                                setActiveTerminalId(prev => ({ ...prev, [selectedProject!.path]: projectTerminals[selectedProject!.path]?.[0]?.id || 'vscode' }));
                              }
                              return;
                            }
                            if (targetKey.startsWith('vscode-external-')) {
                              const pathToRemove = targetKey.replace('vscode-external-', '');
                              setExternalFileTabs(prev => prev.filter(tab => tab.path !== pathToRemove));
                              if (activeTerminalId[selectedProject!.path] === targetKey) {
                                setActiveTerminalId(prev => ({ ...prev, [selectedProject!.path]: 'detail' }));
                              }
                              return;
                            }
                            invoke('pty_kill', { terminal_id: targetKey });
                            setProjectTerminals(prev => {
                              const next = prev[selectedProject!.path].filter(t => t.id !== targetKey);
                              return { ...prev, [selectedProject!.path]: next };
                            });
                            if (activeTerminalId[selectedProject!.path] === targetKey) {
                              const remaining = projectTerminals[selectedProject!.path].filter(t => t.id !== targetKey);
                              if (remaining.length > 0) {
                                setActiveTerminalId(prev => ({
                                  ...prev,
                                  [selectedProject!.path]: remaining[remaining.length - 1].id
                                }));
                              } else {
                                setActiveTerminalId(prev => ({
                                  ...prev,
                                  [selectedProject!.path]: 'detail'
                                }));
                              }
                            }
                          }
                        }}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: 12 }}
                        className="terminal-tabs-inner settings-tabs"
                        items={[
                          ...(projectTerminals[selectedProject.path] || []).map(term => {
                            const isActive = activeTerminalId[selectedProject.path] === term.id;
                            return {
                              key: term.id,
                              label: (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <img src={isActive ? claudeIcon : claudeDeactiveIcon} width={18} height={18} alt="Claude" />
                                  <span>{term.title}</span>
                                </div>
                              ),
                              closable: true,
                              children: (
                                <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                                  {lastCommand[term.id] && (
                                    <div className="last-input-bar">
                                      <span className="last-input-label">最近输入</span>
                                      <code className="last-input-content">{lastCommand[term.id]}</code>
                                    </div>
                                  )}
                                  <Button
                                    type="text"
                                    icon={terminalFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                                    style={{
                                      position: 'absolute',
                                      right: 16,
                                      top: terminalFullscreen ? 30 : 30,
                                      zIndex: 100,
                                      color: 'rgba(255, 255, 255, 0.65)',
                                      background: 'rgba(0, 0, 0, 0.2)'
                                    }}
                                    onClick={() => setTerminalFullscreen(!terminalFullscreen)}
                                  />
                                  <Button
                                    type="text"
                                    icon={<ArrowDownOutlined />}
                                    style={{
                                      position: 'absolute',
                                      right: 56,
                                      top: terminalFullscreen ? 30 : 30,
                                      zIndex: 100,
                                      color: 'rgba(255, 255, 255, 0.65)',
                                      background: 'rgba(0, 0, 0, 0.2)'
                                    }}
                                    title="滚动到底部"
                                    onClick={() => terminalRefs.current[term.id]?.scrollToBottom()}
                                  />
                                  <TerminalComponent
                                    projectPath={selectedProject!.path}
                                    terminalId={term.id}
                                    title={term.title as string}
                                    onData={handleTerminalInput}
                                    onLinkClick={(path) => {
                                      if (path.startsWith(selectedProject!.path)) {
                                        // File is inside the current project, open in Coder IDE
                                        setShowCoderIde(true);
                                        setActiveTerminalId(prev => ({
                                          ...prev,
                                          [selectedProject!.path]: 'vscode'
                                        }));
                                        // Tell code-server to open the file via its API
                                        console.log('Invoking open_in_coder with path:', path);
                                        invoke('open_in_coder', { file_path: path }).catch((err) => {
                                          console.error('Failed to open file in Coder IDE:', err);
                                        });
                                      } else {
                                        // File is outside the project, open in a new tab
                                        console.log('Path is outside project, opening in new tab:', path);

                                        // Get directory of the file for the iframe folder parameter
                                        const folderPath = path.substring(0, path.lastIndexOf('/'));

                                        setExternalFileTabs(prev => {
                                          // Avoid duplicate tabs for the same file
                                          if (!prev.some(tab => tab.path === path)) {
                                            return [...prev, { path, folderPath }];
                                          }
                                          return prev;
                                        });

                                        setActiveTerminalId(prev => ({
                                          ...prev,
                                          [selectedProject!.path]: `vscode-external-${path}`
                                        }));

                                        // Give time for iframe to mount, then instruct it to open the file via API
                                        setTimeout(() => {
                                          invoke('open_in_coder', { file_path: path }).catch((err) => {
                                            console.error('Failed to open external file in Coder IDE:', err);
                                          });
                                        }, 500);
                                      }
                                    }}
                                    mergeTop
                                    historyLines={terminalHistory[selectedProject!.path] || []}
                                    fullscreen={terminalFullscreen}
                                    theme={{
                                      background: appConfig?.terminal_bg_color,
                                      foreground: appConfig?.terminal_fg_color,
                                      fontSize: appConfig?.terminal_font_size,
                                    }}
                                    ref={(el) => {
                                      if (el) terminalRefs.current[term.id] = el;
                                    }}
                                  />
                                </div>
                              ),
                            };
                          }).concat(externalFileTabs.map(tab => ({
                            key: `vscode-external-${tab.path}`,
                            label: (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <img src={codeIcon} width={18} height={18} alt="Coder IDE" />
                                <span title={tab.path}>{tab.path.split('/').pop()}</span>
                              </div>
                            ),
                            closable: true,
                            children: (
                              <div style={{ width: '100%', height: '100%', background: 'var(--bg-primary)' }}>
                                <iframe
                                  title={`Coder IDE - ${tab.path}`}
                                  src={`http://127.0.0.1:18080/?folder=${encodeURIComponent(tab.folderPath)}`}
                                  style={{ width: '100%', height: '100%', border: 'none' }}
                                  allow="clipboard-read; clipboard-write"
                                />
                              </div>
                            )
                          }))),
                          ...(showDetailTab[selectedProject.path] ? [{
                            key: 'detail',
                            label: (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <HistoryOutlined />
                                <span>Claude 记录</span>
                              </div>
                            ),
                            closable: true,
                            children: (
                              <Card className="projects-card config-card" variant="borderless" style={{ flex: 1, height: 'auto', overflow: 'auto', position: 'relative' }}>
                                {lastCommand[selectedProject.path] && (
                                  <div className="last-input-bar">
                                    <span className="last-input-label">最近输入</span>
                                    <code className="last-input-content">{lastCommand[selectedProject.path]}</code>
                                  </div>
                                )}
                                <Button
                                  type="text"
                                  icon={terminalFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                                  style={{
                                    position: 'absolute',
                                    right: 16,
                                    top: 30,
                                    zIndex: 100,
                                    color: 'rgba(255, 255, 255, 0.65)',
                                    background: 'rgba(0, 0, 0, 0.2)'
                                  }}
                                  onClick={() => setTerminalFullscreen(!terminalFullscreen)}
                                />
                                <Button
                                  type="text"
                                  icon={<ArrowDownOutlined />}
                                  style={{
                                    position: 'absolute',
                                    right: 56,
                                    top: 30,
                                    zIndex: 100,
                                    color: 'rgba(255, 255, 255, 0.65)',
                                    background: 'rgba(0, 0, 0, 0.2)'
                                  }}
                                  title="滚动到底部"
                                  onClick={() => {
                                    // scrollToBottom might not be easily accessible for detail tab, but adding the button for consistency
                                  }}
                                />
                                <div className="detail-form">
                                  <div className="status-row">
                                    <span className="status-label">项目名称</span>
                                    <span className="status-value">{selectedProject.name}</span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">项目路径</span>
                                    <span className="status-value" style={{ fontSize: '12px', wordBreak: 'break-all' }}>{selectedProject.path}</span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">推送服务状态</span>
                                    <Tag color={selectedProject.hooks_installed ? 'black' : 'default'}>
                                      {selectedProject.hooks_installed ? '已安装' : '未安装'}
                                    </Tag>
                                  </div>
                                  <Divider />
                                  <Space>
                                    <Button type="primary" icon={<FolderOutlined />} onClick={async () => {
                                      try {
                                        await invoke('open_folder', { path: selectedProject.path });
                                      } catch (error) {
                                        messageApi.error(`无法打开文件夹: ${error}`);
                                      }
                                    }}>
                                      打开文件夹
                                    </Button>
                                    <Button icon={<SettingOutlined />} onClick={() => selectedProject.hooks_installed ? handleUninstallHooks(selectedProject) : handleInstallHooks(selectedProject)}>
                                      {selectedProject.hooks_installed ? '卸载推送服务' : '安装推送服务'}
                                    </Button>
                                  </Space>
                                  <Divider />
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                    <h3 style={{ margin: 0 }}>Claude 记录</h3>
                                    <Button danger disabled={hookRecordSelection.length === 0} onClick={handleDeleteHookRecords}>
                                      批量删除
                                    </Button>
                                  </div>
                                  <Table
                                    dataSource={hookRecords}
                                    rowKey="id"
                                    loading={hookRecordsLoading}
                                    tableLayout="fixed"
                                    scroll={{ x: 1000, y: '100%' }}
                                    style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: 0 }}
                                    rowSelection={{
                                      selectedRowKeys: hookRecordSelection,
                                      onChange: (keys) => setHookRecordSelection(keys as number[]),
                                    }}
                                    pagination={{
                                      current: hookRecordsPage,
                                      total: hookRecordsTotal,
                                      pageSize: 20,
                                      showSizeChanger: false,
                                      onChange: (page) => fetchHookRecords(page),
                                    }}
                                    columns={[
                                      { title: '事件', dataIndex: 'event_name', key: 'event_name', width: 140 },
                                      {
                                        title: '摘要',
                                        dataIndex: 'notification_text',
                                        key: 'notification_text',
                                        width: 300,
                                        render: (text: string) => (
                                          <div style={{ maxWidth: 268, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
                                            {text || '-'}
                                          </div>
                                        ),
                                        className: 'column-summary'
                                      },
                                      {
                                        title: '结果',
                                        dataIndex: 'result',
                                        key: 'result',
                                        width: 120,
                                        render: (text: string) => (
                                          <div style={{ maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
                                            {text || '-'}
                                          </div>
                                        ),
                                        className: 'column-result'
                                      },
                                      {
                                        title: '时间',
                                        dataIndex: 'created_at',
                                        key: 'created_at',
                                        width: 180,
                                        render: (value: number) => formatHookTime(value),
                                      },
                                      {
                                        title: '操作',
                                        key: 'action',
                                        width: 160,
                                        render: (_: any, record: HookRecord) => (
                                          <Space>
                                            <Button
                                              size="small"
                                              className="action-btn"
                                              onClick={() => {
                                                setHookDetailRecord(record);
                                                setHookDetailOpen(true);
                                              }}
                                            >
                                              查看详情
                                            </Button>
                                            <Button
                                              size="small"
                                              className="action-btn danger"
                                              onClick={() => handleDeleteHookRecord(record.id)}
                                            >
                                              删除
                                            </Button>
                                          </Space>
                                        ),
                                      },
                                    ]}
                                  />
                                  <Modal
                                    title={(
                                      <Space>
                                        <InfoCircleOutlined style={{ color: 'var(--ant-color-primary)' }} />
                                        <span>Hooks 记录详情</span>
                                      </Space>
                                    )}
                                    open={hookDetailOpen}
                                    onCancel={() => setHookDetailOpen(false)}
                                    footer={
                                      <Button onClick={() => setHookDetailOpen(false)}>关闭</Button>
                                    }
                                    destroyOnClose
                                    width={800}
                                    className="hook-detail-modal"
                                  >
                                    {hookDetailRecord && (
                                      <div className="hook-detail-content">
                                        <div className="hook-detail-grid">
                                          <div className="detail-item">
                                            <span className="detail-label">事件</span>
                                            <span className="detail-value">
                                              <Tag color="geekblue" style={{ margin: 0 }}>{hookDetailRecord.event_name}</Tag>
                                            </span>
                                          </div>
                                          <div className="detail-item">
                                            <span className="detail-label">时间</span>
                                            <span className="detail-value">{formatHookTime(hookDetailRecord.created_at)}</span>
                                          </div>
                                          <div className="detail-item">
                                            <span className="detail-label">结果</span>
                                            <span className="detail-value">
                                              <Tag style={{ margin: 0 }} color={hookDetailRecord.result === 'Success' || hookDetailRecord.result === 'OK' || hookDetailRecord.result === 'success' ? 'success' : (hookDetailRecord.result ? 'error' : 'default')}>
                                                {hookDetailRecord.result || '未知'}
                                              </Tag>
                                            </span>
                                          </div>
                                          <div className="detail-item">
                                            <span className="detail-label">会话 ID</span>
                                            <span className="detail-value">
                                              <Typography.Text copyable={{ text: hookDetailRecord.session_id }} style={{ fontFamily: 'monospace', color: 'inherit' }}>
                                                {hookDetailRecord.session_id}
                                              </Typography.Text>
                                            </span>
                                          </div>
                                        </div>

                                        <Divider style={{ margin: '16px 0' }} />

                                        <div className="detail-section">
                                          <div className="section-header">
                                            <h4 className="section-title">摘要</h4>
                                          </div>
                                          <div className="summary-box">
                                            {hookDetailRecord.notification_text || <span style={{ color: 'var(--text-tertiary)' }}>无摘要信息</span>}
                                          </div>
                                        </div>

                                        <div className="detail-section">
                                          <div className="section-header">
                                            <h4 className="section-title">详细内容</h4>
                                            <Button
                                              size="small"
                                              type="text"
                                              icon={<CopyOutlined />}
                                              onClick={() => {
                                                navigator.clipboard.writeText(hookDetailRecord.content);
                                                messageApi.success('已复制到剪贴板');
                                              }}
                                            >
                                              复制
                                            </Button>
                                          </div>
                                          <div className="code-box">
                                            <pre>{hookDetailRecord.content}</pre>
                                          </div>
                                        </div>

                                        <div className="detail-section">
                                          <div className="section-header">
                                            <h4 className="section-title">Transcript 路径</h4>
                                            <Button
                                              size="small"
                                              type="text"
                                              icon={<FolderOutlined />}
                                              onClick={async () => {
                                                try {
                                                  const dirPath = hookDetailRecord.transcript_path.substring(0, hookDetailRecord.transcript_path.lastIndexOf('/'));
                                                  await invoke('open_folder', { path: dirPath });
                                                } catch (error) {
                                                  messageApi.error(`无法打开文件夹: ${error}`);
                                                }
                                              }}
                                            >
                                              打开目录
                                            </Button>
                                          </div>
                                          <div className="path-box">
                                            <Typography.Text copyable={{ text: hookDetailRecord.transcript_path }} style={{ color: 'inherit', wordBreak: 'break-all', fontSize: '13px' }}>
                                              {hookDetailRecord.transcript_path}
                                            </Typography.Text>
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </Modal>
                                </div>
                              </Card>
                            ),
                          }] : []),
                          ...(showCoderIde ? [{
                            key: 'vscode',
                            label: (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <img src={codeIcon} width={18} height={18} alt="Coder IDE" />
                                <span>Coder IDE</span>
                              </div>
                            ),
                            closable: true,
                            children: (
                              <Card className="projects-card config-card" variant="borderless" style={{ flex: 1, height: '100%', padding: 0, overflow: 'hidden' }}>
                                <iframe
                                  src={`http://127.0.0.1:18080/?folder=${encodeURIComponent(selectedProject.path)}`}
                                  title="Coder IDE"
                                  style={{
                                    width: '100%',
                                    height: 'calc(100vh - 120px)',
                                    border: 'none',
                                    display: 'block',
                                  }}
                                  allow="clipboard-read; clipboard-write"
                                />
                              </Card>
                            )
                          }] : [])
                        ]}
                      />
                    </div>
                  </Card>
                </div>
              )}

              {activeMenu === 'settings' && (
                <div className="settings-page">
                  <div className="main-grid">
                    <div className="left-column">
                      <Form form={form} layout="vertical" onFinish={handleSave} className="config-form" style={{ marginTop: 0, display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <Tabs
                          defaultActiveKey="general"
                          className="settings-tabs"
                          style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
                          items={[
                            {
                              key: 'general',
                              label: '通用配置',
                              children: (
                                <Card className="projects-card general-card" variant="borderless" style={{ height: 'auto', flex: 1 }}>
                                  <div className="card-header">
                                    <SettingOutlined className="card-icon" />
                                    <h2>通用配置</h2>
                                  </div>
                                  <p className="card-description">应用相关的基础与功能配置</p>
                                  <Divider />
                                  <Form.Item
                                    label={
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                        <span>推送事件类型</span>
                                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal' }}>选择需要推送的事件类型</span>
                                      </div>
                                    }
                                    name="hook_events_filter"
                                    getValueFromEvent={(checkedValues: string[]) => checkedValues.length > 0 ? checkedValues.join(',') : undefined}
                                    getValueProps={(value: string | undefined) => ({
                                      value: value ? value.split(',').map((s: string) => s.trim()) : [],
                                    })}
                                    style={{ margin: 0 }}
                                  >
                                    <Checkbox.Group style={{ width: '100%' }}>
                                      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px' }}>
                                        <Card size="small" variant="borderless" style={{ background: 'var(--bg-secondary)', padding: '0 8px', borderRadius: '8px' }}>
                                          <Checkbox value="Stop">🛑 Stop（任务结束）</Checkbox>
                                        </Card>
                                        <Card size="small" variant="borderless" style={{ background: 'var(--bg-secondary)', padding: '0 8px', borderRadius: '8px' }}>
                                          <Checkbox value="PermissionRequest">🔐 PermissionRequest（权限确认）</Checkbox>
                                        </Card>
                                        <Card size="small" variant="borderless" style={{ background: 'var(--bg-secondary)', padding: '0 8px', borderRadius: '8px' }}>
                                          <Checkbox value="Notification">📌 Notification（通知）</Checkbox>
                                        </Card>
                                      </div>
                                    </Checkbox.Group>
                                  </Form.Item>


                                  <Divider style={{ margin: '24px 0 16px 0' }} />
                                  <Form.Item
                                    label={
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '24px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                          <span style={{ fontSize: '15px', fontWeight: 500 }}>终端界面配置</span>
                                        </div>
                                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 'normal' }}>自定义底部终端面板的背景、文字颜色与字体大小</span>
                                      </div>
                                    }
                                    style={{ margin: 0 }}
                                  >
                                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '8px' }}>
                                      <Card size="small" variant="borderless" style={{ background: 'var(--bg-secondary)', padding: '6px 12px', borderRadius: '8px', minWidth: '200px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '14px' }}>背景颜色</span>
                                            <Tag color={watchedBgColor ? (typeof watchedBgColor === 'string' ? watchedBgColor : watchedBgColor.toHexString()) : '#1e1e1e'} style={{ margin: 0, padding: '0 8px', borderRadius: '4px' }}>
                                              {watchedBgColor ? (typeof watchedBgColor === 'string' ? watchedBgColor : watchedBgColor.toHexString()) : '#1e1e1e'}
                                            </Tag>
                                          </div>
                                          <Form.Item name="terminal_bg_color" style={{ margin: 0 }}>
                                            <ColorPicker
                                              format="hex"
                                              disabledAlpha
                                            >
                                              <Button icon={<EditOutlined />} shape="circle" size="small" />
                                            </ColorPicker>
                                          </Form.Item>
                                        </div>
                                      </Card>
                                      <Card size="small" variant="borderless" style={{ background: 'var(--bg-secondary)', padding: '6px 12px', borderRadius: '8px', minWidth: '200px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '14px' }}>文字颜色</span>
                                            <Tag color={watchedFgColor ? (typeof watchedFgColor === 'string' ? watchedFgColor : watchedFgColor.toHexString()) : '#e0e0e0'} style={{ margin: 0, padding: '0 8px', borderRadius: '4px', color: '#1e1e1e' }}>
                                              {watchedFgColor ? (typeof watchedFgColor === 'string' ? watchedFgColor : watchedFgColor.toHexString()) : '#e0e0e0'}
                                            </Tag>
                                          </div>
                                          <Form.Item name="terminal_fg_color" style={{ margin: 0, marginLeft: '12px' }}>
                                            <ColorPicker
                                              format="hex"
                                              disabledAlpha
                                            >
                                              <Button icon={<EditOutlined />} shape="circle" size="small" />
                                            </ColorPicker>
                                          </Form.Item>
                                        </div>
                                      </Card>
                                      <Card size="small" variant="borderless" style={{ background: 'var(--bg-secondary)', padding: '6px 12px', borderRadius: '8px', minWidth: '300px', maxWidth: '450px', flex: 1 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                          <span style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>字体大小</span>
                                          <Form.Item name="terminal_font_size" style={{ margin: 0, flex: 1 }}>
                                            <Slider min={10} max={24} step={1} defaultValue={13} tooltip={{ formatter: (val) => `${val}px` }} style={{ margin: '14px 8px 10px 8px' }} />
                                          </Form.Item>
                                          <Tag style={{ margin: 0, padding: '0 8px', borderRadius: '4px', minWidth: '36px', textAlign: 'center' }}>
                                            {watchedFontSize ?? 13}px
                                          </Tag>
                                        </div>
                                      </Card>
                                    </div>
                                  </Form.Item>

                                  <Divider style={{ margin: '24px 0 16px 0' }} />
                                  <div className="action-buttons" style={{ marginTop: 0, display: 'flex', gap: '12px' }}>
                                    <Button type="primary" icon={<SaveOutlined />} onClick={() => handleSave(form.getFieldsValue())} loading={loading} size="large">保存设置</Button>
                                    <Button type="default" onClick={async () => {
                                      try {
                                        await invoke('save_window_size');
                                        messageApi.success('窗口大小已保存，下次启动生效');
                                      } catch (e) {
                                        messageApi.error(`保存窗口大小失败: ${e}`);
                                      }
                                    }} size="large">保存当前窗口为默认大小</Button>
                                  </div>

                                </Card>
                              )
                            },
                            {
                              key: 'channel',
                              label: '通知渠道配置',
                              children: (
                                <Card className="projects-card channel-card" variant="borderless" style={{ flex: 1, height: 'auto' }}>
                                  <div className="card-header">
                                    <ApiOutlined className="card-icon" />
                                    <h2>通知渠道配置</h2>
                                  </div>
                                  <p className="card-description">管理飞书、钉钉与企业微信的应用配置</p>
                                  <Divider />
                                  <div className="channel-block">
                                    <Tabs
                                      className="channel-tabs"
                                      defaultActiveKey="feishu"
                                      items={[
                                        {
                                          key: 'feishu',
                                          label: '飞书',
                                          children: (
                                            <div className="config-card" style={{ padding: '0 12px' }}>
                                              <h3 style={{ marginTop: 0 }}>飞书应用配置</h3>
                                              <p className="card-description" style={{ marginBottom: 16 }}>配置飞书开放平台应用凭证，启用长连接模式实现消息推送与接收</p>

                                              <Form.Item label="应用名称" name="app_name" tooltip="为你的应用起一个好记的名字" rules={[{ required: true, message: '请输入应用名称' }]}>
                                                <Input placeholder="例如：Sparky 生产环境" size="large" className="input-field" />
                                              </Form.Item>
                                              <Form.Item label="App ID" name="app_id" rules={[{ required: true, message: '请输入 App ID' }]}>
                                                <Input placeholder="cli_xxxxxxxxxxxxxxxx" size="large" className="input-field" />
                                              </Form.Item>
                                              <Form.Item label="App Secret" name="app_secret" rules={[{ required: true, message: '请输入 App Secret' }]}>
                                                <Input.Password placeholder="应用密钥" size="large" className="input-field" />
                                              </Form.Item>
                                              <Form.Item label="默认群聊 ID" name="chat_id" extra="可选">
                                                <Input placeholder="oc_xxxxxxxxxxxxxxxxxxxxxxxx" size="large" className="input-field" />
                                              </Form.Item>
                                              {tauriAvailable && appConfig && !appConfig.chat_id && !appConfig.open_id && (
                                                <div style={{ marginBottom: 16, padding: '10px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 13, color: 'var(--text-primary)' }}>
                                                  💡 未配置群聊 ID 也未绑定个人账号。请在飞书中向 <strong>{appConfig.app_name || 'Sparky'}</strong> 机器人发送任意消息，系统将自动绑定你的账号用于消息推送。
                                                </div>
                                              )}
                                              <Form.Item label="Encrypt Key" name="encrypt_key" extra="可选">
                                                <Input.Password placeholder="加密密钥" size="large" className="input-field" />
                                              </Form.Item>
                                              <Form.Item label="Verification Token" name="verification_token" extra="可选">
                                                <Input.Password placeholder="验证令牌" size="large" className="input-field" />
                                              </Form.Item>

                                              <div className="action-buttons">
                                                <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading} size="large">保存设置</Button>
                                                <Button type="default" icon={<ApiOutlined />} onClick={handleTestConnection} loading={testingConnection} size="large">测试连接</Button>
                                                <Button type="default" onClick={handleUploadAnthropicLogo} loading={uploadingLogo} size="large">使用 Anthropic Logo</Button>
                                              </div>
                                            </div>
                                          ),
                                        },
                                        {
                                          key: 'dingtalk',
                                          label: '钉钉',
                                          children: (
                                            <div className="config-card" style={{ padding: '0 12px' }}>
                                              <h3 style={{ marginTop: 0 }}>钉钉应用配置</h3>
                                              <p className="card-description">等待开发</p>
                                            </div>
                                          ),
                                        },
                                        {
                                          key: 'wework',
                                          label: '企业微信',
                                          children: (
                                            <div className="config-card" style={{ padding: '0 12px' }}>
                                              <h3 style={{ marginTop: 0 }}>企业微信应用配置</h3>
                                              <p className="card-description">等待开发</p>
                                            </div>
                                          ),
                                        },
                                      ]}
                                    />
                                  </div>
                                </Card>
                              )
                            }
                          ]}
                        />
                      </Form>
                    </div>
                  </div>
                </div>
              )}

              {activeMenu === 'help' && (
                <div className="help-page">
                  <div className="main-grid">
                    <div className="left-column">
                      <Card variant="borderless">
                        <h3>快速开始</h3>
                        <ol className="steps-list">
                          <li><span className="step-number">1</span><span className="step-text">创建飞书开放平台应用</span></li>
                          <li><span className="step-number">2</span><span className="step-text">开启机器人能力并配置权限</span></li>
                          <li><span className="step-number">3</span><span className="step-text">复制应用凭证到设置页面</span></li>
                          <li><span className="step-number">4</span><span className="step-text">在项目管理中添加项目</span></li>
                          <li><span className="step-number">5</span><span className="step-text">为项目安装消息推送服务</span></li>
                        </ol>
                      </Card>
                      <Card variant="borderless">
                        <h3>所需权限</h3>
                        <div className="permissions-list">
                          <div className="permission-item"><code>im:message</code><span>获取与发送消息</span></div>
                          <div className="permission-item"><code>im:message.group_at_msg</code><span>接收群聊@消息</span></div>
                          <div className="permission-item"><code>im:message.p2p_msg</code><span>接收单聊消息</span></div>
                        </div>
                      </Card>
                    </div>
                    <div className="right-column">
                      <Card className="about-card" variant="borderless">
                        <h3>关于 Sparky</h3>
                        <p>Sparky 是一个集成了 Claude Code 与飞书的桌面应用，可以实时监控 Claude Code 的运行状态，并通过飞书发送通知。</p>
                        <Divider />
                        <p className="version-info">版本: 0.1.0</p>
                      </Card>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main >

        <Modal
          title={(
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <WarningOutlined style={{ color: '#faad14', fontSize: '20px' }} />
              <span>缺少必要依赖环境</span>
            </div>
          )}
          open={missingDependencies !== null}
          onCancel={() => setMissingDependencies(null)}
          footer={[
            <Button key="close" type="primary" onClick={() => setMissingDependencies(null)}>
              我知道了
            </Button>
          ]}
          width={500}
        >
          <div style={{ marginTop: '16px', fontSize: '14px', lineHeight: '1.6' }}>
            <p>Sparky 需要以下全局工具才能正常运行。检测到您的系统缺少以下依赖：</p>

            {missingDependencies && !missingDependencies.claude && (
              <div style={{ marginTop: '16px', background: 'var(--bg-secondary)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <img src={claudeIcon} width={16} height={16} alt="Claude" />
                  Claude Code (必须)
                </h4>
                <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--text-secondary)' }}>用于在终端中执行 AI 交互逻辑。</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <code style={{ flex: 1, padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }}>npm install -g @anthropic-ai/claude-code</code>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText('npm install -g @anthropic-ai/claude-code')} />
                </div>
              </div>
            )}

            {missingDependencies && !missingDependencies.code_server && (
              <div style={{ marginTop: '16px', background: 'var(--bg-secondary)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <h4 style={{ margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <img src={codeIcon} width={16} height={16} alt="IDE" />
                  Coder IDE (必须)
                </h4>
                <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--text-secondary)' }}>用于提供沉浸式的项目内联编辑器体验。</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <code style={{ flex: 1, padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }}>brew install code-server</code>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText('brew install code-server')} />
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>或使用 npm:</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <code style={{ flex: 1, padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }}>npm install -g code-server</code>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText('npm install -g code-server')} />
                  </div>
                </div>
              </div>
            )}

            <p style={{ marginTop: '20px', color: 'var(--text-tertiary)', fontSize: '13px' }}>
              请在操作系统的终端中运行上述安装命令。安装完成后，您需要<strong>完全重新启动</strong> Sparky 以使环境变量生效。
            </p>
          </div>
        </Modal>

      </div >
    </ConfigProvider >
  );
}

function App() {
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    localStorage.setItem('theme', isDarkMode ? 'dark' : 'light');
    if (isDarkMode) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }, [isDarkMode]);

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: isDarkMode ? '#ffffff' : '#000000',
          colorBgBase: isDarkMode ? '#1e1e1e' : '#ffffff',
          colorTextBase: isDarkMode ? '#e0e0e0' : '#000000',
        },
        components: {
          Button: {
            primaryColor: isDarkMode ? '#000' : '#fff',
            contentFontSize: 14,
          },
          Tabs: {
            itemColor: isDarkMode ? '#a0a0a0' : '#000000',
            itemSelectedColor: isDarkMode ? '#ffffff' : '#ffffff',
            itemHoverColor: isDarkMode ? '#ffffff' : '#000000',
          }
        }
      }}
    >
      <AntApp>
        <AppContent isDarkMode={isDarkMode} setIsDarkMode={setIsDarkMode} />
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
