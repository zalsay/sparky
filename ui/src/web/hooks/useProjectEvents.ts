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
import type { Project, SessionInfo } from '../types';

const FULL_AUTH_STORAGE_KEY = 'sparky-full-auth';

interface UseProjectEventsOptions {
  active: boolean;
  project: Project | null;
  getWebApiKey: () => string | null;
  handleWebRequestError: (error: unknown) => void;
}

function normalizeSession(session: SessionInfo): SessionInfo {
  return {
    ...session,
    id: session.id,
    session_id: session.session_id || String(session.id || ''),
    project_path: session.project_path || '',
    started_at: session.started_at ?? null,
    ended_at: session.ended_at ?? null,
    reason: session.reason ?? null,
    name: session.name ?? null,
    project_name: session.project_name ?? null,
  };
}

export function useProjectEvents({
  active,
  project,
  getWebApiKey,
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
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      const result = (await fetchSessionsWeb(apiKey, project.id)) || [];
      const uniqueSessions = Array.from(new Map(result.map((session) => {
        const normalized = normalizeSession(session);
        return [normalized.session_id, normalized] as const;
      })).values());
      setSessions(uniqueSessions);
    } catch (error) {
      handleWebRequestError(error);
      setSessions([]);
    }
  }, [getWebApiKey, handleWebRequestError, project]);

  const refreshTerminalHistory = useCallback(async () => {
    if (!project) return;
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      const data = await fetchTerminalHistoryWeb(apiKey, project.id);
      setTerminalHistory((prev) => ({
        ...prev,
        [project.path]: data || [],
      }));
    } catch (error) {
      handleWebRequestError(error);
      setTerminalHistory((prev) => ({
        ...prev,
        [project.path]: [],
      }));
    }
  }, [getWebApiKey, handleWebRequestError, project]);

  const refreshProjectDetail = useCallback(async () => {
    if (!project) return;
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      const data = await fetchProjectDetailWeb(apiKey, project.id);
      setSessions((data?.sessions || []).map(normalizeSession));
      setTerminalHistory((prev) => ({
        ...prev,
        [project.path]: data?.terminal_history || [],
      }));
    } catch (error) {
      handleWebRequestError(error);
      void Promise.all([refreshSessions(), refreshTerminalHistory()]);
    }
  }, [getWebApiKey, handleWebRequestError, project, refreshSessions, refreshTerminalHistory]);

  const sendTerminalCommand = useCallback(async (command: string) => {
    if (!project) return;
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      await executeTerminalWeb(apiKey, project.id, command);
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [getWebApiKey, handleWebRequestError, project]);

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
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      await resumeSessionWeb(apiKey, project.id, sessionId);
      closeSessionModal();
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [closeSessionModal, getWebApiKey, handleWebRequestError, project]);

  const updateSessionName = useCallback(async (sessionId: string, name: string) => {
    if (!project) return;
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      await renameSessionWeb(apiKey, project.id, sessionId, name);
      setEditingSessionId(null);
      setEditingSessionName('');
      await refreshSessions();
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [getWebApiKey, handleWebRequestError, project, refreshSessions]);

  const removeSession = useCallback(async (sessionId: string) => {
    if (!project) return;
    const apiKey = getWebApiKey();
    if (!apiKey) return;

    try {
      await deleteSessionWeb(apiKey, project.id, sessionId);
      await refreshSessions();
    } catch (error) {
      handleWebRequestError(error);
    }
  }, [getWebApiKey, handleWebRequestError, project, refreshSessions]);

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

    const apiKey = getWebApiKey();
    if (!apiKey) {
      return () => {
        if ((window as any).__terminalExecImpl) {
          delete (window as any).__terminalExecImpl;
        }
      };
    }

    webSseAbortRef.current?.abort();
    if (webSseReconnectTimerRef.current) {
      window.clearTimeout(webSseReconnectTimerRef.current);
      webSseReconnectTimerRef.current = null;
    }

    const controller = new AbortController();
    webSseAbortRef.current = controller;

    const connect = async () => {
      try {
        await streamSse(`/api/events?project_id=${project.id}`, apiKey, controller.signal, ({ event, data }) => {
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
  }, [active, getWebApiKey, handleWebRequestError, project, refreshProjectDetail, sendTerminalCommand, terminalId]);

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
