import { useCallback, useEffect, useRef, useState } from 'react';

import { streamSse } from '../../services/webApi';
import { fetchWebIdeSummary } from '../features/projects/services/projectService';
import type { WebIdeEvent, WebIdeProjectStatus } from '../types';

interface UseWebIdeEventsOptions {
  active: boolean;
  getWebApiKey: () => string | null;
  handleWebRequestError: (error: unknown) => void;
}

export function useWebIdeEvents({
  active,
  getWebApiKey,
  handleWebRequestError,
}: UseWebIdeEventsOptions) {
  const [webIdeProjects, setWebIdeProjects] = useState<WebIdeProjectStatus[]>([]);
  const webIdeSseAbortRef = useRef<AbortController | null>(null);
  const webIdeSseReconnectTimerRef = useRef<number | null>(null);
  const webIdeSseBackoffRef = useRef<number>(1000);

  const refreshWebIdeSummary = useCallback(async () => {
    const apiKey = getWebApiKey();
    if (!apiKey) return;
    try {
      const data = await fetchWebIdeSummary(apiKey);
      setWebIdeProjects(data?.projects || []);
    } catch (error) {
      handleWebRequestError(error);
      setWebIdeProjects([]);
    }
  }, [getWebApiKey, handleWebRequestError]);

  const startWebIdeSse = useCallback(() => {
    const apiKey = getWebApiKey();
    if (!apiKey) return;
    webIdeSseAbortRef.current?.abort();
    if (webIdeSseReconnectTimerRef.current) {
      window.clearTimeout(webIdeSseReconnectTimerRef.current);
      webIdeSseReconnectTimerRef.current = null;
    }
    const controller = new AbortController();
    webIdeSseAbortRef.current = controller;

    const connect = async () => {
      try {
        await streamSse('/api/web-ide/events', apiKey, controller.signal, ({ event, data }) => {
          if (event !== 'web_ide_event' || !data) return;

          try {
            const next = JSON.parse(data) as WebIdeEvent;
            if (next.event_type === 'agent_disconnected') {
              setWebIdeProjects((prev) => prev.filter((item) => item.agent_id !== next.agent_id));
              return;
            }

            if (next.project) {
              const project = next.project;
              setWebIdeProjects((prev) => {
                const remaining = prev.filter(
                  (item) => !(item.project_id === project.project_id && item.agent_id === project.agent_id),
                );
                return [...remaining, project];
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
  }, [getWebApiKey, handleWebRequestError]);

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
    refreshWebIdeSummary,
  };
}
