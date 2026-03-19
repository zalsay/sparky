import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { streamSse } from '../../services/webApi';
import {
  deleteSessionWeb,
  executeTerminalWeb,
  fetchProjectDetailWeb,
  fetchSessionsWeb,
  fetchTerminalHistoryWeb,
  renameSessionWeb,
  resumeSessionWeb,
} from '../features/projects/services/projectService';
import type { Project, SessionInfo, TerminalHistoryEntry } from '../types';

const FULL_AUTH_STORAGE_KEY = 'sparky-full-auth';

interface UseProjectEventsOptions {
  active: boolean;
  project: Project | null;
  handleWebRequestError: (error: unknown) => void;
}

function toTimestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeSession(session: SessionInfo, project: Project | null): SessionInfo {
  return {
    ...session,
    id: session.id,
    session_id: session.session_id || String(session.id || ''),
    project_id: session.project_id,
    project_path: session.project_path || project?.path || '',
    started_at: toTimestamp(session.started_at),
    ended_at: toTimestamp(session.ended_at),
    reason: session.reason ?? null,
    name: session.name ?? null,
    project_name: session.project_name ?? project?.name ?? null,
    status: session.status ?? null,
  };
}

function mapTerminalHistory(entries: TerminalHistoryEntry[] | string[] | undefined): string[] {
  if (!entries || entries.length === 0) {
    return [];
  }

  if (typeof entries[0] === 'string') {
    return entries as string[];
  }

  return (entries as TerminalHistoryEntry[]).map((entry) => {
    const content = entry.content || '';
    if (!entry.direction) {
      return content;
    }
    return entry.direction === 'in' ? `$ ${content}` : content;
  });
}

