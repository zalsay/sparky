import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp } from 'antd';

import type { IDETab, Project } from '../types';

const SPLITTER_SIZES_STORAGE_KEY = 'sparkySplitterSizes';

interface UseProjectIdeOptions {
  project: Project | null;
}

export function useProjectIde({ project }: UseProjectIdeOptions) {
  const { message: messageApi } = AntApp.useApp();
  const [ideTabsByProject, setIdeTabsByProject] = useState<Record<string, IDETab[]>>({});
  const [activeIdeTabIdByProject, setActiveIdeTabIdByProject] = useState<Record<string, string>>({});
  const [newTabModalOpen, setNewTabModalOpen] = useState(false);
  const [newTabUrl, setNewTabUrl] = useState('');
  const [tabLoadErrors, setTabLoadErrors] = useState<Record<string, boolean>>({});
  const [ideTabReloadKeys, setIdeTabReloadKeys] = useState<Record<string, number>>({});
  const [recentProjectUrls, setRecentProjectUrls] = useState<Record<string, string[]>>({});
  const [splitterSizes, setSplitterSizes] = useState<number[] | string[]>(() => {
    try {
      const saved = localStorage.getItem(SPLITTER_SIZES_STORAGE_KEY);
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore storage errors
    }
    return ['50%', '50%'];
  });

  const projectPath = project?.path ?? '';
  const ideTabs = project ? ideTabsByProject[project.path] || [] : [];
  const activeIdeTabId = project ? activeIdeTabIdByProject[project.path] || '' : '';
  const recentUrlsForProject = project ? recentProjectUrls[project.path] || [] : [];

  useEffect(() => {
    if (!project) return;
    setIdeTabsByProject((prev) => {
      if (prev[project.path]) return prev;
      return {
        ...prev,
        [project.path]: [],
      };
    });
  }, [project]);

  const updateSplitterSizes = useCallback((sizes: number[] | string[]) => {
    setSplitterSizes(sizes);
    try {
      localStorage.setItem(SPLITTER_SIZES_STORAGE_KEY, JSON.stringify(sizes));
    } catch {
      // ignore storage errors
    }
  }, []);

  const openNewTabModal = useCallback(() => {
    setNewTabUrl('');
    setNewTabModalOpen(true);
  }, []);

  const closeNewTabModal = useCallback(() => {
    setNewTabModalOpen(false);
    setNewTabUrl('');
  }, []);

  const pushRecentProjectUrl = useCallback((nextProjectPath: string, url: string) => {
    setRecentProjectUrls((prev) => {
      const current = prev[nextProjectPath] || [];
      const next = [url, ...current.filter((item) => item !== url)].slice(0, 10);
      return { ...prev, [nextProjectPath]: next };
    });
  }, []);

  const createIdeTabFromUrl = useCallback((rawUrl?: string) => {
    if (!project) return;
    const inputUrl = (rawUrl ?? newTabUrl).trim();
    if (!inputUrl) {
      messageApi.warning('请输入 URL');
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(inputUrl);
    } catch {
      messageApi.error('请输入有效的 URL（例如：https://github.com）');
      return;
    }

    const normalizedUrl = parsedUrl.toString();
    const newTab: IDETab = {
      id: `webview-${Date.now()}`,
      title: parsedUrl.hostname || 'New Tab',
      url: normalizedUrl,
      type: 'webview',
      closable: true,
    };

    setIdeTabsByProject((prev) => ({
      ...prev,
      [project.path]: [...(prev[project.path] || []), newTab],
    }));
    setActiveIdeTabIdByProject((prev) => ({ ...prev, [project.path]: newTab.id }));
    setTabLoadErrors((prev) => ({ ...prev, [newTab.id]: false }));
    pushRecentProjectUrl(project.path, normalizedUrl);
    closeNewTabModal();
  }, [closeNewTabModal, messageApi, newTabUrl, project, pushRecentProjectUrl]);

  const removeIdeTab = useCallback((tabId: string) => {
    if (!project) return;

    setIdeTabsByProject((prev) => {
      const currentTabs = prev[project.path] || [];
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
      setActiveIdeTabIdByProject((prevActive) => {
        if (prevActive[project.path] !== tabId) return prevActive;
        const nextActive = nextTabs[nextTabs.length - 1]?.id || '';
        return { ...prevActive, [project.path]: nextActive };
      });
      return { ...prev, [project.path]: nextTabs };
    });

    setTabLoadErrors((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });

    setIdeTabReloadKeys((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, [project]);

  const reloadIdeTab = useCallback((tabId: string) => {
    setIdeTabReloadKeys((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] || 0) + 1,
    }));
    setTabLoadErrors((prev) => ({ ...prev, [tabId]: false }));
  }, []);

  const setActiveIdeTabId = useCallback((tabId: string) => {
    if (!project) return;
    setActiveIdeTabIdByProject((prev) => ({ ...prev, [project.path]: tabId }));
  }, [project]);

  const setTabLoadError = useCallback((tabId: string, hasError: boolean) => {
    setTabLoadErrors((prev) => ({ ...prev, [tabId]: hasError }));
  }, []);

  const projectIdeTabs = useMemo(
    () => ideTabs.map((tab) => ({
      ...tab,
      reloadKey: ideTabReloadKeys[tab.id] || 0,
      hasLoadError: tabLoadErrors[tab.id] || false,
    })),
    [ideTabReloadKeys, ideTabs, tabLoadErrors],
  );

  return {
    projectPath,
    splitterSizes,
    updateSplitterSizes,
    ideTabs: projectIdeTabs,
    activeIdeTabId,
    setActiveIdeTabId,
    newTabModalOpen,
    newTabUrl,
    setNewTabUrl,
    openNewTabModal,
    closeNewTabModal,
    createIdeTabFromUrl,
    removeIdeTab,
    reloadIdeTab,
    setTabLoadError,
    recentUrlsForProject,
  };
}
