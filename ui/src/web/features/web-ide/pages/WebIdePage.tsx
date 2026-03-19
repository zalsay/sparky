import { Button, Card, Divider, Empty, Table, Tag } from 'antd';
import { DesktopOutlined, ReloadOutlined } from '@ant-design/icons';

import type { WebIdeProjectStatus } from '../../../types';

interface WebIdePageProps {
  projects: WebIdeProjectStatus[];
  onRefresh: () => void | Promise<void>;
}

export default function WebIdePage({ projects, onRefresh }: WebIdePageProps) {
  return (
    <div className="project-page">
      <Card className="projects-card" variant="borderless">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <DesktopOutlined className="card-icon" />
            <h2>WebIDE</h2>
          </div>
          <Button size="small" onClick={() => void onRefresh()} icon={<ReloadOutlined />}>刷新</Button>
        </div>
        <p className="card-description">显示当前在线的 WebIDE 项目与活跃 PTY 数</p>
        <Divider />
        {projects.length === 0 ? (
          <Empty description="暂无在线 WebIDE 项目" />
        ) : (
          <Table
            dataSource={projects}
            rowKey={(record) => `${record.agent_id}-${record.project_id}`}
            pagination={false}
            columns={[
              { title: '项目名称', dataIndex: 'project_name', key: 'project_name', render: (name: string) => <span style={{ fontWeight: 500 }}>{name || '-'}</span> },
              { title: '路径', dataIndex: 'project_path', key: 'project_path', render: (path: string) => <span style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{path || '-'}</span> },
              { title: 'Agent', dataIndex: 'agent_id', key: 'agent_id', width: 160, render: (text: string) => <Tag color="blue">{text}</Tag> },
              { title: '活跃 PTY', dataIndex: 'active_pty_count', key: 'active_pty_count', width: 120, render: (count: number) => <Tag color={count > 0 ? 'green' : 'default'}>{count}</Tag> },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
