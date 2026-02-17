import { useState, useEffect, useRef } from 'react';
import { Form, Input, Button, Card, message, Divider, Tag, Table, Empty, Modal, Space, Menu, Tabs, Checkbox } from 'antd';
import { SaveOutlined, ApiOutlined, SettingOutlined, DeleteOutlined, EyeOutlined, FolderOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { usePty } from './hooks/usePty';
import TerminalComponent from './components/Terminal';
import logo from '../../logo.png';
import './App.css';

interface AppConfig {
  app_id: string;
  app_secret: string;
  encrypt_key?: string;
  verification_token?: string;
  chat_id?: string;
  hook_events_filter?: string;
}

interface Project {
  id: number;
  name: string;
  path: string;
  hooks_installed: boolean;
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

function App() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string>('project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [hookRecords, setHookRecords] = useState<HookRecord[]>([]);
  const [hookRecordsTotal, setHookRecordsTotal] = useState(0);
  const [hookRecordsPage, setHookRecordsPage] = useState(1);
  const [hookRecordsLoading, setHookRecordsLoading] = useState(false);
  const [hookRecordSelection, setHookRecordSelection] = useState<number[]>([]);
  const [hookDetailOpen, setHookDetailOpen] = useState(false);
  const [hookDetailRecord, setHookDetailRecord] = useState<HookRecord | null>(null);
  const { startPty, write } = usePty();
  const tauriAvailable = isTauri();
  const inputBufferRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!tauriAvailable) {
      return;
    }
    loadConfig();
    fetchProjects();
  }, []);

  // 打开项目详情时启动 PTY
  useEffect(() => {
    if (activeMenu === 'project-detail' && selectedProject && tauriAvailable) {
      startPty(selectedProject.path);
    }
  }, [activeMenu, selectedProject]);

  useEffect(() => {
    if (!tauriAvailable || activeMenu !== 'project-detail' || !selectedProject) {
      setTerminalHistory([]);
      return;
    }
    invoke<string[]>('get_terminal_history', { projectPath: selectedProject.path })
      .then((history) => {
        setTerminalHistory(history);
      })
      .catch(() => {
        setTerminalHistory([]);
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
    write(data);
    if (!tauriAvailable || !selectedProject) {
      return;
    }
    const projectPath = selectedProject.path;
    let buffer = inputBufferRef.current[projectPath] || '';
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (char === '\r' || char === '\n') {
        buffer = '';
        continue;
      }
      if (code === 127) {
        buffer = buffer.slice(0, -1);
        continue;
      }
      if (code >= 32 && char !== '\x1b') {
        buffer += char;
      }
    }
    inputBufferRef.current[projectPath] = buffer;
  };

  const handleEnterProject = (project: Project) => {
    setSelectedProject(project);
    setActiveMenu('project-detail');
  };

  const handleBackToProjects = () => {
    setSelectedProject(null);
    setActiveMenu('project');
  };

  const loadConfig = async () => {
    if (!tauriAvailable) {
      return;
    }
    try {
      const config = await invoke<AppConfig>('get_config');
      form.setFieldsValue(config);
    } catch (error) {
      message.error(`加载配置失败: ${error}`);
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
      const response = await invoke<HookRecordsResponse>('get_hook_records', { projectPath: selectedProject.path, page, pageSize: 20 });
      setHookRecords(response.records);
      setHookRecordsTotal(response.total);
      setHookRecordsPage(response.page);
    } catch (error) {
      message.error(`加载 Hooks 记录失败: ${error}`);
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

  const handleDeleteHookRecord = async (id: number) => {
    if (!tauriAvailable || !selectedProject) {
      message.warning('请在桌面应用中删除记录');
      return;
    }
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这条 Hooks 记录吗？',
      onOk: async () => {
        try {
          await invoke('delete_hook_record', { projectPath: selectedProject.path, id });
          message.success('删除成功');
          setHookRecordSelection((prev) => prev.filter((item) => item !== id));
          fetchHookRecords(hookRecordsPage);
        } catch (error) {
          message.error(`删除失败: ${error}`);
        }
      },
    });
  };

  const handleDeleteHookRecords = async () => {
    if (!tauriAvailable || !selectedProject) {
      message.warning('请在桌面应用中删除记录');
      return;
    }
    if (hookRecordSelection.length === 0) {
      return;
    }
    Modal.confirm({
      title: '确认批量删除',
      content: `确定要删除选中的 ${hookRecordSelection.length} 条 Hooks 记录吗？`,
      onOk: async () => {
        try {
          await invoke('delete_hook_records', { projectPath: selectedProject.path, ids: hookRecordSelection });
          message.success('批量删除成功');
          setHookRecordSelection([]);
          fetchHookRecords(hookRecordsPage);
        } catch (error) {
          message.error(`批量删除失败: ${error}`);
        }
      },
    });
  };

  const handleSave = async (values: AppConfig) => {
    if (!tauriAvailable) {
      message.warning('请在桌面应用中保存配置');
      return;
    }
    setLoading(true);
    try {
      await invoke('save_config', { config: values });
      message.success('配置保存成功');
    } catch (error) {
      message.error(`保存配置失败: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTestConnection = async () => {
    if (!tauriAvailable) {
      message.warning('请在桌面应用中测试连接');
      return;
    }
    const appId = form.getFieldValue('app_id');
    const appSecret = form.getFieldValue('app_secret');

    if (!appId || !appSecret) {
      message.warning('请先填写 App ID 和 App Secret');
      return;
    }

    setTestingConnection(true);
    try {
      const result = await invoke<string>('test_feishu_connection', { appId, appSecret });
      message.success(result);
    } catch (error) {
      message.error(`测试失败: ${error}`);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleAddProject = async () => {
    if (!tauriAvailable) {
      message.warning('请在桌面应用中添加项目');
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
        message.success(`项目 "${name}" 添加成功`);
      } catch (error) {
        message.error(`添加项目失败: ${error}`);
      }
    }
  };

  const handleDeleteProject = (id: number) => {
    if (!tauriAvailable) {
      message.warning('请在桌面应用中删除项目');
      return;
    }
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这个项目吗？',
      onOk: async () => {
        try {
          await invoke('delete_project', { id });
          setProjects(projects.filter(p => p.id !== id));
          message.success('删除成功');
        } catch (error) {
          message.error(`删除项目失败: ${error}`);
        }
      },
    });
  };

  const handleInstallHooks = async (project: Project) => {
    if (!tauriAvailable) {
      message.warning('请在桌面应用中安装 Hooks');
      return;
    }
    try {
      await invoke('install_hooks', { projectPath: project.path });
      await invoke('set_project_hooks_status', { id: project.id, hooksInstalled: true });
      setProjects(projects.map(p => p.id === project.id ? { ...p, hooks_installed: true } : p));
      message.success('Hooks 安装成功');
    } catch (error) {
      message.error(`安装Hooks失败: ${error}`);
    }
  };

  const handleUninstallHooks = async (project: Project) => {
    if (!tauriAvailable) {
      message.warning('请在桌面应用中卸载 Hooks');
      return;
    }
    try {
      await invoke('uninstall_hooks', { projectPath: project.path });
      await invoke('set_project_hooks_status', { id: project.id, hooksInstalled: false });
      setProjects(projects.map(p => p.id === project.id ? { ...p, hooks_installed: false } : p));
      message.success('Hooks 已卸载');
    } catch (error) {
      message.error(`卸载Hooks失败: ${error}`);
    }
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div className="logo">
            <img src={logo} alt="logo" className="logo-img" />
            <h1>Sparky</h1>
          </div>
          <p className="subtitle">多渠道集成 · 随时随地链接 Claude Code</p>
        </div>
      </header>

      <main className="app-main">
        <div className="app-layout">
          <aside className="app-sidebar">
            <Menu
              mode="inline"
              selectedKeys={[activeMenu]}
              onClick={(e) => setActiveMenu(e.key)}
              style={{ height: '100%', borderRight: 0 }}
              items={[
                { key: 'project', icon: <SettingOutlined />, label: '项目' },
                { key: 'settings', icon: <ApiOutlined />, label: '设置' },
                { key: 'help', icon: <EyeOutlined />, label: '帮助' },
              ]}
            />
          </aside>
          <div className="app-content">
            {activeMenu === 'project' && (
              <div className="project-page">
                <Card variant="borderless">
                  <div className="card-header">
                    <h2>项目管理</h2>
                    <Button type="primary" icon={<SaveOutlined />} onClick={handleAddProject} style={{ marginLeft: 'auto' }}>
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
                        { title: '项目名称', dataIndex: 'name', key: 'name' },
                        { title: '路径', dataIndex: 'path', key: 'path' },
                        {
                          title: 'Hooks 状态',
                          key: 'hooks',
                          render: (_: any, record: Project) => (
                            <Tag color={record.hooks_installed ? 'black' : 'default'}>
                              {record.hooks_installed ? '已安装' : '未安装'}
                            </Tag>
                          ),
                        },
                        {
                          title: '操作',
                          key: 'action',
                          render: (_: any, record: Project) => (
                            <Space>
                              <Button size="small" className="action-btn" onClick={() => handleEnterProject(record)}>
                                进入
                              </Button>
                              <Button size="small" className="action-btn" onClick={() => record.hooks_installed ? handleUninstallHooks(record) : handleInstallHooks(record)}>
                                {record.hooks_installed ? '卸载' : '安装'}
                              </Button>
                              <Button size="small" className="action-btn danger" icon={<DeleteOutlined />} onClick={() => handleDeleteProject(record.id)} />
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
                <Card variant="borderless">
                  <div className="card-header">
                    <Button icon={<ArrowLeftOutlined />} onClick={handleBackToProjects} style={{ marginRight: 12 }}>
                      返回
                    </Button>
                    <h2>{selectedProject.name}</h2>
                  </div>
                  <Tabs
                    defaultActiveKey="claude"
                    items={[
                      {
                        key: 'claude',
                        label: 'Claude',
                        children: (
                          <div style={{ height: '500px' }}>
                            <TerminalComponent projectPath={selectedProject.path} onData={handleTerminalInput} mergeTop historyLines={terminalHistory} />
                          </div>
                        ),
                      },
                      {
                        key: 'detail',
                        label: '详情',
                        children: (
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
                              <span className="status-label">Hooks 状态</span>
                              <Tag color={selectedProject.hooks_installed ? 'black' : 'default'}>
                                {selectedProject.hooks_installed ? '已安装' : '未安装'}
                              </Tag>
                            </div>
                            <Divider />
                            <Space>
                              <Button type="primary" icon={<FolderOutlined />} onClick={() => {
                                message.info('项目路径: ' + selectedProject.path);
                              }}>
                                打开文件夹
                              </Button>
                              <Button icon={<SettingOutlined />} onClick={() => selectedProject.hooks_installed ? handleUninstallHooks(selectedProject) : handleInstallHooks(selectedProject)}>
                                {selectedProject.hooks_installed ? '卸载 Hooks' : '安装 Hooks'}
                              </Button>
                            </Space>
                            <Divider />
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                              <Button danger disabled={hookRecordSelection.length === 0} onClick={handleDeleteHookRecords}>
                                批量删除
                              </Button>
                            </div>
                            <Table
                              dataSource={hookRecords}
                              rowKey="id"
                              loading={hookRecordsLoading}
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
                                { title: '摘要', dataIndex: 'notification_text', key: 'notification_text' },
                                { title: '结果', dataIndex: 'result', key: 'result', width: 180 },
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
                              title="Hooks 记录详情"
                              open={hookDetailOpen}
                              onCancel={() => setHookDetailOpen(false)}
                              footer={null}
                              destroyOnClose
                            >
                              {hookDetailRecord && (
                                <div>
                                  <div className="status-row">
                                    <span className="status-label">事件</span>
                                    <span className="status-value">{hookDetailRecord.event_name}</span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">会话</span>
                                    <span className="status-value">{hookDetailRecord.session_id}</span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">时间</span>
                                    <span className="status-value">{formatHookTime(hookDetailRecord.created_at)}</span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">结果</span>
                                    <span className="status-value">{hookDetailRecord.result}</span>
                                  </div>
                                  <Divider />
                                  <div className="status-row">
                                    <span className="status-label">摘要</span>
                                    <span className="status-value">{hookDetailRecord.notification_text}</span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">内容</span>
                                    <span className="status-value" style={{ whiteSpace: 'pre-wrap' }}>
                                      {hookDetailRecord.content}
                                    </span>
                                  </div>
                                  <div className="status-row">
                                    <span className="status-label">Transcript</span>
                                    <span className="status-value" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
                                      {hookDetailRecord.transcript_path}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </Modal>
                          </div>
                        ),
                      },
                    ]}
                  />
                </Card>
              </div>
            )}

            {activeMenu === 'settings' && (
              <div className="settings-page">
                <div className="main-grid">
                  <div className="left-column">
                    <Card className="projects-card channel-card" variant="borderless">
                      <div className="card-header">
                        <ApiOutlined className="card-icon" />
                        <h2>渠道设置</h2>
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
                                <Card className="config-card" variant="borderless">
                                  <div className="card-header">
                                    <ApiOutlined className="card-icon" />
                                    <h2>飞书应用配置</h2>
                                  </div>
                                  <p className="card-description">配置飞书开放平台应用凭证，启用长连接模式实现消息推送与接收</p>
                                  <Divider />
                                  <Form form={form} layout="vertical" onFinish={handleSave} className="config-form">
                                    <Form.Item label="App ID" name="app_id" rules={[{ required: true, message: '请输入 App ID' }]}>
                                      <Input placeholder="cli_xxxxxxxxxxxxxxxx" size="large" className="input-field" />
                                    </Form.Item>
                                    <Form.Item label="App Secret" name="app_secret" rules={[{ required: true, message: '请输入 App Secret' }]}>
                                      <Input.Password placeholder="应用密钥" size="large" className="input-field" />
                                    </Form.Item>
                                    <Form.Item label="默认群聊 ID" name="chat_id" extra="可选">
                                      <Input placeholder="oc_xxxxxxxxxxxxxxxxxxxxxxxx" size="large" className="input-field" />
                                    </Form.Item>
                                    <Form.Item label="Encrypt Key" name="encrypt_key" extra="可选">
                                      <Input.Password placeholder="加密密钥" size="large" className="input-field" />
                                    </Form.Item>
                                    <Form.Item label="Verification Token" name="verification_token" extra="可选">
                                      <Input.Password placeholder="验证令牌" size="large" className="input-field" />
                                    </Form.Item>
                                    <Form.Item
                                      label="Hook 事件过滤"
                                      name="hook_events_filter"
                                      extra="选择需要推送到飞书的事件类型，不选则推送全部事件"
                                      getValueFromEvent={(checkedValues: string[]) => checkedValues.length > 0 ? checkedValues.join(',') : undefined}
                                      getValueProps={(value: string | undefined) => ({
                                        value: value ? value.split(',').map((s: string) => s.trim()) : [],
                                      })}
                                    >
                                      <Checkbox.Group
                                        options={[
                                          { label: '🛑 Stop（任务结束）', value: 'Stop' },
                                          { label: '🔐 PermissionRequest（权限确认）', value: 'PermissionRequest' },
                                          { label: '📌 Notification（通知）', value: 'Notification' },
                                          { label: '📝 UserPromptSubmit（用户输入）', value: 'UserPromptSubmit' },
                                        ]}
                                        style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
                                      />
                                    </Form.Item>
                                    <div className="action-buttons">
                                      <Button type="default" icon={<ApiOutlined />} onClick={handleTestConnection} loading={testingConnection} size="large">测试连接</Button>
                                      <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading} size="large">保存配置</Button>
                                    </div>
                                  </Form>
                                </Card>
                              ),
                            },
                            {
                              key: 'dingtalk',
                              label: '钉钉',
                              children: (
                                <Card className="config-card" variant="borderless">
                                  <div className="card-header">
                                    <ApiOutlined className="card-icon" />
                                    <h2>钉钉应用配置</h2>
                                  </div>
                                  <p className="card-description">等待开发</p>
                                </Card>
                              ),
                            },
                            {
                              key: 'wework',
                              label: '企业微信',
                              children: (
                                <Card className="config-card" variant="borderless">
                                  <div className="card-header">
                                    <ApiOutlined className="card-icon" />
                                    <h2>企业微信应用配置</h2>
                                  </div>
                                  <p className="card-description">等待开发</p>
                                </Card>
                              ),
                            },
                          ]}
                        />
                      </div>
                    </Card>
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
                        <li><span className="step-number">5</span><span className="step-text">为项目安装 Hooks</span></li>
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
                    <Card variant="borderless">
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
      </main>

      <footer className="app-footer">
        <p>Sparky © 2026 你的随身助手</p>
      </footer>
    </div>
  );
}

export default App;
