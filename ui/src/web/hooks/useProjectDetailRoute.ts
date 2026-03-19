import { useCallback, useEffect, useRef } from 'react';

interface UseProjectDetailRouteOptions {
  onEnterProjectById: (projectId: number) => void | Promise<void>;
  onLeaveProjectDetail: () => void;
}

export function useProjectDetailRoute({
  onEnterProjectById,
  onLeaveProjectDetail,
}: UseProjectDetailRouteOptions) {
  const hasRestoredSelectionRef = useRef(false);

  useEffect(() => {
    if (hasRestoredSelectionRef.current) return;
    const match = window.location.pathname.match(/^\/project\/(\d+)\/detail$/);
    if (match) {
      const projectId = Number(match[1]);
      if (Number.isFinite(projectId)) {
        void Promise.resolve(onEnterProjectById(projectId)).finally(() => {
          hasRestoredSelectionRef.current = true;
        });
        return;
      }
    }
    hasRestoredSelectionRef.current = true;
  }, [onEnterProjectById]);

  useEffect(() => {
    const onPopState = () => {
      const match = window.location.pathname.match(/^\/project\/(\d+)\/detail$/);
      if (match) {
        const projectId = Number(match[1]);
        if (Number.isFinite(projectId)) {
          void onEnterProjectById(projectId);
          return;
        }
      }
      onLeaveProjectDetail();
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [onEnterProjectById, onLeaveProjectDetail]);

  const openProjectDetailRoute = useCallback((projectId: number) => {
    window.history.pushState({}, '', `/project/${projectId}/detail`);
  }, []);

  const goProjectListRoute = useCallback(() => {
    window.history.pushState({}, '', '/');
  }, []);

  return {
    openProjectDetailRoute,
    goProjectListRoute,
  };
}
