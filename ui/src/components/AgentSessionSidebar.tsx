import { useState } from 'react';
import { HistoryOutlined, ReloadOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import AgentLogo from './AgentLogo';

export interface AgentSessionInfo {
  session_id: string;
  agent_type: 'pi' | 'codex';
  project_path: string;
  started_at: number;
  last_active_at: number;
  title: string;
}

interface AgentSessionSidebarProps {
  sessions: AgentSessionInfo[];
  selectedSessionId?: string;
  loading?: boolean;
  disabled?: boolean;
  onRefresh: () => void;
  onSelect: (session: AgentSessionInfo) => void;
}

const GROUPS: Array<{ type: AgentSessionInfo['agent_type']; label: string }> = [
  { type: 'pi', label: 'pi' },
  { type: 'codex', label: 'codex' },
];

const formatSessionTime = (value: number) => {
  if (!value) return '';
  return new Date(value).toLocaleDateString(undefined, {
    month: '2-digit',
    day: '2-digit',
  });
};

export default function AgentSessionSidebar({
  sessions,
  selectedSessionId,
  loading = false,
  disabled = false,
  onRefresh,
  onSelect,
}: AgentSessionSidebarProps) {
  const [expandedGroups, setExpandedGroups] = useState<Record<AgentSessionInfo['agent_type'], boolean>>({
    pi: true,
    codex: true,
  });

  const toggleGroup = (type: AgentSessionInfo['agent_type']) => {
    setExpandedGroups((current) => ({ ...current, [type]: !current[type] }));
  };

  return (
    <aside className="agent-session-sidebar" aria-label="Agent 会话历史">
      <div className="agent-session-sidebar-header">
        <div className="agent-session-sidebar-title">
          <HistoryOutlined />
          <span>会话历史</span>
        </div>
        <button
          type="button"
          className="agent-session-sidebar-refresh"
          onClick={onRefresh}
          disabled={loading || disabled}
          title="刷新会话历史"
          aria-label="刷新会话历史"
        >
          {loading ? <LoadingOutlined spin /> : <ReloadOutlined />}
        </button>
      </div>

      <div className="agent-session-sidebar-list">
        {GROUPS.map((group) => {
          const groupSessions = sessions.filter((session) => session.agent_type === group.type);
          return (
            <section className="agent-session-group" key={group.type}>
              <button
                type="button"
                className="agent-session-group-heading"
                onClick={() => toggleGroup(group.type)}
                aria-expanded={expandedGroups[group.type]}
                aria-controls={`agent-session-group-${group.type}`}
              >
                <RightOutlined
                  className={`agent-session-group-toggle${expandedGroups[group.type] ? ' is-expanded' : ''}`}
                  aria-hidden="true"
                />
                <AgentLogo agentType={group.type} size={14} />
                <span>{group.label}</span>
                <span className="agent-session-group-count">{groupSessions.length}</span>
              </button>
              {expandedGroups[group.type] && (
                <div id={`agent-session-group-${group.type}`}>
                  {groupSessions.length === 0 ? (
                    <div className="agent-session-empty">暂无会话</div>
                  ) : (
                    groupSessions.map((session) => (
                      <button
                        type="button"
                        key={`${session.agent_type}:${session.session_id}`}
                        className={`agent-session-item${selectedSessionId === session.session_id ? ' is-selected' : ''}`}
                        onClick={() => onSelect(session)}
                        disabled={disabled}
                        title={`${session.title}\n${session.session_id}`}
                      >
                        <span className="agent-session-item-main">
                          <span className="agent-session-item-title">{session.title}</span>
                          <span className="agent-session-item-id">{session.session_id.slice(0, 12)}...</span>
                        </span>
                        <span className="agent-session-item-time">{formatSessionTime(session.last_active_at || session.started_at)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
