import { useState, useEffect, useRef } from 'react';
import { Form, Input, Button, Card, Divider, Tag, Table, Empty, List, Modal, Space, Menu, Tabs, Checkbox, ConfigProvider, theme, Switch, App as AntApp, Typography, Tooltip, ColorPicker, Slider, Dropdown, Splitter, Popconfirm, Select, Badge, Alert } from 'antd';
import { SaveOutlined, ApiOutlined, SettingOutlined, DeleteOutlined, EyeOutlined, FolderOutlined, SunOutlined, MoonOutlined, PlusOutlined, ProjectOutlined, FullscreenOutlined, FullscreenExitOutlined, PoweroffOutlined, InfoCircleOutlined, CopyOutlined, ReloadOutlined, EditOutlined, HistoryOutlined, PlayCircleOutlined, ExperimentOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, ThunderboltOutlined, CheckOutlined, CloseOutlined, ArrowDownOutlined, MenuOutlined, WarningOutlined, SafetyCertificateOutlined, CompressOutlined, ClearOutlined, UndoOutlined, FileTextOutlined, DownloadOutlined, AppstoreAddOutlined } from '@ant-design/icons';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

import TerminalComponent from './components/Terminal';
import ChatView from './components/chat/ChatView';
import ContextDonut from './components/ContextDonut';
import logo from '../../logo.png';
import codeIcon from './assets/Code.svg';
import claudeIcon from './assets/Claude.svg';
import claudeDeactiveIcon from './assets/claude-deactive.svg';
import feishuIcon from './assets/飞书.svg';
import './App.css';

interface IDEPlugin {
  id: string;
  name: string;
  desc: string;
  created_at?: number | null;
}

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
  default_provider_id?: string;
}

interface AIProvider {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  website_url?: string;
  category?: string;
  created_at?: number;
  sort_index?: number;
  notes?: string;
  icon?: string;
  icon_color?: string;
  meta: string;
  is_current: boolean;
  in_failover_queue: boolean;
  cost_multiplier: string;
  limit_daily_usd?: string;
  limit_monthly_usd?: string;
  provider_type?: string;
  endpoints: AIProviderEndpoint[];
}

interface AIProviderEndpoint {
  id?: number;
  provider_id: string;
  app_type: string;
  url: string;
  added_at?: number;
}

interface Project {
  id: number;
  name: string;
  path: string;
  hooks_installed: boolean;
  agent_teams_enabled?: boolean;
  default_provider_id?: string;
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

const LAST_PROVIDER_BY_PROJECT_STORAGE_KEY = 'sparky-last-provider-by-project';
const LAST_ACTIVE_MENU_STORAGE_KEY = 'sparky-last-active-menu';
const LAST_SELECTED_PROJECT_PATH_STORAGE_KEY = 'sparky-last-selected-project-path';
const TERMINAL_TABS_STORAGE_KEY = 'sparky-terminal-tabs';
const ACTIVE_TERMINAL_ID_STORAGE_KEY = 'sparky-active-terminal-id';

const ModelListInput = ({ value = [], onChange }: { value?: string[], onChange?: (val: string[]) => void }) => {
  const [inputValue, setInputValue] = useState('');

  const handleAdd = () => {
    if (inputValue.trim() && !value.includes(inputValue.trim())) {
      onChange?.([...value, inputValue.trim()]);
      setInputValue('');
    }
  };

  const handleRemove = (v: string) => {
    onChange?.(value.filter(item => item !== v));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <Input
          placeholder="例如: claude-3-5-sonnet-20241022"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onPressEnter={(e) => {
            e.preventDefault();
            handleAdd();
          }}
        />
        <Button icon={<PlusOutlined />} onClick={handleAdd}>添加</Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {value.map(v => (
          <Tag key={v} closable onClose={() => handleRemove(v)} style={{ margin: 0 }}>
            {v}
          </Tag>
        ))}
      </div>
    </div>
  );
};

function AppContent({ isDarkMode, setIsDarkMode }: { isDarkMode: boolean, setIsDarkMode: (v: boolean) => void }) {
  const { message: messageApi, modal: modalApi, notification: notificationApi } = AntApp.useApp();
  const [form] = Form.useForm();
  const [providerForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string>('project');
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<Record<string, string[]>>({});
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [terminalStateReady, setTerminalStateReady] = useState(false);

  interface TerminalTab {
    id: string;
    title: string | React.ReactNode;
    providerId?: string;
    selectedModelId?: string;
  }

  interface IDETab {
    id: string;
    title: string;
    url: string;
    type: 'code-server' | 'webview';
    closable?: boolean;
  }

  const [projectTerminals, setProjectTerminals] = useState<Record<string, TerminalTab[]>>({});
  const [ideTabs, setIdeTabs] = useState<Record<string, IDETab[]>>({});
  const [activeIdeTabId, setActiveIdeTabId] = useState<Record<string, string>>({});
  const [newTabModalOpen, setNewTabModalOpen] = useState(false);
  const [newTabUrl, setNewTabUrl] = useState('');
  const [tabLoadErrors, setTabLoadErrors] = useState<Record<string, boolean>>({});
  const [ideTabReloadKeys, setIdeTabReloadKeys] = useState<Record<string, number>>({});
  const [recentProjectUrls, setRecentProjectUrls] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<AIProvider[]>([]);

  const [selectedProviderKeys, setSelectedProviderKeys] = useState<React.Key[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [refreshingProviders, setRefreshingProviders] = useState(false);
  const [duplicatingProviderKey, setDuplicatingProviderKey] = useState<string | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Partial<AIProvider> | null>(null);
  const [testingProvider, setTestingProvider] = useState(false);
  const [activeTerminalId, setActiveTerminalId] = useState<Record<string, string>>({});
  const [createTerminalModalOpen, setCreateTerminalModalOpen] = useState(false);
  const [newTerminalProviderId, setNewTerminalProviderId] = useState<string>();
  const [newTerminalModelId, setNewTerminalModelId] = useState<string>();
  const [testModelId, setTestModelId] = useState<string>();
  const [showDetailTab, setShowDetailTab] = useState<Record<string, boolean>>({});
  const [lastProviderByProject, setLastProviderByProject] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem(LAST_PROVIDER_BY_PROJECT_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [lastModelByProject, setLastModelByProject] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('sparky-last-model-by-project');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

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
  const watchedModelIds = Form.useWatch('model_ids', providerForm);

  const tauriAvailable = isTauri();
  const terminalRefs = useRef<Record<string, { scrollToBottom: () => void }>>({});
  const inputBufferRef = useRef<Record<string, string>>({});
  const [lastCommand, setLastCommand] = useState<Record<string, string>>({});
  const [wsConnected, setWsConnected] = useState(false);
  const [activeProjects, setActiveProjects] = useState<string[]>([]);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);
  const hasRestoredSelectionRef = useRef(false);
  const hasRestoredTerminalStateRef = useRef(false);
  const sidebarCollapsed = false;
  const [splitterSizes, setSplitterSizes] = useState<number[] | string[]>(() => {
    try {
      const saved = localStorage.getItem('sparkySplitterSizes');
      if (saved) return JSON.parse(saved);
    } catch { /* ignore */ }
    return ['50%', '50%'];
  });
  const recentUrlsForProject = selectedProject ? (recentProjectUrls[selectedProject.path] || []) : [];

  useEffect(() => {
    if (tauriAvailable) {
      invoke<AIProvider[]>('get_ai_providers').then(res => {
        setProviders(res);
      }).catch(e => console.error('Failed to fetch AI providers:', e));
    }
  }, [tauriAvailable]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timeoutId: NodeJS.Timeout;

    if (isTauri()) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().onResized(() => {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(async () => {
            try {
              await invoke('save_window_size');
            } catch (e) {
              console.error('Auto-save window size failed:', e);
            }
          }, 500);
        }).then(unbind => {
          unlisten = unbind;
        });
      });
    }

    return () => {
      clearTimeout(timeoutId);
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

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
  const [codeServerConnected, setCodeServerConnected] = useState<boolean | null>(null);
  const [codeServerPort, setCodeServerPort] = useState<number>(18080);
  const [ideRestarting, setIdeRestarting] = useState(false);

  // IDE Plugins state
  const [idePlugins, setIdePlugins] = useState<string[]>([]);
  const [idePluginList, setIdePluginList] = useState<IDEPlugin[]>([]);
  const [installingPlugin, setInstallingPlugin] = useState<string | null>(null);
  const [customPluginId, setCustomPluginId] = useState('');

  // Track terminal vs chat view modes per terminal id
  const [viewModes] = useState<Record<string, 'terminal' | 'chat'>>({});
  const [terminalStatus, setTerminalStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!tauriAvailable) return;

    const poll = async () => {
      const allTerminals = Object.values(projectTerminals).flat();
      if (allTerminals.length === 0) return;

      const newStatus: Record<string, string> = { ...terminalStatus };
      let changed = false;

      await Promise.all(allTerminals.map(async (term) => {
        try {
          const status = await invoke<string>('get_terminal_active_process', { terminal_id: term.id });
          if (newStatus[term.id] !== status) {
            newStatus[term.id] = status;
            changed = true;
          }
        } catch (e) {
          if (newStatus[term.id] !== 'offline') {
            newStatus[term.id] = 'offline';
            changed = true;
          }
        }
      }));

      if (changed) {
        setTerminalStatus(newStatus);
      }
    };

    const interval = setInterval(poll, 3000);
    poll(); // Initial check

    return () => clearInterval(interval);
  }, [tauriAvailable, projectTerminals]);

  useEffect(() => {
    localStorage.setItem(LAST_PROVIDER_BY_PROJECT_STORAGE_KEY, JSON.stringify(lastProviderByProject));
  }, [lastProviderByProject]);

