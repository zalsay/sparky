import { useState, useEffect, useRef } from 'react';
import { Form, Input, Button, Card, message, Divider, Tabs, Tag, Table, Empty, Modal, Space } from 'antd';
import { SaveOutlined, ApiOutlined, SettingOutlined, HomeOutlined, ReloadOutlined, DeleteOutlined, EyeOutlined, ConsoleSqlOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { usePty } from './hooks/usePty';
import TerminalComponent from './components/Terminal';
import './App.css';

interface AppConfig {
  app_id: string;
  app_secret: string;
  encrypt_key?: string;
  verification_token?: string;
  chat_id?: string;
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

interface HookStatus {
  last_event_name?: string | null;
  last_result?: string | null;
  last_event_at?: number | null;
}

function App() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [hookStatus, setHookStatus] = useState<HookStatus | null>(null);
  const [hookRecords, setHookRecords] = useState<HookRecord[]>([]);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [hooksPagination, setHooksPagination] = useState({ page: 1, pageSize: 20, total: 0 });
  const [wssStatus, setWssStatus] = useState<{ last_receive_time?: number; last_open_id?: string } | null>(null);
  const [terminalTabActive, setTerminalTabActive] = useState(false);
  const { startPty, write, kill } = usePty();

  useEffect(() => {
    loadConfig();
    fetchHooks();
    const timer = setInterval(fetchHooks, 5000);
    return () => clearInterval(timer);
  }, []);

  // 当终端标签页激活时启动 PTY
  const ptyStartedRef = useRef(false);

  useEffect(() => {
    if (terminalTabActive && !ptyStartedRef.current) {
      console.log('Starting PTY...');
      ptyStartedRef.current = true;
      startPty();
    }
  }, [terminalTabActive]);

  // 组件卸载时清理 PTY
  useEffect(() => {
    return () => {
      console.log('Cleaning up PTY on unmount...');
      kill();
    };
  }, []);

  const loadConfig = async () => {
    try {
      const config = await invoke<AppConfig>('get_config');
      form.setFieldsValue(config);
    } catch (error) {
      message.error(`加载配置失败: ${error}`);
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
      const result = await invoke<string>('test_feishu_connection', { 
        appId, 
        appSecret 
      });
      message.success(result);
    } catch (error) {
      message.error(`测试失败: ${error}`);
    } finally {
      setTestingConnection(false);
    }
  };

  const fetchHooks = async (page: number = 1) => {
    setHooksLoading(true);
    try {
      const [status, recordsRes, wss] = await Promise.all([
        invoke<HookStatus>('get_hook_status'),
        invoke<HookRecordsResponse>('get_hook_records', { page, pageSize: 20 }),
        invoke<{ last_receive_time?: number; last_open_id?: string }>('get_wss_status').catch(() => ({}))
      ]);
      setHookStatus(status);
      setHookRecords(recordsRes.records);
      setHooksPagination({ page: recordsRes.page, pageSize: recordsRes.page_size, total: recordsRes.total });
      setWssStatus(wss);
    } catch (error) {
      message.error(`加载 hooks 记录失败: ${error}`);
    } finally {
      setHooksLoading(false);
    }
  };

  const lastEventAt = hookStatus?.last_event_at ?? null;
  const isOnline = lastEventAt ? Date.now() - lastEventAt < 120000 : false;
  const statusText = isOnline ? '在线' : '离线';
  const statusColor = isOnline ? 'green' : 'default';
  const lastEventName = hookStatus?.last_event_name ?? '暂无';
  const lastResult = hookStatus?.last_result ?? '暂无';
  const lastEventTime = lastEventAt
    ? new Date(lastEventAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '暂无';

  const columns = [
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (value: number) => new Date(value).toLocaleString(),
    },
    {
      title: '事件',
      dataIndex: 'event_name',
      key: 'event_name',
      width: 150,
      render: (value: string) => <Tag color="blue">{value}</Tag>,
    },
    {
      title: 'Session',
      dataIndex: 'session_id',
      key: 'session_id',
      width: 120,
      render: (value: string) => <span style={{ fontSize: '12px', color: '#888' }}>{value.slice(0, 12)}</span>,
    },
    {
      title: 'CWD',
      dataIndex: 'content',
      key: 'cwd',
      width: 150,
      render: (_: string, record: HookRecord) => {
        const match = record.content?.match(/\*\*CWD\*\*: (.+)/);
        const cwd = match ? match[1] : '';
        return <span style={{ fontSize: '12px', color: '#666' }} title={cwd}>{cwd.split('/').slice(-2).join('/')}</span>;
      },
    },
    {
      title: '摘要',
      dataIndex: 'notification_text',
      key: 'notification_text',
      render: (_: string, record: HookRecord) => {
        const text = record.notification_text || '';
        return (
          <span
            className="summary-text"
            style={{ cursor: 'pointer', color: '#1890ff' }}
            onClick={() => {
              Modal.info({
                title: 'Hook 详情',
                width: 600,
                content: (
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: 1.6 }}>
                    {record.content || '无内容'}
                  </div>
                ),
                onOk() {},
              });
            }}
          >
            {text.slice(0, 40)}{text.length > 40 ? '...' : ''}
          </span>
        );
      },
    },
    {
      title: '结果',
      dataIndex: 'result',
      key: 'result',
      width: 80,
      render: (value: string) => (
        <Tag color={value.startsWith('failed') ? 'red' : value === 'sent' ? 'green' : 'orange'}>
          {value}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, record: HookRecord) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => {
              Modal.info({
                title: 'Hook 详情',
                width: 600,
                content: (
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: 1.6 }}>
                    {record.content || '无内容'}
                  </div>
                ),
              });
            }}
          />
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => {
              Modal.confirm({
                title: '确认删除',
                content: '确定要删除这条记录吗？',
                onOk: async () => {
                  try {
                    await invoke('delete_hook_record', { id: record.id });
                    message.success('删除成功');
                    fetchHooks();
                  } catch (error) {
                    message.error(`删除失败: ${error}`);
                  }
                },
              });
            }}
          />
        </Space>
      ),
    },
  ];

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <div className="logo">
            <span className="logo-icon">●</span>
            <h1>Claude Monitor</h1>
          </div>
          <p className="subtitle">飞书集成 · 长连接模式</p>
        </div>
      </header>

      <main className="app-main">
        <Tabs
          className="app-tabs"
          defaultActiveKey="home"
          onChange={(key) => setTerminalTabActive(key === 'terminal')}
          items={[
            {
              key: 'home',
              label: (
                <span>
                  <HomeOutlined /> 主页
                </span>
              ),
              children: (
                <div className="main-grid">
                  <div className="left-column">
                    <Card className="config-card" bordered={false}>
                      <div className="card-header">
                        <SettingOutlined className="card-icon" />
                        <h2>Claude 连接状态</h2>
                      </div>
                      <Divider />
                      <div className="status-row">
                        <span className="status-label">状态</span>
                        <Tag color={statusColor}>{statusText}</Tag>
                      </div>
                      <div className="status-row">
                        <span className="status-label">最近事件</span>
                        <span className="status-value">{lastEventName}</span>
                      </div>
                      <div className="status-row">
                        <span className="status-label">上行 (发送到飞书)</span>
                        <span className="status-value">{lastEventTime}</span>
                      </div>
                      <div className="status-row">
                        <span className="status-label">下行 (收到消息)</span>
                        <span className="status-value">
                          {wssStatus?.last_receive_time
                            ? new Date(wssStatus.last_receive_time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                            : '暂无'}
                        </span>
                      </div>
                      <div className="status-row">
                        <span className="status-label">最近结果</span>
                        <Tag color={lastResult === 'sent' ? 'green' : lastResult.startsWith('failed') ? 'red' : 'orange'}>
                          {lastResult}
                        </Tag>
                      </div>
                    </Card>
                  </div>

                  <div className="right-column">
                    <Card className="help-card" bordered={false}>
                      <div className="card-header">
                        <SettingOutlined className="card-icon" />
                        <h2>Hooks 记录</h2>
                        <Space style={{ marginLeft: 'auto' }}>
                          {selectedRowKeys.length > 0 && (
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              onClick={() => {
                                Modal.confirm({
                                  title: '批量删除',
                                  content: `确定要删除选中的 ${selectedRowKeys.length} 条记录吗？`,
                                  onOk: async () => {
                                    try {
                                      await invoke('delete_hook_records', { ids: selectedRowKeys.map(k => Number(k)) });
                                      message.success('删除成功');
                                      setSelectedRowKeys([]);
                                      fetchHooks();
                                    } catch (error) {
                                      message.error(`删除失败: ${error}`);
                                    }
                                  },
                                });
                              }}
                            >
                              删除选中 ({selectedRowKeys.length})
                            </Button>
                          )}
                          <Button
                            type="text"
                            icon={<ReloadOutlined />}
                            onClick={() => fetchHooks(1)}
                            loading={hooksLoading}
                          />
                        </Space>
                      </div>
                      <Divider />
                      {hookRecords.length === 0 ? (
                        <Empty description="暂无记录" />
                      ) : (
                        <Table
                          columns={columns}
                          dataSource={hookRecords}
                          rowKey="id"
                          loading={hooksLoading}
                          pagination={{
                            current: hooksPagination.page,
                            pageSize: hooksPagination.pageSize,
                            total: hooksPagination.total,
                            onChange: (page) => fetchHooks(page),
                            showSizeChanger: false,
                          }}
                          size="small"
                          scroll={{ y: 400 }}
                          rowSelection={{
                            selectedRowKeys,
                            onChange: (keys) => setSelectedRowKeys(keys),
                          }}
                        />
                      )}
                    </Card>
                  </div>
                </div>
              ),
            },
            {
              key: 'settings',
              label: (
                <span>
                  <SettingOutlined /> 设置
                </span>
              ),
              children: (
                <div className="main-grid">
                  <div className="left-column">
                    <Card className="config-card" bordered={false}>
                      <div className="card-header">
                        <SettingOutlined className="card-icon" />
                        <h2>应用配置</h2>
                      </div>
                      
                      <p className="card-description">
                        配置飞书开放平台应用凭证，启用长连接模式实现消息推送与接收
                      </p>

                      <Divider />

                      <Form
                        form={form}
                        layout="vertical"
                        onFinish={handleSave}
                        className="config-form"
                      >
                        <Form.Item
                          label="App ID"
                          name="app_id"
                          rules={[{ required: true, message: '请输入 App ID' }]}
                        >
                          <Input 
                            placeholder="cli_xxxxxxxxxxxxxxxx" 
                            size="large"
                            className="input-field"
                          />
                        </Form.Item>

                        <Form.Item
                          label="App Secret"
                          name="app_secret"
                          rules={[{ required: true, message: '请输入 App Secret' }]}
                        >
                          <Input.Password 
                            placeholder="应用密钥" 
                            size="large"
                            className="input-field"
                          />
                        </Form.Item>

                        <Form.Item
                          label="默认群聊 ID"
                          name="chat_id"
                          extra="可选 · 发送消息的目标群聊 ID，可在群聊信息中查看"
                        >
                          <Input 
                            placeholder="oc_xxxxxxxxxxxxxxxxxxxxxxxx" 
                            size="large"
                            className="input-field"
                          />
                        </Form.Item>

                        <Form.Item
                          label="Encrypt Key"
                          name="encrypt_key"
                          extra="可选 · 用于消息加密"
                        >
                          <Input.Password 
                            placeholder="加密密钥" 
                            size="large"
                            className="input-field"
                          />
                        </Form.Item>

                        <Form.Item
                          label="Verification Token"
                          name="verification_token"
                          extra="可选 · 用于验证消息来源"
                        >
                          <Input.Password 
                            placeholder="验证令牌" 
                            size="large"
                            className="input-field"
                          />
                        </Form.Item>

                        <div className="action-buttons">
                          <Button
                            type="default"
                            icon={<ApiOutlined />}
                            onClick={handleTestConnection}
                            loading={testingConnection}
                            size="large"
                            className="test-button"
                          >
                            测试连接
                          </Button>
                          
                          <Button
                            type="primary"
                            htmlType="submit"
                            icon={<SaveOutlined />}
                            loading={loading}
                            size="large"
                            className="save-button"
                          >
                            保存配置
                          </Button>
                        </div>
                      </Form>
                    </Card>
                  </div>

                  <div className="right-column">
                    <Card className="help-card" bordered={false}>
                      <h3>快速开始</h3>
                      <ol className="steps-list">
                        <li>
                          <span className="step-number">1</span>
                          <span className="step-text">创建飞书开放平台应用</span>
                        </li>
                        <li>
                          <span className="step-number">2</span>
                          <span className="step-text">开启机器人能力并配置权限</span>
                        </li>
                        <li>
                          <span className="step-number">3</span>
                          <span className="step-text">复制应用凭证到左侧表单</span>
                        </li>
                        <li>
                          <span className="step-number">4</span>
                          <span className="step-text">配置事件订阅（长连接模式）</span>
                        </li>
                        <li>
                          <span className="step-number">5</span>
                          <span className="step-text">配置 Claude Code Hooks</span>
                        </li>
                      </ol>
                    </Card>

                    <Card className="permissions-card" bordered={false}>
                      <h3>所需权限</h3>
                      <div className="permissions-list">
                        <div className="permission-item">
                          <code>im:message</code>
                          <span>获取与发送消息</span>
                        </div>
                        <div className="permission-item">
                          <code>im:message.group_at_msg</code>
                          <span>接收群聊@消息</span>
                        </div>
                        <div className="permission-item">
                          <code>im:message.p2p_msg</code>
                          <span>接收单聊消息</span>
                        </div>
                        <div className="permission-item">
                          <code>im:message:send_as_bot</code>
                          <span>以应用身份发消息</span>
                        </div>
                      </div>
                    </Card>
                  </div>
                </div>
              ),
            },
            {
              key: 'terminal',
              label: (
                <span>
                  <ConsoleSqlOutlined /> 终端
                </span>
              ),
              children: (
                <div style={{ height: '100%', padding: '16px' }}>
                  <Card
                    bordered={false}
                    style={{ height: '100%' }}
                    bodyStyle={{ height: '100%', padding: 0 }}
                  >
                    <TerminalComponent onData={(data) => write(data)} />
                  </Card>
                </div>
              ),
            },
          ]}
        />
      </main>

      <footer className="app-footer">
        <p>Claude Monitor v0.1.0 · 基于 Tauri 构建</p>
      </footer>
    </div>
  );
}

export default App;
