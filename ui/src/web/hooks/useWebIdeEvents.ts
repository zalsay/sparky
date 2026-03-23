import { useCallback, useEffect, useRef, useState } from 'react';

import { streamSse } from '../../services/webApi';
import { fetchWebIdeSummary } from '../features/projects/services/projectService';
import type { WebIdeEvent, WebIdeProjectStatus } from '../types';

interface UseWebIdeEventsOptions {
  active: boolean;
  handleWebRequestError: (error: unknown) => void;
}

export function useWebIdeEvents({
  active,
  handleWebRequestError,
}: UseWebIdeEventsOptions) {
  const [webIdeProjects, setWebIdeProjects] = useState<WebIdeProjectStatus[]>([]);
  const [activeInstances, setActiveInstances] = useState(0);
  const webIdeSseAbortRef = useRef<AbortController | null>(null);
  const webIdeSseReconnectTimerRef = useRef<number | null>(null);
  const webIdeSseBackoffRef = useRef<number>(1000);

  const refreshWebIdeSummary = useCallback(async () => {
    try {
      const data = await fetchWebIdeSummary();
      setWebIdeProjects(data?.projects || []);
      setActiveInstances(data?.active_instances ?? data?.projects?.length ?? 0);
    } catch (error) {
      handleWebRequestError(error);
      setWebIdeProjects([]);
      setActiveInstances(0);
    }
  }, [handleWebRequestError]);

  const startWebIdeSse = useCallback(() => {
    webIdeSseAbortRef.current?.abort();
    if (webIdeSseReconnectTimerRef.current) {
      window.clearTimeout(webIdeSseReconnectTimerRef.current);
      webIdeSseReconnectTimerRef.current = null;
    }
    const controller = new AbortController();
    webIdeSseAbortRef.current = controller;

    const connect = async () => {
      try {
        await streamSse('/api/web-ide/events', controller.signal, ({ event, data }) => {
          if (event !== 'web_ide_event' || !data) return;

          try {
            const next = JSON.parse(data) as WebIdeEvent;
            if (next.event_type === 'agent_disconnected') {
              setWebIdeProjects((prev) => {
                const filtered = prev.filter((item) => item.agent_id !== next.agent_id);
                setActiveInstances(filtered.length);
                return filtered;
              });
              return;
            }

            if (next.project) {
              const project = next.project;
              setWebIdeProjects((prev) => {
                const remaining = prev.filter(
                  (item) => !(item.project_id === project.project_id && item.agent_id === project.agent_id),
                );
                const merged = [...remaining, project];
                setActiveInstances(merged.length);
                return merged;
              });
            }
          } catch (err) {
            console.warn('Failed to parse WebIDE SSE event', err);
          }
        });
        webIdeSseBackoffRef.current = 1000;
      } catch (err) {
        if (controller.signal.aborted) return;
        handleWebRequestError(err);
        const nextDelay = Math.min(webIdeSseBackoffRef.current * 2, 5000);
        webIdeSseBackoffRef.current = nextDelay;
        webIdeSseReconnectTimerRef.current = window.setTimeout(() => connect(), nextDelay);
      }
    };

    void connect();
  }, [handleWebRequestError]);

  useEffect(() => {
    if (!active) return;
    void refreshWebIdeSummary();
    startWebIdeSse();
    return () => {
      webIdeSseAbortRef.current?.abort();
      if (webIdeSseReconnectTimerRef.current) {
        window.clearTimeout(webIdeSseReconnectTimerRef.current);
        webIdeSseReconnectTimerRef.current = null;
      }
    };
  }, [active, refreshWebIdeSummary, startWebIdeSse]);

  return {
    webIdeProjects,
    activeInstances,
    refreshWebIdeSummary,
  };
}