  // Dependency check
  const [missingDependencies, setMissingDependencies] = useState<{ claude: boolean, code_server: boolean } | null>(null);

  useEffect(() => {
    localStorage.setItem('sparky-full-auth', JSON.stringify(fullAuth));
  }, [fullAuth]);

  // Get code server port on mount
  useEffect(() => {
    if (tauriAvailable) {
      invoke<number>('code_server_port').then(setCodeServerPort).catch(() => {});
    }
  }, [tauriAvailable]);

  useEffect(() => {
    console.info('[IDE] AppContent mounted');
    return () => {
      console.info('[IDE] AppContent unmounted');
    };
  }, []);

  useEffect(() => {
    console.info('[IDE] activeMenu changed:', activeMenu);
    if (hasRestoredSelectionRef.current) {
      localStorage.setItem(LAST_ACTIVE_MENU_STORAGE_KEY, activeMenu);
    }
  }, [activeMenu]);

  useEffect(() => {
    console.info('[IDE] selectedProject changed:', selectedProject?.path ?? null);
    if (hasRestoredSelectionRef.current) {
      localStorage.setItem(LAST_SELECTED_PROJECT_PATH_STORAGE_KEY, selectedProject?.path ?? '');
    }
  }, [selectedProject]);

  useEffect(() => {
    console.info('[IDE] activeProjects changed:', activeProjects);
  }, [activeProjects]);

  useEffect(() => {
    console.info('[IDE] connection state:', {
      codeServerConnected,
      ideRestarting
    });
  }, [codeServerConnected, ideRestarting]);

  // Check dependencies once on mount
  const isCheckingDependenciesRef = useRef(false);
  useEffect(() => {
    if (!tauriAvailable || isCheckingDependenciesRef.current) return;
    isCheckingDependenciesRef.current = true;
    invoke<{ claude: boolean, code_server: boolean }>('check_dependencies')
      .then(async (status) => {
        if (!status.claude || !status.code_server) {
          if (!status.code_server) {
            const hide = messageApi.loading('正在安装必要依赖 Coder IDE ...', 0);
            try {
              await invoke('install_code_server');
              hide();
              messageApi.success('Coder IDE 安装成功');
              status.code_server = true;
            } catch (err) {
              hide();
              messageApi.error(`Coder IDE 安装失败: ${err}`);
            }
          }
          if (!status.claude || !status.code_server) {
            setMissingDependencies(status);
          }
        }
      })
      .catch((e) => {
        console.error('Failed to check dependencies:', e);
        isCheckingDependenciesRef.current = false;
      });
  }, [tauriAvailable, messageApi]);

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

