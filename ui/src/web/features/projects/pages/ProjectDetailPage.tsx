import { useMemo } from 'react';
import {
  Button,
  Card,
  Divider,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Splitter,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  HistoryOutlined,
  MenuOutlined,
  PlayCircleOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';

import Terminal from '../../../../components/Terminal';
import type { IDETab, Project, SessionInfo } from '../../../types';

interface ProjectDetailPageProps {
  project: Project;
  terminalId: string;
  historyLines: string[];
  terminalReady: boolean;
  terminalStatus: string;
  sessions: SessionInfo[];
  sessionModalOpen: boolean;
  editingSessionId: string | null;
  editingSessionName: string;
  fullAuth: boolean;
  splitterSizes: number[] | string[];
  ideTabs: Array<IDETab & { reloadKey: number; hasLoadError: boolean }>;
  activeIdeTabId: string;
  newTabModalOpen: boolean;
  newTabUrl: string;
  recentUrlsForProject: string[];
  onBack: () => void;
  onToggleFullAuth: () => void;
  onStartSession: () => void | Promise<void>;
  onOpenSessionModal: () => void | Promise<void>;
  onCloseSessionModal: () => void;
  onResumeSession: (sessionId: string) => void | Promise<void>;
  onUpdateSessionName: (sessionId: string, name: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onEditingSessionIdChange: (value: string | null) => void;
  onEditingSessionNameChange: (value: string) => void;
  onSplitterResize: (sizes: number[] | string[]) => void;
  onActiveIdeTabChange: (tabId: string) => void;
  onOpenNewTabModal: () => void;
  onCloseNewTabModal: () => void;
  onNewTabUrlChange: (value: string) => void;
  onCreateIdeTab: (rawUrl?: string) => void;
  onRemoveIdeTab: (tabId: string) => void;
  onReloadIdeTab: (tabId: string) => void;
  onIdeTabLoadErrorChange: (tabId: string, hasError: boolean) => void;
}

function formatSessionTime(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'string') {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && value.trim() !== '') {
      value = numericValue;
    } else {
      const parsedTime = Date.parse(value);
      return Number.isNaN(parsedTime) ? '—' : new Date(parsedTime).toLocaleString();
    }
  }

  const time = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(time).toLocaleString();
}