export function useProjectEvents({
  active,
  project,
  handleWebRequestError,
}: UseProjectEventsOptions) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [terminalHistory, setTerminalHistory] = useState<Record<string, string[]>>({});
  const [terminalStateReady, setTerminalStateReady] = useState(false);
  const [terminalStatus, setTerminalStatus] = useState<Record<string, string>>({});
  const [fullAuthByProject, setFullAuthByProject] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(FULL_AUTH_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const webSseAbortRef = useRef<AbortController | null>(null);
  const webSseReconnectTimerRef = useRef<number | null>(null);
  const webSseBackoffRef = useRef<number>(1000);

  const terminalId = useMemo(() => (project ? `web-${project.id}` : ''), [project]);
  const historyLines = project ? terminalHistory[project.path] || [] : [];
  const fullAuth = project ? fullAuthByProject[project.path] || false : false;
  const status = terminalId ? terminalStatus[terminalId] || 'online' : 'offline';

  useEffect(() => {
    try {
      localStorage.setItem(FULL_AUTH_STORAGE_KEY, JSON.stringify(fullAuthByProject));
    } catch {
      // ignore storage errors
    }
  }, [fullAuthByProject]);

  const refreshSessions = useCallback(async () => {
    if (!project) {
      setSessions([]);
      return;
    }

    try {
      const result = (await fetchSessionsWeb(project.id)) || [];
      const uniqueSessions = Array.from(new Map(result.map((session) => {
        const normalized = normalizeSession(session, project);
        return [normalized.session_id, normalized] as const;
      })).values());
      setSessions(uniqueSessions);
    } catch (error) {
      handleWebRequestError(error);
      setSessions([]);
    }
  }, [handleWebRequestError, project]);

  const refreshTerminalHistory = useCallback(async () => {
    if (!project) return;

    try {
      const data = await fetchTerminalHistoryWeb(project.id);
      setTerminalHistory((prev) => ({
        ...prev,
        [project.path]: mapTerminalHistory(data),
      }));
    } catch (error) {
      handleWebRequestError(error);
      setTerminalHistory((prev) => ({
        ...prev,
        [project.path]: [],
      }));
    }
  }, [handleWebRequestError, project]);

  const refreshProjectDetail = useCallback(async () => {
    if (!project) return;

    try {
      const data = await fetchProjectDetailWeb(project.id);
      setSessions(((data?.sessions || []) as SessionInfo[]).map((session) => normalizeSession(session, project)));
      setTerminalHistory((prev) => ({
        ...prev,
        [project.path]: mapTerminalHistory(data?.terminal_history),
      }));
    } catch (error) {
      handleWebRequestError(error);
      void Promise.all([refreshSessions(), refreshTerminalHistory()]);
    }
  }, [handleWebRequestError, project, refreshSessions, refreshTerminalHistory]);

  const sendTerminalCommand = useCallback(async (command: string) => {
    if (!project) return;

    try {
      const activeSession = sessions.find((item) => !item.ended_at && item.session_id);
      await executeTerminalWeb({
        projectId: activeSession ? undefined : project.id,
        sessionId: activeSession?.session_id,
        command,
      });
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [handleWebRequestError, project, sessions]);

  const toggleFullAuth = useCallback(() => {
    if (!project) return;
    setFullAuthByProject((prev) => ({
      ...prev,
      [project.path]: !(prev[project.path] || false),
    }));
  }, [project]);

  const openSessionModal = useCallback(async () => {
    await refreshSessions();
    setSessionModalOpen(true);
  }, [refreshSessions]);

  const closeSessionModal = useCallback(() => {
    setSessionModalOpen(false);
    setEditingSessionId(null);
    setEditingSessionName('');
  }, []);

  const startClaudeSession = useCallback(async () => {
    await sendTerminalCommand(`claude${fullAuth ? ' --dangerously-skip-permissions' : ''}\n`);
  }, [fullAuth, sendTerminalCommand]);

  const resumeClaudeSession = useCallback(async (sessionId: string) => {
    if (!project) return;

    try {
      await resumeSessionWeb(project.id, sessionId);
      closeSessionModal();
      await refreshSessions();
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [closeSessionModal, handleWebRequestError, project, refreshSessions]);

  const updateSessionName = useCallback(async (sessionId: string, name: string) => {
    if (!project) return;

    try {
      await renameSessionWeb(project.id, sessionId, name);
      setEditingSessionId(null);
      setEditingSessionName('');
      await refreshSessions();
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [handleWebRequestError, project, refreshSessions]);

  const removeSession = useCallback(async (sessionId: string) => {
    if (!project) return;

    try {
      await deleteSessionWeb(project.id, sessionId);
      await refreshSessions();
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [handleWebRequestError, project, refreshSessions]);

  useEffect(() => {
    if (!active || !project) {
      setTerminalStateReady(false);
      return;
    }

    setTerminalStateReady(true);
    setTerminalStatus((prev) => ({ ...prev, [terminalId]: 'online' }));
    void refreshProjectDetail();

    (window as any).__terminalExecImpl = async (data: string) => {
      await sendTerminalCommand(data);
    };

    webSseAbortRef.current?.abort();
    if (webSseReconnectTimerRef.current) {
      window.clearTimeout(webSseReconnectTimerRef.current);
      webSseReconnectTimerRef.current = null;
    }

    const controller = new AbortController();
    webSseAbortRef.current = controller;

    const connect = async () => {
      try {
        await streamSse(`/api/events?project_id=${project.id}`, controller.signal, ({ event, data }) => {
          if (event !== 'project_event' || !data) return;

          try {
            const parsed = JSON.parse(data);
            if (parsed.event_type === 'terminal_output_chunk') {
              const nextTerminalId = parsed.payload?.terminal_id || terminalId;
              const output = parsed.payload?.data || '';
              if ((window as any).__terminalWrite) {
                (window as any).__terminalWrite(nextTerminalId, output);
              }
              setTerminalStatus((prev) => ({ ...prev, [nextTerminalId]: 'online' }));
            } else if (parsed.event_type === 'terminal_exit') {
              const nextTerminalId = parsed.payload?.terminal_id || terminalId;
              setTerminalStatus((prev) => ({ ...prev, [nextTerminalId]: 'offline' }));
            } else if (parsed.event_type === 'session_updated' || parsed.event_type === 'session_deleted') {
              void refreshSessions();
            }
          } catch (error) {
            console.warn('Failed to parse project SSE event', error);
          }
        });
        webSseBackoffRef.current = 1000;
      } catch (error) {
        if (controller.signal.aborted) return;
        handleWebRequestError(error);
        const nextDelay = Math.min(webSseBackoffRef.current * 2, 5000);
        webSseBackoffRef.current = nextDelay;
        webSseReconnectTimerRef.current = window.setTimeout(() => connect(), nextDelay);
      }
    };

    void connect();

    return () => {
      if ((window as any).__terminalExecImpl) {
        delete (window as any).__terminalExecImpl;
      }
      webSseAbortRef.current?.abort();
      if (webSseReconnectTimerRef.current) {
        window.clearTimeout(webSseReconnectTimerRef.current);
        webSseReconnectTimerRef.current = null;
      }
    };
  }, [active, handleWebRequestError, project, refreshProjectDetail, refreshSessions, sendTerminalCommand, terminalId]);

  return {
    terminalId,
    historyLines,
    terminalStateReady,
    terminalStatus: status,
    sessions,
    sessionModalOpen,
    editingSessionId,
    editingSessionName,
    fullAuth,
    setEditingSessionId,
    setEditingSessionName,
    toggleFullAuth,
    openSessionModal,
    closeSessionModal,
    startClaudeSession,
    resumeClaudeSession,
    updateSessionName,
    removeSession,
    refreshSessions,
    sendTerminalCommand,
  };
}
