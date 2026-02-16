import { useState, useEffect } from 'react';
import { Form, Input, Button, Card, message, Divider, Tag, Table, Empty, Modal, Space, Menu, Tabs } from 'antd';
import { SaveOutlined, ApiOutlined, SettingOutlined, DeleteOutlined, EyeOutlined, FolderOutlined, ArrowLeftOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
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
}

interface Project {
  id: number;
  name: string;
  path: string;
  hooks_installed: boolean;
}

function App() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string>('project');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const { startPty, write, getIsResumed } = usePty();

  useEffect(() => {
    loadConfig();
    fetchProjects();
  }, []);

  // 打开项目详情时启动 PTY
  useEffect(() => {
    if (activeMenu === 'project-detail' && selectedProject) {
      startPty(selectedProject.path);
    }
  }, [activeMenu, selectedProject]);

  const handleEnterProject = (project: Project) => {
    setSelectedProject(project);
    setActiveMenu('project-detail');
  };

  const handleBackToProjects = () => {
    setSelectedProject(null);
    setActiveMenu('project');
  };

  const loadConfig = async () => {
    try {
      const config = await invoke<AppConfig>('get_config');
      form.setFieldsValue(config);
    } catch (error) {
      message.error(`加载配置失败: ${error}`);
    }
  };

  const fetchProjects = async () => {
    try {
      const projectsData = await invoke<Project[]>('get_projects');
      setProjects(projectsData);
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  };

  const handleSave = async (values: AppConfig) => {
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
          <p className="subtitle">飞书集成 · 长连接模式</p>
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
                <Card bordered={false}>
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
                <Card bordered={false}>
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
                            <TerminalComponent onData={write} getIsResumed={getIsResumed} />
                          </div>
                        ),
                      },
                      {
                        key: 'detail',
                        label: '详情',
                        children: (
                          <div>
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
                    <Card className="config-card" bordered={false}>
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
                        <div className="action-buttons">
                          <Button type="default" icon={<ApiOutlined />} onClick={handleTestConnection} loading={testingConnection} size="large">测试连接</Button>
                          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading} size="large">保存配置</Button>
                        </div>
                      </Form>
                    </Card>
                  </div>
                </div>
              </div>
            )}

            {activeMenu === 'help' && (
              <div className="help-page">
                <div className="main-grid">
                  <div className="left-column">
                    <Card bordered={false}>
                      <h3>快速开始</h3>
                      <ol className="steps-list">
                        <li><span className="step-number">1</span><span className="step-text">创建飞书开放平台应用</span></li>
                        <li><span className="step-number">2</span><span className="step-text">开启机器人能力并配置权限</span></li>
                        <li><span className="step-number">3</span><span className="step-text">复制应用凭证到设置页面</span></li>
                        <li><span className="step-number">4</span><span className="step-text">在项目管理中添加项目</span></li>
                        <li><span className="step-number">5</span><span className="step-text">为项目安装 Hooks</span></li>
                      </ol>
                    </Card>
                    <Card bordered={false}>
                      <h3>所需权限</h3>
                      <div className="permissions-list">
                        <div className="permission-item"><code>im:message</code><span>获取与发送消息</span></div>
                        <div className="permission-item"><code>im:message.group_at_msg</code><span>接收群聊@消息</span></div>
                        <div className="permission-item"><code>im:message.p2p_msg</code><span>接收单聊消息</span></div>
                      </div>
                    </Card>
                  </div>
                  <div className="right-column">
                    <Card bordered={false}>
                      <h3>关于 Sparky</h3>
                      <p>Sparky 是一个集成了 Claude Code 与飞书的桌面应用，可以实时监控 Claude Code 的运行状态，并通过飞书发送通知。</p>
                      <Divider />
                      <p className="version-info">版本: 0.1.0</p>
                      <p className="tech-info">基于 Tauri + React 构建</p>
                    </Card>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <p>Sparky v0.1.0 · 基于 Tauri 构建</p>
      </footer>
    </div>
  );
}

export default App;