export default function ProjectDetailPage({
  project,
  terminalId,
  historyLines,
  terminalReady,
  terminalStatus,
  sessions,
  sessionModalOpen,
  editingSessionId,
  editingSessionName,
  fullAuth,
  splitterSizes,
  ideTabs,
  activeIdeTabId,
  newTabModalOpen,
  newTabUrl,
  recentUrlsForProject,
  onBack,
  onToggleFullAuth,
  onStartSession,
  onOpenSessionModal,
  onCloseSessionModal,
  onResumeSession,
  onUpdateSessionName,
  onDeleteSession,
  onEditingSessionIdChange,
  onEditingSessionNameChange,
  onSplitterResize,
  onActiveIdeTabChange,
  onOpenNewTabModal,
  onCloseNewTabModal,
  onNewTabUrlChange,
  onCreateIdeTab,
  onRemoveIdeTab,
  onReloadIdeTab,
  onIdeTabLoadErrorChange,
}: ProjectDetailPageProps) {
  const sessionColumns = useMemo(
    () => [
      {
        title: '会话名称',
        dataIndex: 'name',
        key: 'name',
        width: 240,
        render: (text: string | null, record: SessionInfo) =>
          editingSessionId === record.session_id ? (
            <Space.Compact style={{ width: '100%' }}>
              <Input
                size="small"
                autoFocus
                value={editingSessionName}
                onChange={(e) => onEditingSessionNameChange(e.target.value)}
                onPressEnter={() => void onUpdateSessionName(record.session_id, editingSessionName)}
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => void onUpdateSessionName(record.session_id, editingSessionName)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={() => onEditingSessionIdChange(null)} />
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
                  onEditingSessionNameChange(text || '');
                  onEditingSessionIdChange(record.session_id);
                }}
              />
            </Space>
          ),
      },
      {
        title: 'Session ID',
        dataIndex: 'session_id',
        key: 'session_id',
        width: 160,
        render: (text: string) => (
          <Typography.Text copyable style={{ fontSize: 12 }}>
            {text.length > 8 ? `${text.slice(0, 8)}...` : text}
          </Typography.Text>
        ),
      },
      {
        title: '开始时间',
        dataIndex: 'started_at',
        key: 'started_at',
        width: 180,
        render: (value: number | null) => formatSessionTime(value),
      },
      {
        title: '状态',
        key: 'status',
        width: 100,
        render: (_: unknown, record: SessionInfo) => (
          <Tag color={record.ended_at ? 'default' : 'green'}>{record.ended_at ? record.reason || '已结束' : '运行中'}</Tag>
        ),
      },
      {
        title: '操作',
        key: 'action',
        width: 160,
        render: (_: unknown, record: SessionInfo) => (
          <Space>
            <Button size="small" type="primary" onClick={() => void onResumeSession(record.session_id)}>
              继续
            </Button>
            <Popconfirm
              title="确定要删除该会话记录吗？"
              okText="是"
              cancelText="否"
              onConfirm={() => void onDeleteSession(record.session_id)}
            >
              <Button size="small" type="text" danger>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [
      editingSessionId,
      editingSessionName,
      onDeleteSession,
      onEditingSessionIdChange,
      onEditingSessionNameChange,
      onResumeSession,
      onUpdateSessionName,
    ],
  );

  const ideTabItems = useMemo(
    () => ideTabs.map((tab) => ({
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
                onReloadIdeTab(tab.id);
              }}
            />
          </Tooltip>
        </span>
      ),
      closable: tab.closable !== false,
      children: (
        <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
          <iframe
            key={`${tab.id}-${tab.reloadKey}`}
            src={tab.url}
            title={tab.title}
            style={{
              flex: 1,
              width: '100%',
              height: '100%',
              border: 'none',
              borderRight: '1px solid var(--border-color)',
              display: 'block',
              background: 'var(--bg-primary)',
            }}
            allow="clipboard-read *; clipboard-write *; display-capture *"
            onLoad={() => onIdeTabLoadErrorChange(tab.id, false)}
            onError={() => onIdeTabLoadErrorChange(tab.id, true)}
          />
          {tab.hasLoadError && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)', color: '#fff', padding: 16, textAlign: 'center' }}>
              页面加载失败或被禁止嵌入，请尝试其他 URL。
            </div>
          )}
        </div>
      ),
    })),
    [ideTabs, onIdeTabLoadErrorChange, onReloadIdeTab],
  );

  return (
    <div className="project-page project-detail-page" style={{ height: '100%' }}>
      <Card className="projects-card" variant="borderless" style={{ height: '100%' }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ProjectOutlined className="card-icon" />
            <h2>{project.name}</h2>
            <Tag color={terminalStatus === 'offline' ? 'default' : 'green'}>
              {terminalStatus === 'offline' ? '终端离线' : 'Web Terminal'}
            </Tag>
          </div>
          <Button icon={<MenuOutlined />} onClick={onBack}>
            返回项目列表
          </Button>
        </div>

        <p className="card-description">浏览器模式项目详情：保留终端桥接、会话恢复与嵌入式 IDE 标签页。</p>
        <Divider />

        <Splitter style={{ height: '100%', width: '100%' }} onResize={onSplitterResize}>
          <Splitter.Panel size={splitterSizes[0]} collapsible min="30%" max="80%">
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
              <Tabs
                type="editable-card"
                size="small"
                activeKey={activeIdeTabId || undefined}
                onChange={onActiveIdeTabChange}
                onEdit={(targetKey, action) => {
                  if (action === 'add') {
                    onOpenNewTabModal();
                  } else if (action === 'remove' && typeof targetKey === 'string') {
                    onRemoveIdeTab(targetKey);
                  }
                }}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', marginTop: 0 }}
                className="terminal-tabs-inner settings-tabs"
                items={ideTabItems}
              />
              {ideTabItems.length === 0 && (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', padding: 24, textAlign: 'center' }}>
                  <div>
                    <div style={{ marginBottom: 8 }}>还没有自定义标签页</div>
                    <Button size="small" type="primary" onClick={onOpenNewTabModal}>
                      新建标签页
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Splitter.Panel>
          <Splitter.Panel size={splitterSizes[1]} collapsible min="20%" max="80%">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 360px', gap: 16, minHeight: 560, height: '100%' }}>
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <Space wrap>
                    <Tooltip title={fullAuth ? '完全授权模式 (--dangerously-skip-permissions)' : '安全模式 (进行权限管控)'}>
                      <Button
                        size="small"
                        type={fullAuth ? 'primary' : 'default'}
                        danger={fullAuth}
                        icon={<SafetyCertificateOutlined />}
                        onClick={onToggleFullAuth}
                      >
                        {fullAuth ? '完全授权' : '安全模式'}
                      </Button>
                    </Tooltip>
                    <Button size="small" icon={<PlayCircleOutlined />} onClick={() => void onStartSession()}>
                      新建会话
                    </Button>
                    <Button size="small" icon={<HistoryOutlined />} onClick={() => void onOpenSessionModal()}>
                      继续会话
                    </Button>
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    终端 ID: {terminalId}
                  </Typography.Text>
                </div>

                <div className="project-detail-card" style={{ flex: 1, minHeight: 480, overflow: 'hidden' }}>
                  {terminalReady ? (
                    <Terminal projectPath={project.path} terminalId={terminalId} title="Web Terminal" mergeTop historyLines={historyLines} />
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                      正在准备终端...
                    </div>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Card size="small" variant="borderless">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div>
                      <strong>项目名称：</strong>
                      {project.name}
                    </div>
                    <div>
                      <strong>项目路径：</strong>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all', marginTop: 4 }}>{project.path}</div>
                    </div>
                    <div>
                      <strong>Hooks：</strong>{' '}
                      <Tag color={project.hooks_installed || project.hooks_enabled ? 'black' : 'default'}>{project.hooks_installed || project.hooks_enabled ? '已安装' : '未安装'}</Tag>
                    </div>
                  </div>
                </Card>

                <Card size="small" variant="borderless" title="会话摘要">
                  {sessions.length === 0 ? (
                    <Empty description="暂无历史会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {sessions.slice(0, 5).map((session) => (
                        <div
                          key={session.session_id}
                          style={{
                            padding: '10px 12px',
                            border: '1px solid var(--border-color)',
                            borderRadius: 8,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {session.name || '未命名会话'}
                            </strong>
                            <Tag color={session.ended_at ? 'default' : 'green'}>{session.ended_at ? '已结束' : '运行中'}</Tag>
                          </div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {formatSessionTime(session.started_at)}
                          </Typography.Text>
                          <Button size="small" onClick={() => void onResumeSession(session.session_id)}>
                            继续
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </Splitter.Panel>
        </Splitter>

        <Modal
          title="新建标签页"
          open={newTabModalOpen}
          onCancel={onCloseNewTabModal}
          onOk={() => onCreateIdeTab()}
          okText="创建"
          cancelText="取消"
        >
          <Input
            placeholder="输入要打开的 URL（例如：https://github.com）"
            value={newTabUrl}
            onChange={(e) => onNewTabUrlChange(e.target.value)}
            onPressEnter={() => onCreateIdeTab()}
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
                        onClick={() => onCreateIdeTab(item)}
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

        <Modal title="选择要继续的会话" open={sessionModalOpen} onCancel={onCloseSessionModal} footer={null} width={860}>
          {sessions.length === 0 ? (
            <Empty description="暂无历史会话" />
          ) : (
            <Table dataSource={sessions} rowKey="id" size="small" pagination={{ pageSize: 10 }} columns={sessionColumns} />
          )}
        </Modal>
      </Card>
    </div>
  );
}