  // Listen for messages from the code-server extension
  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'project-detail' || !selectedProject) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SEND_TO_TERMINAL' && event.data.code) {
        const activeTid = activeTerminalId[selectedProject.path];
        if (activeTid) {
          // Remove newlines and carriage returns to prevent immediate execution of multi-line strings
          const safeData = event.data.code.replace(/[\r\n]+/g, ' ');
          invoke('pty_write', { terminal_id: activeTid, data: safeData })
            .catch(err => console.error('Failed to write to terminal:', err));
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [activeMenu, selectedProject, activeTerminalId, tauriAvailable]);

  // Sync active terminal ID to backend for HTTP endpoint (extension -> terminal)
  useEffect(() => {
    if (!tauriAvailable || !selectedProject) return;
    const activeTid = activeTerminalId[selectedProject.path];
    if (activeTid) {
      invoke('set_active_terminal_id', { terminal_id: activeTid })
        .catch(err => console.error('Failed to set active terminal ID:', err));
    }
  }, [activeTerminalId, selectedProject, tauriAvailable]);

  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'project-detail' || !selectedProject) {
      return;
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

  // Fetch IDE plugins when the menu is active
  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'ide-plugins') return;
    invoke<string[]>('get_installed_code_server_extensions')
      .then(setIdePlugins)
      .catch(err => console.error('Failed to get installed code-server extensions:', err));
    invoke<IDEPlugin[]>('get_ide_plugins')
      .then(setIdePluginList)
      .catch(err => console.error('Failed to get IDE plugins:', err));
  }, [activeMenu, tauriAvailable]);

  // Sync providerForm with editingProvider when the modal opens or the provider changes
  useEffect(() => {
    if (providerModalOpen) {
      if (editingProvider) {
        let settings: any = {};
        try {
          if (editingProvider.settings_config) {
            settings = JSON.parse(editingProvider.settings_config);
          }
        } catch (e) {
          console.error('Failed to parse settings_config:', e);
        }

        // Handle migration from model_id to model_ids
        let modelIds = settings.model_ids;
        if (!modelIds || modelIds.length === 0) {
          const legacyModelId = settings.model_id || settings.env?.ANTHROPIC_MODEL;
          modelIds = legacyModelId ? [legacyModelId] : [];
        }

        providerForm.setFieldsValue({
          ...editingProvider,
          ...settings,
          model_ids: modelIds
        });
      } else {
        providerForm.resetFields();
      }
    }
  }, [providerModalOpen, editingProvider, providerForm]);

  // Check code-server connection when entering project detail or when marked as disconnected
  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'project-detail' || !selectedProject || codeServerConnected === true) {
      return;
    }

    let intervalId: NodeJS.Timeout;

    const checkConnection = async () => {
      try {
        const connected = await invoke<boolean>('check_code_server_connection');
        if (connected) {
          setCodeServerConnected(true);
          if (ideRestarting) {
            setIdeRestarting(false);
          }
        }
      } catch (err) {
        console.error('Failed to check code-server connection:', err);
      }
    };

    checkConnection();
    intervalId = setInterval(checkConnection, 2000);

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [activeMenu, selectedProject, tauriAvailable, codeServerConnected, ideRestarting]);

  const handleRestartIDE = async () => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中使用此功能');
      return;
    }
    if (ideRestarting) return;
    console.info('[IDE] handleRestartIDE');
    setIdeRestarting(true);
    setCodeServerConnected(false);
    try {
      await invoke('restart_code_server');
      messageApi.success('IDE 重启中...');
    } catch (err) {
      messageApi.error(`重启 IDE 失败: ${err}`);
      setIdeRestarting(false);
      setCodeServerConnected(false);
    }
  };

  const handleOpenIdeInNewWindow = async () => {
    if (!selectedProject) return;
    const url = `http://localhost:${codeServerPort}/?folder=${encodeURIComponent(selectedProject.path)}`;
    if (!tauriAvailable) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const label = `ide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const webview = new WebviewWindow(label, {
        url,
        title: `IDE - ${selectedProject.name}`,
        width: 1400,
        height: 900
      });
      webview.once('tauri://error', (e) => {
        console.error('Failed to open IDE window:', e);
        messageApi.error('打开新窗口失败');
      });
    } catch (err) {
      console.error('Failed to open IDE window:', err);
      messageApi.error(`打开新窗口失败: ${err}`);
      window.open(url, '_blank', 'noopener');
    }
  };

  const handleOpenIdeInBrowser = async () => {
    if (!selectedProject) return;
    const url = `http://localhost:${codeServerPort}/?folder=${encodeURIComponent(selectedProject.path)}`;
    if (!tauriAvailable) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    try {
      const { open: shellOpen } = await import('@tauri-apps/plugin-shell');
      await shellOpen(url);
    } catch (err) {
      console.error('Failed to open IDE in browser:', err);
      messageApi.error(`浏览器打开失败: ${err}`);
      window.open(url, '_blank', 'noopener');
    }
  };

  const fetchRecentProjectUrls = async (projectPath: string) => {
    if (!tauriAvailable) {
      setRecentProjectUrls(prev => ({
        ...prev,
        [projectPath]: prev[projectPath] || []
      }));
      return;
    }
    try {
      const urls = await invoke<string[]>('get_recent_project_urls', { project_path: projectPath });
      setRecentProjectUrls(prev => ({
        ...prev,
        [projectPath]: urls || []
      }));
    } catch (err) {
      console.error('Failed to fetch recent project urls:', err);
      setRecentProjectUrls(prev => ({
        ...prev,
        [projectPath]: []
      }));
    }
  };

  const recordRecentProjectUrl = async (projectPath: string, url: string) => {
    if (!tauriAvailable) return;
    try {
      await invoke('record_recent_project_url', { project_path: projectPath, url });
    } catch (err) {
      console.error('Failed to record recent project url:', err);
    }
  };

  const pushRecentProjectUrl = (projectPath: string, url: string) => {
    setRecentProjectUrls(prev => {
      const current = prev[projectPath] || [];
      const next = [url, ...current.filter(item => item !== url)].slice(0, 10);
      return { ...prev, [projectPath]: next };
    });
  };

  const createIdeTabFromUrl = (rawUrl?: string) => {
    if (!selectedProject) return;
    const inputUrl = (rawUrl ?? newTabUrl).trim();
    if (!inputUrl) {
      messageApi.warning('请输入 URL');
      return;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(inputUrl);
    } catch (error) {
      messageApi.error('请输入有效的 URL（例如：https://github.com）');
      return;
    }
    const normalizedUrl = parsedUrl.toString();
    const newTab: IDETab = {
      id: `webview-${Date.now()}`,
      title: parsedUrl.hostname || 'New Tab',
      url: normalizedUrl,
      type: 'webview',
      closable: true
    };
    setIdeTabs(prev => ({
      ...prev,
      [selectedProject.path]: [...(prev[selectedProject.path] || []), newTab]
    }));
    setActiveIdeTabId(prev => ({ ...prev, [selectedProject.path]: newTab.id }));
    setNewTabModalOpen(false);
    setNewTabUrl('');
    setTabLoadErrors(prev => ({ ...prev, [newTab.id]: false }));
    pushRecentProjectUrl(selectedProject.path, normalizedUrl);
    recordRecentProjectUrl(selectedProject.path, normalizedUrl);
  };

  useEffect(() => {
    if (!newTabModalOpen || !selectedProject) return;
    fetchRecentProjectUrls(selectedProject.path);
  }, [newTabModalOpen, selectedProject, tauriAvailable]);

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
    console.info('[IDE] handleEnterProject:', project.path);
    setSelectedProject(project);
    setActiveMenu('project-detail');
    setCodeServerConnected(false); // Reset connection status to trigger polling and loading UI
    // Immediately show project as "running" without waiting for the next poll
    setActiveProjects(prev =>
      prev.includes(project.path) ? prev : [...prev, project.path]
    );

    // ========== IDE 标签页初始化 ==========
    setIdeTabs(prev => {
      if (prev[project.path]) return prev;
      const defaultTab: IDETab = {
        id: 'code-server',
        title: 'Code IDE',
        url: `http://localhost:${codeServerPort}/?folder=${encodeURIComponent(project.path)}`,
        type: 'code-server',
        closable: false
      };
      return { ...prev, [project.path]: [defaultTab] };
    });
    setActiveIdeTabId(prev => (prev[project.path] ? prev : { ...prev, [project.path]: 'code-server' }));
  };

  useEffect(() => {
    if (hasRestoredSelectionRef.current) return;

    if (selectedProject || activeMenu === 'project-detail') {
      hasRestoredSelectionRef.current = true;
      return;
    }

    const lastMenu = localStorage.getItem(LAST_ACTIVE_MENU_STORAGE_KEY);
    const lastProjectPath = localStorage.getItem(LAST_SELECTED_PROJECT_PATH_STORAGE_KEY);

    if (lastMenu !== 'project-detail' || !lastProjectPath) {
      hasRestoredSelectionRef.current = true;
      return;
    }

    if (projects.length === 0) {
      return;
    }

    const project = projects.find(p => p.path === lastProjectPath);
    if (project) {
      console.info('[IDE] restore project detail:', project.path);
      handleEnterProject(project);
    }

    hasRestoredSelectionRef.current = true;
  }, [projects, selectedProject, activeMenu]);

  useEffect(() => {
    if (hasRestoredTerminalStateRef.current) return;
    if (!projectsLoaded) return;

    if (projects.length === 0) {
      hasRestoredTerminalStateRef.current = true;
      setTerminalStateReady(true);
      return;
    }

    const projectPaths = new Set(projects.map(p => p.path));
    let restoredTabs: Record<string, TerminalTab[]> = {};
    let restoredActiveIds: Record<string, string> = {};

    try {
      const rawTabs = localStorage.getItem(TERMINAL_TABS_STORAGE_KEY);
      if (rawTabs) {
        const parsedTabs = JSON.parse(rawTabs) as Record<string, TerminalTab[]>;
        Object.entries(parsedTabs || {}).forEach(([path, tabs]) => {
          if (!projectPaths.has(path) || !Array.isArray(tabs)) return;
          restoredTabs[path] = tabs
            .filter(tab => tab && typeof tab.id === 'string')
            .map((tab, index) => ({
              id: tab.id,
              title: typeof tab.title === 'string' ? tab.title : `终端-${index + 1}`,
              providerId: tab.providerId,
              selectedModelId: tab.selectedModelId
            }));
        });
      }
    } catch (error) {
      console.warn('Failed to restore terminal tabs:', error);
    }

    try {
      const rawActiveIds = localStorage.getItem(ACTIVE_TERMINAL_ID_STORAGE_KEY);
      if (rawActiveIds) {
        restoredActiveIds = JSON.parse(rawActiveIds) as Record<string, string>;
      }
    } catch (error) {
      console.warn('Failed to restore active terminal ids:', error);
    }

    if (Object.keys(projectTerminals).length === 0 && Object.keys(restoredTabs).length > 0) {
      setProjectTerminals(restoredTabs);
    }

    if (Object.keys(activeTerminalId).length === 0 && Object.keys(restoredTabs).length > 0) {
      const nextActiveIds: Record<string, string> = {};
      Object.entries(restoredTabs).forEach(([path, tabs]) => {
        const activeId = restoredActiveIds[path];
        if (activeId && tabs.some(tab => tab.id === activeId)) {
          nextActiveIds[path] = activeId;
        } else if (tabs[0]) {
          nextActiveIds[path] = tabs[0].id;
        }
      });
      if (Object.keys(nextActiveIds).length > 0) {
        setActiveTerminalId(nextActiveIds);
      }
    }

    hasRestoredTerminalStateRef.current = true;
    setTerminalStateReady(true);
  }, [projectsLoaded, projects]);

  const openCreateTerminalModal = () => {
    if (!selectedProject) return;

    if (providers.length === 0) {
      messageApi.warning('请先添加至少一个 AI Provider');
      return;
    }

    const lastProvider = lastProviderByProject[selectedProject.path];
    const lastProviderExists = !!lastProvider && providers.some(p => `${p.app_type}::${p.id}` === lastProvider);
    const providerId = lastProviderExists ? lastProvider : undefined;
    setNewTerminalProviderId(providerId);

    if (providerId) {
      const provider = providers.find(p => `${p.app_type}::${p.id}` === providerId);
      if (provider) {
        try {
          const settings = JSON.parse(provider.settings_config);
          const models = (settings.model_ids && settings.model_ids.length > 0) ? settings.model_ids : (settings.model_id ? [settings.model_id] : []);
          // 优先使用上次选择的 model,如果不存在则使用第一个
          const lastModel = lastModelByProject[selectedProject.path];
          const lastModelExists = lastModel && models.includes(lastModel);
          setNewTerminalModelId(lastModelExists ? lastModel : models[0]);
        } catch (e) {
          setNewTerminalModelId(undefined);
        }
      }
    }

    setCreateTerminalModalOpen(true);
  };

  const handleConfirmCreateTerminal = () => {
    if (!selectedProject || !newTerminalProviderId) return;

    const current = projectTerminals[selectedProject.path] || [];
    const newId = crypto.randomUUID();
    setProjectTerminals(prev => ({
      ...prev,
      [selectedProject.path]: [...current, {
        id: newId,
        title: `Claude-${current.length + 1}`,
        providerId: newTerminalProviderId,
        selectedModelId: newTerminalModelId
      }]
    }));
    setActiveTerminalId(prev => ({
      ...prev,
      [selectedProject.path]: newId
    }));
    setCreateTerminalModalOpen(false);
    setNewTerminalProviderId(undefined);
    setNewTerminalModelId(undefined);
    setLastProviderByProject(prev => {
      const next = { ...prev, [selectedProject.path]: newTerminalProviderId };
      localStorage.setItem('lastProviderByProject', JSON.stringify(next));
      return next;
    });
    // 保存上次选择的 model
    if (newTerminalModelId) {
      setLastModelByProject(prev => {
        const next = { ...prev, [selectedProject.path]: newTerminalModelId };
        localStorage.setItem('sparky-last-model-by-project', JSON.stringify(next));
        return next;
      });
    }
  };


  const handleCloseTerminal = async () => {
    if (!selectedProject || !tauriAvailable) return;
    console.info('[IDE] handleCloseTerminal:', selectedProject.path);
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
      messageApi.error(`关闭终端失败: ${e} `);
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
      messageApi.error(`加载配置失败: ${error} `);
    }
  };

  const fetchProjects = async () => {
    setProjectsLoaded(false);
    if (!tauriAvailable) {
      setProjects([]);
      setProjectsLoaded(true);
      return;
    }
    try {
      const projectsData = await invoke<Project[]>('get_projects');
      setProjects(projectsData);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setProjectsLoaded(true);
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
      messageApi.error(`加载 Hooks 记录失败: ${error} `);
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
          messageApi.error(`删除失败: ${error} `);
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
          messageApi.error(`批量删除失败: ${error} `);
        }
      },
    });
  };

  const handleSetDefaultProvider = async (id: string, app_type: string) => {
    if (!appConfig) return;
    // 在我们的 AppConfig 里暂存这个 ID (由于 AppConfig 的 default_provider_id 是 i64，这里需要考虑兼容性，临时改为 string 或者映射, 修改为 ${app_type}::${id})
    const newConfig = { ...appConfig, default_provider_id: `${app_type}::${id}` } as AppConfig;
    try {
      await invoke('save_config', { config: newConfig });
      setAppConfig(newConfig);
      form.setFieldsValue(newConfig);
      notificationApi.success({
        message: '设置成功',
        description: '已更新默认 AI Provider',
        placement: 'topRight',
        duration: 2,
      });
    } catch (e) {
      notificationApi.error({
        message: '操作失败',
        description: `无法设置默认 Provider: ${e}`,
        placement: 'topRight',
        duration: 4,
      });
    }
  };

  const buildClaudeCmd = async (terminalId: string, extraArgs: string = ''): Promise<string> => {
    let settingsFlag = '';
    try {
      const settingsPath = await invoke<string>('get_terminal_settings_path', { terminal_id: terminalId });
      if (settingsPath) settingsFlag = ` --settings "${settingsPath}"`;
    } catch {
      console.warn('No settings path for terminal, launching claude without --settings');
    }
    return `claude${settingsFlag}${extraArgs ? ' ' + extraArgs : ''}\n`;
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
      notificationApi.success({
        message: '保存成功',
        description: '您的配置已成功同步到系统',
        placement: 'topRight',
        duration: 2,
      });
    } catch (error) {
      notificationApi.error({
        message: '保存失败',
        description: `错误原因: ${error}`,
        placement: 'topRight',
        duration: 4,
      });
    } finally {
      setLoading(false);
    }
  };

  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleRefreshProviders = async () => {
    setRefreshingProviders(true);
    try {
      const res = await invoke<AIProvider[]>('get_ai_providers');
      setProviders(res);
      messageApi.success('列表已刷新');
    } catch (e) {
      messageApi.error(`刷新失败: ${e}`);
    } finally {
      setRefreshingProviders(false);
    }
  };

  const handleDuplicateProvider = async (record: AIProvider) => {
    const duplicateKey = `${record.app_type}::${record.id}`;
    setDuplicatingProviderKey(duplicateKey);
    try {
      const duplicatedProvider = await invoke<AIProvider>('duplicate_ai_provider', {
        id: record.id,
        app_type: record.app_type,
      });
      setProviders(prev => [...prev, duplicatedProvider]);
      messageApi.success(`已复制模型：${duplicatedProvider.name}`);
    } catch (e) {
      messageApi.error(`复制失败: ${e}`);
    } finally {
      setDuplicatingProviderKey(null);
    }
  };

  const handleImportFromCCSwitch = async () => {
    setImporting(true);
    try {
      const imported = await invoke<AIProvider[]>('import_from_ccswitch');
      if (imported.length > 0) {
        // 重新获取列表以反映新导入的项目
        const res = await invoke<AIProvider[]>('get_ai_providers');
        setProviders(res);
        // 如果目前没有默认模型，自动设置第一个为默认
        if (!appConfig?.default_provider_id && res.length > 0) {
          handleSetDefaultProvider(res[0].id, res[0].app_type);
        }
        messageApi.success(`成功导入 ${imported.length} 个 AI模型 `);
      } else {
        messageApi.info('未发现新模型或 cc-switch 数据库为空');
      }
    } catch (error) {
      messageApi.error(`导入失败: ${error} `);
    } finally {
      setImporting(false);
    }
  };

  const handleUploadAnthropicLogo = async () => {
    if (!tauriAvailable) {
      messageApi.warning('请在桌面应用中使用此功能');
      return;
    }
    setUploadingLogo(true);
    try {
      const imgKey = await invoke<string>('upload_anthropic_logo');
      messageApi.success(`Logo 上传成功: ${imgKey} `);
    } catch (error) {
      messageApi.error(`上传失败: ${error} `);
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
      messageApi.error(`测试失败: ${error} `);
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
        messageApi.error(`添加项目失败: ${error} `);
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
          messageApi.error(`删除项目失败: ${error} `);
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
      messageApi.error(`安装推送服务失败: ${error} `);
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
      messageApi.error(`卸载推送服务失败: ${error} `);
    }
  };

  const handleToggleAgentTeams = async (project: Project) => {
    if (!tauriAvailable) return;
    try {
      const nextValue = await invoke<boolean>('toggle_agent_teams', { project_path: project.path });
      setProjects(projects.map(p =>
        p.id === project.id ? { ...p, agent_teams_enabled: nextValue } : p
      ));
      messageApi.success(`项目 ${project.name} 的 Sub agents 已${nextValue ? '开启' : '关闭'} `);
    } catch (error) {
      messageApi.error(`操作失败: ${error} `);
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
                <button
                  type="button"
                  className="logo-home-button"
                  onClick={() => setActiveMenu('project')}
                >
                  <img src={logo} alt="logo" className="logo-img" />
                  <h1>Sparky</h1>
                </button>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              {activeMenu === 'project-detail' && (
                <>
                  <div className={`ide-status-wrapper ${codeServerConnected ? 'connected' : 'loading'}`}>
                    <div className={`ide-status-capsule ${codeServerConnected ? 'connected' : 'loading'}`}>
                      <img src={codeIcon} alt="IDE" className="ide-capsule-icon" style={{ opacity: codeServerConnected ? 1 : 0.5 }} />
                      <span className="ide-capsule-label">
                        {codeServerConnected ? "IDE 已就绪" : "IDE 启动中"}
                      </span>
                      {!codeServerConnected ? (
                        <LoadingOutlined style={{ fontSize: 11, color: 'var(--text-tertiary)' }} />
                      ) : (
                        <span className="ide-capsule-dot" />
                      )}
                    </div>
                    {codeServerConnected && (
                      <>
                        <button
                          type="button"
                          className="ide-restart-button"
                          onClick={handleRestartIDE}
                          disabled={ideRestarting}
                        >
                          {ideRestarting ? (
                            <LoadingOutlined style={{ fontSize: 11 }} />
                          ) : (
                            <ReloadOutlined style={{ fontSize: 11 }} />
                          )}
                          <span>重启 IDE</span>
                        </button>
                        <button
                          type="button"
                          className="ide-restart-button"
                          onClick={handleOpenIdeInNewWindow}
                          disabled={ideRestarting}
                        >
                          <FullscreenOutlined style={{ fontSize: 11 }} />
                          <span>新窗口打开</span>
                        </button>
                        <button
                          type="button"
                          className="ide-restart-button"
                          onClick={handleOpenIdeInBrowser}
                          disabled={ideRestarting}
                        >
                          <EyeOutlined style={{ fontSize: 11 }} />
                          <span>浏览器打开</span>
                        </button>
                      </>
                    )}
                  </div>
                  <Tooltip title={wsConnected ? "已连接" : "未连接"}>
                    <div className={`ide-status-capsule ${wsConnected ? 'connected' : ''}`}>
                      <img src={feishuIcon} alt="飞书" className="ide-capsule-icon" style={{ opacity: wsConnected ? 1 : 0.45 }} />
                      <span className="ide-capsule-label">
                        {wsConnected ? "已连接" : "未连接"}
                      </span>
                      <span className="ide-capsule-dot" style={!wsConnected ? { background: 'var(--text-tertiary)', boxShadow: 'none' } : undefined} />
                    </div>
                  </Tooltip>
                </>
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
            <aside className={`app-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} style={{ display: activeMenu === 'project-detail' ? 'none' : undefined }}>
              <Menu
                mode="inline"
                inlineCollapsed={sidebarCollapsed}
                selectedKeys={[activeMenu]}
                onClick={(e) => setActiveMenu(e.key)}
                style={{ height: '100%', borderRight: 0 }}
                items={[
                  { key: 'project', icon: <ProjectOutlined />, label: '项目' },
                  { key: 'ai-models', icon: <ThunderboltOutlined />, label: 'AI模型' },
                  { key: 'ide-plugins', icon: <AppstoreAddOutlined />, label: 'IDE 插件' },
                  { key: 'settings', icon: <SettingOutlined />, label: '设置' },
                  { key: 'help', icon: <EyeOutlined />, label: '帮助' },
                ]}
              />

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
                                <Tag className={`hooks - tag ${record.hooks_installed ? 'installed' : ''} `} style={{ margin: 0 }}>
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
                                  Go <img src={codeIcon} alt="Go" style={{ marginLeft: 4, width: 14, height: 14 }} />
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

              {activeMenu === 'ai-models' && (
                <div className="ai-models-page">
                  <Card className="projects-card" variant="borderless" style={{ height: 'auto', flex: 1 }}>
                    <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <ApiOutlined className="card-icon" />
                        <div>
                          <h2 style={{ margin: 0 }}>AI模型</h2>
                          <p className="card-description" style={{ margin: 0 }}>管理 Claude Code 的环境变量预设</p>
                        </div>
                      </div>
                      <Space>
                        <Button
                          icon={<DownloadOutlined />}
                          loading={importing}
                          onClick={handleImportFromCCSwitch}
                        >
                          从 cc-switch 导入
                        </Button>
                        {selectedProviderKeys.length > 0 && (
                          <Popconfirm
                            title={`确定要删除选中的 ${selectedProviderKeys.length} 个 AI模型 吗？`}
                            onConfirm={async () => {
                              setBatchDeleting(true);
                              try {
                                for (const key of selectedProviderKeys) {
                                  if (typeof key === 'string') {
                                    const [app_type, id] = key.split('::');
                                    if (id && app_type) {
                                      await invoke('delete_ai_provider', { id, app_type });
                                    }
                                  }
                                }
                                const res = await invoke<AIProvider[]>('get_ai_providers');
                                setProviders(res);
                                setSelectedProviderKeys([]);
                                messageApi.success(`成功删除了 ${selectedProviderKeys.length} 个模型`);

                                // 如果默认模型被删除，且列表中还有模型，设置第一个为默认
                                if (appConfig?.default_provider_id && selectedProviderKeys.includes(appConfig.default_provider_id)) {
                                  if (res.length > 0) {
                                    handleSetDefaultProvider(res[0].id, res[0].app_type);
                                  } else {
                                    const newConfig = { ...appConfig, default_provider_id: undefined } as AppConfig;
                                    setAppConfig(newConfig);
                                    invoke('save_config', { config: newConfig }).catch(console.error);
                                  }
                                }
                              } catch (e) {
                                messageApi.error(`批量删除失败: ${e}`);
                              } finally {
                                setBatchDeleting(false);
                              }
                            }}
                          >
                            <Button danger loading={batchDeleting} icon={<DeleteOutlined />}>
                              批量删除 ({selectedProviderKeys.length})
                            </Button>
                          </Popconfirm>
                        )}
                        <Button
                          type="primary"
                          icon={<PlusOutlined />}
                          onClick={() => {
                            setEditingProvider({
                              name: '',
                              settings_config: JSON.stringify({ api_timeout: '3000000', disable_traffic: 1 }),
                              app_type: 'ClaudeCode',
                              cost_multiplier: '1.0',
                              is_current: false,
                              in_failover_queue: false,
                              meta: '{}',
                              endpoints: []
                            });
                            setProviderModalOpen(true);
                          }}
                        >
                          添加 AI模型
                        </Button>
                        <Button
                          icon={<ReloadOutlined />}
                          onClick={handleRefreshProviders}
                          loading={refreshingProviders}
                          title="刷新列表"
                        />
                      </Space>
                    </div>
                    <Divider />
                    <Table
                      dataSource={providers}
                      rowKey={(record) => `${record.app_type}::${record.id}`}
                      rowSelection={{
                        selectedRowKeys: selectedProviderKeys,
                        onChange: (newSelectedRowKeys) => {
                          setSelectedProviderKeys(newSelectedRowKeys);
                        },
                      }}
                      pagination={{ pageSize: 10, showSizeChanger: true }}
                      columns={[
                        {
                          title: '名称',
                          dataIndex: 'name',
                          key: 'name',
                          render: (text, record) => (
                            <Space>
                              {text}
                              {appConfig?.default_provider_id === `${record.app_type}::${record.id}` && (
                                <Tag className="active-project-tag">默认</Tag>
                              )}
                            </Space>
                          )
                        },
                        {
                          title: '官网',
                          dataIndex: 'website_url',
                          key: 'website_url',
                          render: (val) => val ? <a href={val} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}><InfoCircleOutlined /> 访问官网</a> : '-'
                        },
                        {
                          title: 'Base URL',
                          dataIndex: 'settings_config',
                          key: 'base_url',
                          render: (val) => {
                            try {
                              const s = JSON.parse(val);
                              return s.base_url || '默认';
                            } catch { return '默认'; }
                          }
                        },
                        {
                          title: '操作',
                          key: 'action',
                          width: 260,
                          render: (_, record) => (
                            <Space>
                              {appConfig?.default_provider_id !== `${record.app_type}::${record.id}` && (
                                <Button
                                  size="small"
                                  onClick={() => handleSetDefaultProvider(record.id, record.app_type)}
                                >
                                  设为默认
                                </Button>
                              )}
                              <Button
                                size="small"
                                type="text"
                                icon={<CopyOutlined />}
                                loading={duplicatingProviderKey === `${record.app_type}::${record.id}`}
                                onClick={() => handleDuplicateProvider(record)}
                                title="复制一份"
                              />
                              <Button
                                size="small"
                                type="text"
                                icon={<EditOutlined />}
                                onClick={() => {
                                  setEditingProvider(record);
                                  setProviderModalOpen(true);
                                }}
                              />
                              <Popconfirm
                                title="确定删除此 AI模型 吗？"
                                onConfirm={async () => {
                                  try {
                                    await invoke('delete_ai_provider', { id: record.id, app_type: record.app_type });
                                    setProviders(prev => {
                                      const next = prev.filter(p => p.id !== record.id || p.app_type !== record.app_type);
                                      // 如果删除的是默认，且还剩下一个，自动把剩下的设为默认
                                      if (appConfig?.default_provider_id === `${record.app_type}::${record.id}`) {
                                        if (next.length === 1) {
                                          handleSetDefaultProvider(next[0].id, next[0].app_type);
                                        } else if (appConfig) {
                                          const newConfig = { ...appConfig, default_provider_id: undefined } as AppConfig;
                                          setAppConfig(newConfig);
                                          invoke('save_config', { config: newConfig }).catch(console.error);
                                          form.setFieldsValue(newConfig);
                                        }
                                      }
                                      return next;
                                    });
                                    messageApi.success('已删除');
                                  } catch (e) {
                                    messageApi.error(`删除失败: ${e} `);
                                  }
                                }}
                              >
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                              </Popconfirm>
                            </Space>
                          )
                        }
                      ]}
                    />
                  </Card>
                </div>
              )}

              {activeMenu === 'ide-plugins' && (
                <div className="ide-plugins-page">
                  <Card className="projects-card" variant="borderless" style={{ height: 'auto', flex: 1 }}>
                    <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <AppstoreAddOutlined className="card-icon" />
                        <div>
                          <h2 style={{ margin: 0 }}>IDE 插件</h2>
                          <p className="card-description" style={{ margin: 0 }}>为本地的 Code-Server 安装 VS Code 插件</p>
                        </div>
                      </div>
                      <Space>
                        <Input
                          placeholder="输入 publisher.extensionid"
                          value={customPluginId}
                          onChange={e => setCustomPluginId(e.target.value)}
                          style={{ width: 250 }}
                        />
                        <Button
                          type="primary"
                          loading={installingPlugin === `add:${customPluginId}`}
                          onClick={async () => {
                            const pluginId = customPluginId.trim();
                            if (!pluginId) return;
                            setInstallingPlugin(`add:${pluginId}`);
                            try {
                              await invoke('add_ide_plugin', { extension_id: pluginId });
                              messageApi.success(`已加入插件列表: ${pluginId}`);
                              setCustomPluginId('');
                              const list = await invoke<IDEPlugin[]>('get_ide_plugins');
                              setIdePluginList(list);
                            } catch (e) {
                              messageApi.error(`保存失败: ${e}`);
                            } finally {
                              setInstallingPlugin(null);
                            }
                          }}
                        >
                          加入列表
                        </Button>
                        <Button
                          icon={<ReloadOutlined />}
                          onClick={async () => {
                            const [installedList, pluginList] = await Promise.all([
                              invoke<string[]>('get_installed_code_server_extensions'),
                              invoke<IDEPlugin[]>('get_ide_plugins')
                            ]);
                            setIdePlugins(installedList);
                            setIdePluginList(pluginList);
                            messageApi.success('插件列表已刷新');
                          }}
                        />
                      </Space>
                    </div>
                    <Divider />
                    <Table
                      dataSource={idePluginList}
                      rowKey="id"
                      pagination={false}
                      columns={[
                        {
                          title: '插件名',
                          dataIndex: 'name',
                          key: 'name',
                          width: 200,
                          render: (text) => <span style={{ fontWeight: 500 }}>{text}</span>
                        },
                        {
                          title: 'ID (publisher.extensionid)',
                          dataIndex: 'id',
                          key: 'id',
                          width: 250,
                          render: (text) => <Typography.Text copyable style={{ fontSize: 13 }}>{text}</Typography.Text>
                        },
                        {
                          title: '描述',
                          dataIndex: 'desc',
                          key: 'desc',
                        },
                        {
                          title: '状态',
                          key: 'status',
                          width: 150,
                          render: (_, record) => {
                            const installed = idePlugins.some(p => p.toLowerCase() === record.id.toLowerCase());
                            return installed ? <Tag color="green">已安装</Tag> : <Tag>未安装</Tag>;
                          }
                        },
                        {
                          title: '操作',
                          key: 'action',
                          width: 220,
                          render: (_, record) => {
                            const installed = idePlugins.some(p => p.toLowerCase() === record.id.toLowerCase());
                            return (
                              <Space>
                                <Button
                                  size="small"
                                  type={installed ? 'default' : 'primary'}
                                  disabled={installed}
                                  loading={installingPlugin === record.id}
                                  onClick={async () => {
                                    setInstallingPlugin(record.id);
                                    try {
                                      await invoke('install_code_server_extension', { extension_id: record.id });
                                      messageApi.success(`插件 ${record.name} 安装成功`);
                                      const list = await invoke<string[]>('get_installed_code_server_extensions');
                                      setIdePlugins(list);
                                    } catch (e) {
                                      messageApi.error(`安装失败: ${e}`);
                                    } finally {
                                      setInstallingPlugin(null);
                                    }
                                  }}
                                >
                                  {installed ? '已安装' : '安装'}
                                </Button>
                                <Popconfirm
                                  title="删除这个插件项？"
                                  okText="删除"
                                  cancelText="取消"
                                  onConfirm={async () => {
                                    try {
                                      await invoke('delete_ide_plugin', { id: record.id });
                                      setIdePluginList(prev => prev.filter(item => item.id !== record.id));
                                      messageApi.success(`已删除 ${record.name}`);
                                    } catch (e) {
                                      messageApi.error(`删除失败: ${e}`);
                                    }
                                  }}
                                >
                                  <Button size="small" danger type="text" icon={<DeleteOutlined />} />
                                </Popconfirm>
                              </Space>
                            );
                          }
                        }
                      ]}
                    />
                  </Card>
                </div>
              )}

              {activeMenu === 'project-detail' && selectedProject && (
                <div className="project-detail-page" style={{ height: '100%' }}>
                  <Splitter
                    style={{ height: '100%', width: '100%' }}
                    onResize={(sizes) => {
                      setSplitterSizes(sizes);
                      localStorage.setItem('sparkySplitterSizes', JSON.stringify(sizes));
                    }}
                  >
                    <Splitter.Panel size={splitterSizes[0]} collapsible min="30%" max="80%">
                      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
                        {/* IDE 标签页 */}
                        {ideRestarting ? (
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', padding: 24, textAlign: 'center', gap: 16 }}>
                            <LoadingOutlined style={{ fontSize: 48, color: 'var(--text-secondary)' }} spin />
                            <div>
                              <h3 style={{ color: 'var(--text-primary)', margin: 0, marginBottom: 8 }}>IDE 重启中</h3>
                              <p style={{ margin: 0 }}>正在重新连接 IDE 服务</p>
                            </div>
                          </div>
                        ) : codeServerConnected === false ? (
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', padding: 24, textAlign: 'center', gap: 16 }}>
                            <WarningOutlined style={{ fontSize: 48, color: '#faad14' }} />
                            <div>
                              <h3 style={{ color: 'var(--text-primary)', margin: 0, marginBottom: 8 }}>IDE 连接失败</h3>
                              <p style={{ margin: 0 }}>无法连接到 IDE 服务</p>
                            </div>
                            <div style={{ display: 'flex', gap: 12 }}>
                              <Button
                                type="primary"
                                icon={<ReloadOutlined />}
                                onClick={async () => {
                                  const connected = await invoke<boolean>('check_code_server_connection');
                                  setCodeServerConnected(connected);
                                }}
                              >
                                重试连接
                              </Button>
                              <Button
                                icon={<MenuOutlined />}
                                onClick={() => {
                                  setSplitterSizes(['0%', '100%']);
                                  localStorage.setItem('sparkySplitterSizes', JSON.stringify(['0%', '100%']));
                                }}
                              >
                              收起 IDE
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Tabs
                          type="editable-card"
                          size="small"
                          activeKey={activeIdeTabId[selectedProject.path] || 'code-server'}
                          onChange={(key) => setActiveIdeTabId(prev => ({ ...prev, [selectedProject.path]: key }))}
                          onEdit={(targetKey, action) => {
                            if (action === 'add') {
                              setNewTabUrl('');
                              setNewTabModalOpen(true);
                            } else if (action === 'remove' && typeof targetKey === 'string') {
                              setIdeTabs(prev => {
                                const currentTabs = prev[selectedProject.path] || [];
                                const nextTabs = currentTabs.filter(tab => tab.id !== targetKey);
                                setActiveIdeTabId(prevActive => {
                                  if (prevActive[selectedProject.path] !== targetKey) return prevActive;
                                  const nextActive = nextTabs[nextTabs.length - 1]?.id || 'code-server';
                                  return { ...prevActive, [selectedProject.path]: nextActive };
                                });
                                return { ...prev, [selectedProject.path]: nextTabs };
                              });
                              setTabLoadErrors(prev => {
                                const next = { ...prev };
                                delete next[targetKey];
                                return next;
                              });
                              setIdeTabReloadKeys(prev => {
                                if (!(targetKey in prev)) return prev;
                                const next = { ...prev };
                                delete next[targetKey];
                                return next;
                              });
                            }
                          }}
                          style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: 0 }}
                          className="terminal-tabs-inner settings-tabs"
                          items={(ideTabs[selectedProject.path] || []).map(tab => ({
                            key: tab.id,
                            label: (
                              <span className="ide-tab-label">
                                <span className="ide-tab-title">{tab.title}</span>
                                <Tooltip title="刷新">
                                  <ReloadOutlined
                                    className="ide-tab-refresh"
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setIdeTabReloadKeys(prev => ({
                                        ...prev,
                                        [tab.id]: (prev[tab.id] || 0) + 1
                                      }));
                                      setTabLoadErrors(prev => ({ ...prev, [tab.id]: false }));
                                    }}
                                  />
                                </Tooltip>
                              </span>
                            ),
                            closable: tab.closable !== false,
                            children: (
                              <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
                                <iframe
                                  key={`${tab.id}-${ideTabReloadKeys[tab.id] || 0}`}
                                  src={tab.url}
                                  title={tab.title}
                                  style={{
                                    flex: 1,
                                    width: '100%',
                                    height: '100%',
                                    border: 'none',
                                    borderRight: '1px solid var(--border-color)',
                                    display: 'block',
                                    background: 'var(--bg-primary)'
                                  }}
                                  allow="clipboard-read *; clipboard-write *; display-capture *"
                                  onLoad={() => {
                                    setTabLoadErrors(prev => ({ ...prev, [tab.id]: false }));
                                  }}
                                  onError={() => {
                                    setTabLoadErrors(prev => ({ ...prev, [tab.id]: true }));
                                  }}
                                />
                                {tabLoadErrors[tab.id] && (
                                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', color: '#fff', padding: 16, textAlign: 'center' }}>
                                    页面加载失败或被禁止嵌入，请尝试其他 URL。
                                  </div>
                                )}
                              </div>
                            )
                          }))}
                        />
                      )}
                      </div>
                    </Splitter.Panel >
                    <Splitter.Panel size={splitterSizes[1]} collapsible min="20%" max="80%">
                      <Card className="project-detail-card" variant="borderless" style={{ height: '100%', margin: 0, borderRadius: 0, padding: 0 }}>

                        <Modal
                          title="新建标签页"
                          open={newTabModalOpen}
                          onCancel={() => {
                            setNewTabModalOpen(false);
                            setNewTabUrl('');
                          }}
                          onOk={() => {
                            createIdeTabFromUrl();
                          }}
                          okText="创建"
                          cancelText="取消"
                        >
                          <Input
                            placeholder="输入要打开的 URL（例如：https://github.com）"
                            value={newTabUrl}
                            onChange={(e) => setNewTabUrl(e.target.value)}
                            onPressEnter={() => {
                              createIdeTabFromUrl();
                            }}
                          />
                          <div style={{ marginTop: 12 }}>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                              最近打开
                            </div>
                            {recentUrlsForProject.length === 0 ? (
                              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>暂无最近 URL</div>
                            ) : (
                              <List
                                size="small"
                                dataSource={recentUrlsForProject}
                                renderItem={(item) => (
                                  <List.Item style={{ padding: '4px 0' }}>
                                    <Tooltip title={item}>
                                      <Button
                                        type="link"
                                        size="small"
                                        style={{ padding: 0, height: 'auto' }}
                                        onClick={() => {
                                          createIdeTabFromUrl(item);
                                        }}
                                      >
                                        <Typography.Text ellipsis style={{ maxWidth: 420, display: 'inline-block' }}>
                                          {item}
                                        </Typography.Text>
                                      </Button>
                                    </Tooltip>
                                  </List.Item>
                                )}
                              />
                            )}
                          </div>
                        </Modal>

                        {/* Session Picker Modal */}
                        <Modal
                          title="选择要继续的会话"
                          open={sessionModalOpen}
                          onCancel={() => setSessionModalOpen(false)}
                          footer={null}
                          width={860}
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
                                  width: 140,
                                  render: (_: any, record: SessionInfo) => (
                                    <Space>
                                      <Button
                                        size="small"
                                        type="primary"
                                        onClick={async () => {
                                          const tid = activeTerminalId[selectedProject.path];
                                          if (!tid) return;
                                          const isFullAuth = fullAuth[selectedProject.path] || false;
                                          const args = isFullAuth
                                            ? `--dangerously-skip-permissions --resume ${record.session_id}`
                                            : `--resume ${record.session_id}`;
                                          const cmd = await buildClaudeCmd(tid, args);
                                          invoke('pty_write', { terminal_id: tid, data: cmd });
                                          setSessionModalOpen(false);
                                        }}
                                      >
                                        继续
                                      </Button>
                                      <Popconfirm
                                        title="确定要删除该会话记录吗？"
                                        onConfirm={async () => {
                                          try {
                                            await invoke('delete_session', { session_id: record.session_id });
                                            await fetchSessions(selectedProject.path);
                                            messageApi.success('已删除');
                                          } catch (e: any) {
                                            messageApi.error(`删除失败: ${e}`);
                                          }
                                        }}
                                        okText="是"
                                        cancelText="否"
                                      >
                                        <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                                      </Popconfirm>
                                    </Space>
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
                          destroyOnHidden
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
                                          try {
                                            const status = await invoke<{ installed: boolean; running: boolean; path: string }>('check_mcp_status');
                                            setMcpStatus(status);
                                            if (!status.installed) {
                                              messageApi.warning('chrome-devtools-mcp 未安装，但仍可进入测试会话');
                                            }
                                            // 运行状态检查已移除，不再尝试启动或报错
                                          } catch (err) {
                                            console.warn("MCP check failed:", err);
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
                                                cmd = await buildClaudeCmd(targetTerminalId, isFullAuth
                                                  ? `--dangerously-skip-permissions --resume ${existingSession}`
                                                  : `--resume ${existingSession}`);
                                                messageApi.info(`恢复测试会话: ${existingSession.slice(0, 12)}...`);
                                              } else {
                                                // Start new claude session - capture current sessions first to avoid saving old session
                                                const currentSessions = await invoke<SessionInfo[]>('get_project_sessions', {
                                                  project_path: selectedProject.path,
                                                }).catch(() => [] as SessionInfo[]);
                                                const topId = currentSessions.length > 0 ? currentSessions[0].id : 0;

                                                cmd = await buildClaudeCmd(targetTerminalId, isFullAuth
                                                  ? '--dangerously-skip-permissions'
                                                  : '');
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

                        <Modal
                          title="新建终端"
                          open={createTerminalModalOpen}
                          onCancel={() => {
                            setCreateTerminalModalOpen(false);
                            setNewTerminalProviderId(undefined);
                          }}
                          onOk={handleConfirmCreateTerminal}
                          okText="创建"
                          cancelText="取消"
                          okButtonProps={{ disabled: !newTerminalProviderId }}
                          destroyOnHidden
                          width={600}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                              请选择这个终端要使用的 AI Provider。
                            </div>
                            <Select
                              placeholder="选择 AI Provider"
                              value={newTerminalProviderId}
                              onChange={(val) => {
                                setNewTerminalProviderId(val);
                                // Auto-select model (prefer last used, fallback to first)
                                const provider = providers.find(p => `${p.app_type}::${p.id}` === val);
                                if (provider) {
                                  try {
                                    const settings = JSON.parse(provider.settings_config);
                                    const models = (settings.model_ids && settings.model_ids.length > 0) ? settings.model_ids : (settings.model_id ? [settings.model_id] : []);
                                    const lastModel = lastModelByProject[selectedProject?.path || ''];
                                    const lastModelExists = lastModel && models.includes(lastModel);
                                    setNewTerminalModelId(lastModelExists ? lastModel : models[0]);
                                  } catch (e) {
                                    setNewTerminalModelId(undefined);
                                  }
                                } else {
                                  setNewTerminalModelId(undefined);
                                }
                              }}
                              style={{ width: '100%' }}
                              options={providers.map(provider => ({
                                label: (
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    <span>{provider.name}</span>
                                    {selectedProject && lastProviderByProject[selectedProject.path] === `${provider.app_type}::${provider.id}` && (
                                      <Tag
                                        style={{
                                          marginInlineStart: 8,
                                          backgroundColor: 'var(--active-text)',
                                          borderColor: 'var(--active-text)',
                                          color: 'var(--active-bg)',
                                        }}
                                      >
                                        上次选择
                                      </Tag>
                                    )}
                                  </div>
                                ),
                                value: `${provider.app_type}::${provider.id}`,
                              }))}
                            />

                            {newTerminalProviderId && (
                              <>
                                <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 4 }}>
                                  选择专属于此终端的 Model ID (可选):
                                </div>
                                <Select
                                  placeholder="选择 Model ID"
                                  value={newTerminalModelId}
                                  onChange={setNewTerminalModelId}
                                  style={{ width: '100%' }}
                                  options={(() => {
                                    const provider = providers.find(p => `${p.app_type}::${p.id}` === newTerminalProviderId);
                                    if (!provider) return [];
                                    try {
                                      const settings = JSON.parse(provider.settings_config);
                                      const models = (settings.model_ids && settings.model_ids.length > 0) ? settings.model_ids : (settings.model_id ? [settings.model_id] : []);
                                      return models.map((m: string) => ({
                                        label: (
                                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                            <span>{m}</span>
                                            {selectedProject && lastModelByProject[selectedProject.path] === m && (
                                              <Tag
                                                style={{
                                                  marginInlineStart: 8,
                                                  backgroundColor: 'var(--active-text)',
                                                  borderColor: 'var(--active-text)',
                                                  color: 'var(--active-bg)',
                                                }}
                                              >
                                                上次选择
                                              </Tag>
                                            )}
                                          </div>
                                        ),
                                        value: m
                                      }));
                                    } catch (e) {
                                      return [];
                                    }
                                  })()}
                                />
                              </>
                            )}
                          </div>
                        </Modal>

                        <div className={`terminal-wrapper ${terminalFullscreen ? 'fullscreen' : ''}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
                          {terminalStateReady ? (
                            <Tabs
                            type="editable-card"
                            size="small"
                            tabBarExtraContent={
                              <Space size="small" style={{ marginRight: 8, display: 'flex', alignItems: 'center' }}>
                                <Tooltip title={fullAuth[selectedProject.path] ? '完全授权模式 (--dangerously-skip-permissions)' : '安全模式 (进行权限管控)'}>
                                  <Button
                                    size="small"
                                    type={fullAuth[selectedProject.path] ? 'primary' : 'text'}
                                    danger={fullAuth[selectedProject.path] || false}
                                    className={fullAuth[selectedProject.path] ? 'auth-btn-active' : ''}
                                    icon={<SafetyCertificateOutlined />}
                                    onClick={() => setFullAuth(prev => ({ ...prev, [selectedProject.path]: !(prev[selectedProject.path] || false) }))}
                                  />
                                </Tooltip>
                                <Tooltip title="新建会话">
                                  <Button size="small" type="text" icon={<PlayCircleOutlined />}
                                    disabled={!activeTerminalId[selectedProject.path] || activeTerminalId[selectedProject.path] === 'detail'}
                                    onClick={async () => {
                                      const tid = activeTerminalId[selectedProject.path];
                                      if (!tid) return;
                                      const isFullAuth = fullAuth[selectedProject.path] || false;
                                      const cmd = await buildClaudeCmd(tid, isFullAuth ? '--dangerously-skip-permissions' : '');
                                      invoke('pty_write', { terminal_id: tid, data: cmd });
                                    }} />
                                </Tooltip>
                                <Tooltip title="继续会话">
                                  <Button size="small" type="text"
                                    disabled={!activeTerminalId[selectedProject.path] || activeTerminalId[selectedProject.path] === 'detail'}
                                    onClick={async () => {
                                      await fetchSessions(selectedProject.path);
                                      setSessionModalOpen(true);
                                    }} icon={<HistoryOutlined />} />
                                </Tooltip>
                                <Tooltip title="测试会话">
                                  <Button size="small" type="text"
                                    disabled={!activeTerminalId[selectedProject.path] || activeTerminalId[selectedProject.path] === 'detail'}
                                    onClick={() => {
                                      setTestModalOpen(true);
                                      if (tauriAvailable) {
                                        invoke<{ installed: boolean; running: boolean; path: string }>('check_mcp_status').then(setMcpStatus).catch(() => { });
                                      }
                                    }} icon={<ExperimentOutlined />} />
                                </Tooltip>
                                <Tooltip title="清空当前输入">
                                  <Button size="small" type="text" onClick={() => {
                                    const tid = activeTerminalId[selectedProject.path];
                                    if (tid) {
                                      // \x05 (Ctrl+E) moves to end of line, \x15 (Ctrl+U) clears line
                                      invoke('pty_write', { terminal_id: tid, data: '\x05\x15' });
                                    }
                                  }} icon={<ClearOutlined />} />
                                </Tooltip>
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
                                        key: 'compact',
                                        label: '/compact (精简上下文)',
                                        icon: <CompressOutlined />,
                                        onClick: () => {
                                          const tid = activeTerminalId[selectedProject.path];
                                          if (tid) {
                                            invoke('pty_write', { terminal_id: tid, data: '/compact\n' });
                                            window.dispatchEvent(new CustomEvent('claude-context-reset', { detail: selectedProject.path }));
                                          }
                                        }
                                      },
                                      {
                                        key: 'clear',
                                        label: '/clear (清空历史)',
                                        icon: <ClearOutlined />,
                                        onClick: () => {
                                          const tid = activeTerminalId[selectedProject.path];
                                          if (tid) invoke('pty_write', { terminal_id: tid, data: '/clear\n' });
                                        }
                                      },
                                      {
                                        key: 'undo',
                                        label: '/undo (撤销修改)',
                                        icon: <UndoOutlined />,
                                        onClick: () => {
                                          const tid = activeTerminalId[selectedProject.path];
                                          if (tid) invoke('pty_write', { terminal_id: tid, data: '/undo\n' });
                                        }
                                      },
                                      {
                                        key: 'files',
                                        label: '/files (查看已载入文件)',
                                        icon: <FileTextOutlined />,
                                        onClick: () => {
                                          const tid = activeTerminalId[selectedProject.path];
                                          if (tid) invoke('pty_write', { terminal_id: tid, data: '/files\n' });
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
                                  />
                                </Dropdown>
                              </Space>
                            }
                            activeKey={activeTerminalId[selectedProject.path] || 'detail'}
                            onChange={(key) => setActiveTerminalId(prev => ({ ...prev, [selectedProject.path]: key }))}
                            onEdit={(targetKey, action) => {
                              if (action === 'add') {
                                openCreateTerminalModal();
                              } else if (action === 'remove' && typeof targetKey === 'string') {
                                if (targetKey === 'detail') {
                                  setShowDetailTab(prev => ({ ...prev, [selectedProject!.path]: false }));
                                  if (activeTerminalId[selectedProject!.path] === 'detail') {
                                    setActiveTerminalId(prev => ({ ...prev, [selectedProject!.path]: projectTerminals[selectedProject!.path]?.[0]?.id || 'vscode' }));
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
                            style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: 0 }}
                            className="terminal-tabs-inner settings-tabs"
                            items={[
                              ...(projectTerminals[selectedProject.path] || []).map(term => {
                                const isActive = activeTerminalId[selectedProject.path] === term.id;
                                const currentProvider = providers.find(p => `${p.app_type}::${p.id}` === term.providerId);
                                let currentModelId = term.selectedModelId;
                                if (!currentModelId && currentProvider?.settings_config) {
                                  try {
                                    const settings = JSON.parse(currentProvider.settings_config);
                                    const models = (settings.model_ids && settings.model_ids.length > 0)
                                      ? settings.model_ids
                                      : (settings.model_id ? [settings.model_id] : []);
                                    currentModelId = models[0];
                                  } catch (e) {
                                  }
                                }
                                return {
                                  key: term.id,
                                  label: (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <img src={isActive ? claudeIcon : claudeDeactiveIcon} width={18} height={18} alt="Claude" />
                                      <span>{term.title}</span>
                                      {terminalStatus[term.id] === 'claude' && (
                                        <Badge status="processing" text={<span style={{ color: 'var(--primary-color)', fontSize: '12px' }}>Claude 运行中</span>} />
                                      )}
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
                                      <div style={{
                                        position: 'absolute',
                                        top: terminalFullscreen ? 30 : 30,
                                        right: 16,
                                        display: 'flex',
                                        gap: '8px',
                                        zIndex: 100,
                                        alignItems: 'center'
                                      }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: '8px' }}>
                                          <Tag
                                            className="active-project-tag"
                                            style={{
                                              cursor: 'default',
                                              margin: 0,
                                              fontSize: '12px',
                                              height: '24px',
                                              lineHeight: '22px',
                                              padding: '0 10px'
                                            }}
                                          >
                                            {currentProvider?.name || '未知模型'}
                                          </Tag>
                                          <Tag
                                            className="active-project-tag"
                                            style={{
                                              cursor: 'default',
                                              margin: 0,
                                              fontSize: '12px',
                                              height: '24px',
                                              lineHeight: '22px',
                                              padding: '0 10px'
                                            }}
                                          >
                                            {currentModelId || '未选择模型'}
                                          </Tag>
                                        </div>
                                        <ContextDonut
                                          projectPath={selectedProject!.path}
                                        />
                                        {!terminalFullscreen && (
                                          <Button
                                            type="text"
                                            icon={<ArrowDownOutlined />}
                                            style={{ color: 'rgba(255, 255, 255, 0.65)', background: 'rgba(0, 0, 0, 0.2)' }}
                                            title="滚动到底部"
                                            onClick={() => terminalRefs.current[term.id]?.scrollToBottom()}
                                          />
                                        )}
                                        <Button
                                          type="text"
                                          icon={terminalFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                                          style={{ color: 'rgba(255, 255, 255, 0.65)', background: 'rgba(0, 0, 0, 0.2)' }}
                                          onClick={() => setTerminalFullscreen(!terminalFullscreen)}
                                        />
                                      </div>
                                      {/* To maintain alignment we just replaced the overlay buttons */}
                                      <div style={{ flex: 1, display: (viewModes[term.id] || 'terminal') === 'terminal' ? 'block' : 'none' }}>
                                        {(() => {
                                          const providerIdStr = term.providerId || selectedProject?.default_provider_id || appConfig?.default_provider_id;
                                          const providerIdForSpawn = providerIdStr && providerIdStr.includes('::') ? providerIdStr.split('::')[1] : undefined;
                                          return (
                                            <TerminalComponent
                                              projectPath={selectedProject!.path}
                                              terminalId={term.id}
                                              title={term.title as string}
                                              defaultProviderId={providerIdForSpawn}
                                              selectedModelId={term.selectedModelId}
                                              onData={handleTerminalInput}
                                              onLinkClick={async (path) => {
                                                try {
                                                  const exists = await invoke<boolean>('check_file_exists', { filePath: path });
                                                  if (!exists) {
                                                    messageApi.warning(`文件路径不存在: ${path}，Claude 可能省略了上级目录，请使用准确路径`);
                                                    return;
                                                  }
                                                } catch (e) {
                                                  console.error('Failed to check file existence:', e);
                                                }

                                                console.log('Invoking open_in_coder with path:', path);
                                                invoke('open_in_coder', { filePath: path }).catch((err) => {
                                                  console.error('Failed to open file in Coder IDE:', err);
                                                });
                                              }}
                                              ref={(el) => {
                                                if (el) terminalRefs.current[term.id] = el;
                                              }}
                                              mergeTop
                                              historyLines={terminalHistory[selectedProject!.path] || []}
                                              fullscreen={terminalFullscreen}
                                              theme={{
                                                background: appConfig?.terminal_bg_color,
                                                foreground: appConfig?.terminal_fg_color,
                                                fontSize: appConfig?.terminal_font_size,
                                              }}
                                            />
                                          );
                                        })()}
                                      </div>
                                      {viewModes[term.id] === 'chat' && (
                                        <ChatView projectPath={selectedProject!.path} activeTerminalId={term.id} />
                                      )}
                                    </div>
                                  ),
                                };
                              }),
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
                                        destroyOnHidden
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
                            ]}
                          />
                          ) : (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', gap: 8 }}>
                              <LoadingOutlined style={{ fontSize: 18 }} />
                              <span>终端恢复中...</span>
                            </div>
                          )}
                        </div>
                      </Card>
                    </Splitter.Panel>
                  </Splitter >
                </div >
              )}

              {
                activeMenu === 'settings' && (
                  <div className="settings-page">
                    <div className="main-grid">
                      <div className="left-column">
                        <Form
                          form={form}
                          layout="vertical"
                          onFinish={handleSave}
                          onFinishFailed={() => {
                            notificationApi.error({
                              message: '保存失败',
                              description: '请检查必填项是否正确填写',
                              placement: 'topRight',
                              duration: 4,
                            });
                          }}
                          className="config-form"
                          style={{ marginTop: 0, display: 'flex', flexDirection: 'column', flex: 1 }}
                        >
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
                                    <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        <SettingOutlined className="card-icon" />
                                        <h2>通用配置</h2>
                                      </div>
                                      <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading}>
                                        保存配置
                                      </Button>
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
                                              {watchedFontSize || 13}
                                            </Tag>
                                          </div>
                                        </Card>
                                      </div>
                                    </Form.Item>

                                  </Card>
                                ),
                              },
                              {
                                key: 'channel',
                                label: '通知渠道配置',
                                children: (
                                  <Card className="projects-card channel-card" variant="borderless" style={{ flex: 1, height: 'auto' }}>
                                    <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                        <ApiOutlined className="card-icon" />
                                        <h2>通知渠道配置</h2>
                                      </div>
                                      <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading}>
                                        保存配置
                                      </Button>
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
                                                  <Button type="default" icon={<ApiOutlined />} onClick={handleTestConnection} loading={testingConnection}>测试连接</Button>
                                                  <Button type="default" onClick={handleUploadAnthropicLogo} loading={uploadingLogo}>使用 Anthropic Logo</Button>
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
                )
              }

              {
                activeMenu === 'help' && (
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
                )
              }
            </div >
          </div >
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

        <Modal
          title={editingProvider?.id ? '编辑 AI模型' : '添加 AI模型'}
          open={providerModalOpen}
          onCancel={() => setProviderModalOpen(false)}
          footer={[
            <div key="test-area" style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'flex-start' }}>
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>测试模型:</span>
              <Select
                style={{ width: 180, textAlign: 'center' }}
                placeholder="请选择测试模型"
                value={testModelId || (watchedModelIds && watchedModelIds.length > 0 ? watchedModelIds[0] : undefined)}
                onChange={setTestModelId}
                options={(watchedModelIds || []).map((m: string) => ({ label: m, value: m }))}
              />
              <Button key="test" loading={testingProvider} icon={<ThunderboltOutlined />} onClick={async () => {
                const values = providerForm.getFieldsValue();
                setTestingProvider(true);
                try {
                  const currentTestModel = testModelId || (values.model_ids && values.model_ids.length > 0 ? values.model_ids[0] : undefined);
                  // 转换为 AIProvider 结构
                  const settings = {
                    api_key: values.api_key,
                    base_url: values.base_url,
                    model_ids: values.model_ids,
                    model_id: currentTestModel, // User-selected model for testing, or fallback
                    api_timeout: values.api_timeout,
                    disable_traffic: values.disable_traffic ? 1 : 0
                  };
                  const provider = {
                    ...values,
                    id: editingProvider?.id || (window as any).crypto.randomUUID(),
                    app_type: 'ClaudeCode', // 我们的默认类型
                    settings_config: JSON.stringify(settings),
                    meta: JSON.stringify({}),
                    cost_multiplier: '1.0',
                    is_current: false,
                    in_failover_queue: false,
                    endpoints: [{ url: values.base_url, provider_id: '', app_type: 'ClaudeCode', added_at: Date.now() }]
                  };
                  const res = await invoke<string>('test_ai_provider_connection', { provider });
                  messageApi.success(res);
                } catch (e) {
                  messageApi.error(String(e));
                } finally {
                  setTestingProvider(false);
                }
              }}>测试连接</Button>
              <div style={{ flex: 1 }} />
              <Button key="cancel" onClick={() => { setProviderModalOpen(false); setTestModelId(undefined); }}>取消</Button>
              <Button key="ok" type="primary" onClick={() => { providerForm.submit(); setTestModelId(undefined); }}>确定</Button>
            </div>
          ]}
          destroyOnHidden
          width={800}
        >
          <Form
            form={providerForm}
            layout="vertical"
            key={editingProvider?.id || 'new'}
            onFinishFailed={() => {
              notificationApi.error({
                message: '提交失败',
                description: '请检查表单必填项',
                placement: 'topRight',
                duration: 4,
              });
            }}
            onFinish={async (values) => {
              try {
                const settings = {
                  api_key: values.api_key,
                  base_url: values.base_url,
                  model_ids: values.model_ids,
                  model_id: values.model_ids?.[0], // legacy fallback
                  api_timeout: values.api_timeout,
                  disable_traffic: values.disable_traffic ? 1 : 0
                };
                const newId = editingProvider?.id || (window as any).crypto.randomUUID();
                const provider = {
                  id: newId,
                  app_type: editingProvider?.app_type || 'ClaudeCode',
                  name: values.name,
                  settings_config: JSON.stringify(settings),
                  website_url: values.website_url,
                  meta: editingProvider?.meta || JSON.stringify({}),
                  cost_multiplier: editingProvider?.cost_multiplier || '1.0',
                  is_current: editingProvider?.is_current || false,
                  in_failover_queue: editingProvider?.in_failover_queue || false,
                  created_at: editingProvider?.created_at || Date.now(),
                  sort_index: editingProvider?.sort_index || 0,
                  endpoints: editingProvider?.endpoints || [{ url: values.base_url, provider_id: newId, app_type: editingProvider?.app_type || 'ClaudeCode', added_at: Date.now() }]
                } as AIProvider;

                await invoke('upsert_ai_provider', { provider });

                if (editingProvider?.id) {
                  setProviders(prev => prev.map(p => (p.id === editingProvider.id && p.app_type === editingProvider.app_type) ? provider : p));
                } else {
                  setProviders(prev => {
                    const next = [...prev, provider];
                    if (next.length === 1) {
                      handleSetDefaultProvider(provider.id, provider.app_type);
                    }
                    return next;
                  });
                }
                setProviderModalOpen(false);
                notificationApi.success({
                  message: '保存成功',
                  description: 'AI 模型配置已更新',
                  placement: 'topRight',
                  duration: 2,
                });
              } catch (e) {
                notificationApi.error({
                  message: '保存失败',
                  description: `错误原因: ${e}`,
                  placement: 'topRight',
                  duration: 4,
                });
              }
            }}
          >
            <Form.Item name="name" label="名称" rules={[{ required: true }]}>
              <Input placeholder="例如: Official Claude" />
            </Form.Item>
            <Form.Item name="api_key" label="API Key" rules={[{ required: true }]}>
              <Input.Password placeholder="ANTHROPIC_AUTH_TOKEN" />
            </Form.Item>
            <Form.Item name="base_url" label="Base URL">
              <Input placeholder="ANTHROPIC_BASE_URL (可选)" />
            </Form.Item>
            <Form.Item name="model_ids" label="Model IDs (可添加多个)">
              <ModelListInput />
            </Form.Item>
            <Form.Item name="website_url" label="官网">
              <Input placeholder="Provider 官网链接 (可选)" />
            </Form.Item>
            <Form.Item name="api_timeout" label="超时时间 (ms)">
              <Input placeholder="API_TIMEOUT_MS (默认 3000000)" />
            </Form.Item>
            <Form.Item name="disable_traffic" label="禁用非必要流量" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Form>
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
