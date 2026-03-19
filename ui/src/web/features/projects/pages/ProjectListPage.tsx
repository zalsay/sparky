import { Button, Card, Divider, Empty, Table, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined, ProjectOutlined } from '@ant-design/icons';

import codeIcon from '../../../../assets/Code.svg';
import type { Project } from '../../../types';

interface ProjectListPageProps {
  projects: Project[];
  projectsLoaded: boolean;
  onAddProject: () => void;
  onEnterProject: (project: Project) => void | Promise<void>;
  onDeleteProject: (id: number) => void;
}

export default function ProjectListPage({
  projects,
  projectsLoaded,
  onAddProject,
  onEnterProject,
  onDeleteProject,
}: ProjectListPageProps) {
  return (
    <div className="project-page">
      <Card className="projects-card" variant="borderless">
        <div className="card-header">
          <ProjectOutlined className="card-icon" />
          <h2>项目管理</h2>
          <Button type="primary" icon={<PlusOutlined />} onClick={onAddProject} style={{ marginLeft: 'auto' }}>
            添加项目
          </Button>
        </div>
        <p className="card-description">管理您的项目，每个项目可以独立配置 Claude Code Hooks</p>
        <Divider />
        {!projectsLoaded ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>加载中...</div>
        ) : projects.length === 0 ? (
          <Empty description="暂无项目，请添加项目" />
        ) : (
          <Table
            dataSource={projects}
            rowKey="id"
            pagination={false}
            columns={[
              {
                title: '项目名称',
                dataIndex: 'name',
                key: 'name',
                render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>,
              },
              {
                title: '路径',
                dataIndex: 'path',
                key: 'path',
                render: (path: string) => <span style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{path}</span>,
              },
              {
                title: '推送服务',
                key: 'hooks',
                width: 140,
                render: (_: unknown, record: Project) => (
                  <Tag className={`hooks - tag ${record.hooks_installed ? 'installed' : ''}`} style={{ margin: 0 }}>
                    {record.hooks_installed ? '已安装' : '未安装'}
                  </Tag>
                ),
              },
              {
                title: 'Claude 配置',
                key: 'claude_config',
                width: 140,
                render: () => <Button size="small" disabled>桌面端可用</Button>,
              },
              {
                title: '操作',
                key: 'action',
                width: 180,
                render: (_: unknown, record: Project) => (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="small" type="primary" onClick={() => void onEnterProject(record)}>
                      Go <img src={codeIcon} alt="Go" style={{ marginLeft: 4, width: 14, height: 14 }} />
                    </Button>
                    <Button size="small" className="action-btn-outline danger" icon={<DeleteOutlined />} onClick={() => onDeleteProject(record.id)} />
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
