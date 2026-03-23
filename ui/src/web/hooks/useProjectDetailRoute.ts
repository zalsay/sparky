import { useCallback, useEffect, useMemo } from 'react';

interface UseProjectDetailRouteOptions {
  isAuthenticated: boolean;
  onEnterProjectById: (projectId: number) => void | Promise<void>;
  onLeaveProjectDetail: () => void;
  onRouteChange?: (pathname: string) => void;
}

export function useProjectDetailRoute({
  isAuthenticated,
  onEnterProjectById,
  onLeaveProjectDetail,
  onRouteChange,
}: UseProjectDetailRouteOptions) {
  const resolveRoute = useCallback(async (pathname: string) => {
    onRouteChange?.(pathname);

    if (!isAuthenticated) {
      onLeaveProjectDetail();
      return;
    }

    const match = pathname.match(/^\/project\/(\d+)\/detail$/);
    if (match) {
      const projectId = Number(match[1]);
      if (Number.isFinite(projectId)) {
        await onEnterProjectById(projectId);
        return;
      }
    }

    onLeaveProjectDetail();
  }, [isAuthenticated, onEnterProjectById, onLeaveProjectDetail, onRouteChange]);

  useEffect(() => {
    void resolveRoute(window.location.pathname);
  }, [resolveRoute]);

  useEffect(() => {
    const onPopState = () => {
      void resolveRoute(window.location.pathname);
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [resolveRoute]);

  const currentAuthMode = useMemo<'login' | 'register'>(() => {
    return window.location.pathname === '/register' ? 'register' : 'login';
  }, []);

  const navigate = useCallback((pathname: string, replace = false) => {
    if (window.location.pathname === pathname) {
      onRouteChange?.(pathname);
      return;
    }

    const method = replace ? 'replaceState' : 'pushState';
    window.history[method]({}, '', pathname);
    onRouteChange?.(pathname);
  }, [onRouteChange]);

  const openProjectDetailRoute = useCallback((projectId: number) => {
    navigate(`/project/${projectId}/detail`);
  }, [navigate]);

  const goProjectListRoute = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const goLoginRoute = useCallback((replace = false) => {
    navigate('/login', replace);
  }, [navigate]);

  const goRegisterRoute = useCallback((replace = false) => {
    navigate('/register', replace);
  }, [navigate]);

  return {
    currentAuthMode,
    openProjectDetailRoute,
    goProjectListRoute,
    goLoginRoute,
    goRegisterRoute,
  };
}
