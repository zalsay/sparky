import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp } from 'antd';

import type { IDETab, Project } from '../types';

const SPLITTER_SIZES_STORAGE_KEY = 'sparkySplitterSizes';
const DEFAULT_SPLITTER_SIZES: string[] = ['50%', '50%'];

const normalizeSplitterSizes = (value: unknown): number[] | string[] => {
  if (!Array.isArray(value) || value.length < 2) return [...DEFAULT_SPLITTER_SIZES];
  const first = typeof value[0] === 'number' ? value[0] : Number.parseFloat(String(value[0]));
  if (!Number.isFinite(first) || first <= 0) return [...DEFAULT_SPLITTER_SIZES];
  return value as number[] | string[];
};

const readStoredSplitterSizes = (): number[] | string[] => {
  try {
    const saved = localStorage.getItem(SPLITTER_SIZES_STORAGE_KEY);
    return saved ? normalizeSplitterSizes(JSON.parse(saved)) : [...DEFAULT_SPLITTER_SIZES];
  } catch {
    return [...DEFAULT_SPLITTER_SIZES];
  }
};
const IDE_TABS_STORAGE_KEY = 'sparky-ide-tabs';
const ACTIVE_IDE_TAB_STORAGE_KEY = 'sparky-active-ide-tab-id';

const readStoredIdeTabs = (): Record<string, IDETab[]> => {
  try {
    const raw = localStorage.getItem(IDE_TABS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([projectPath, value]) => {
        if (!Array.isArray(value)) return [];
        const tabs = value.filter((tab): tab is Partial<IDETab> => Boolean(tab && typeof tab === 'object'))
          .filter((tab) => typeof tab.id === 'string' && typeof tab.title === 'string' && typeof tab.url === 'string')
          .filter((tab) => /^https?:\/\//i.test(tab.url as string))
          .map((tab) => ({
            id: tab.id as string,
            title: tab.title as string,
            url: tab.url as string,
            type: 'webview' as const,
            closable: tab.closable !== false,
          }));
        return tabs.length > 0 ? [[projectPath, tabs]] : [];
      }),
    );
  } catch {
    return {};
  }
};

const readStoredActiveIdeTabs = (): Record<string, string> => {
  try {
    const raw = localStorage.getItem(ACTIVE_IDE_TAB_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
};

interface UseProjectIdeOptions {
  project: Project | null;
}

export function useProjectIde({ project }: UseProjectIdeOptions) {
  const { message: messageApi } = AntApp.useApp();
  const [ideTabsByProject, setIdeTabsByProject] = useState<Record<string, IDETab[]>>(readStoredIdeTabs);
  const [activeIdeTabIdByProject, setActiveIdeTabIdByProject] = useState<Record<string, string>>(readStoredActiveIdeTabs);
  const [newTabModalOpen, setNewTabModalOpen] = useState(false);
  const [newTabUrl, setNewTabUrl] = useState('');
  const [tabLoadErrors, setTabLoadErrors] = useState<Record<string, boolean>>({});
  const [ideTabReloadKeys, setIdeTabReloadKeys] = useState<Record<string, number>>({});
  const [recentProjectUrls, setRecentProjectUrls] = useState<Record<string, string[]>>({});
  const [splitterSizes, setSplitterSizes] = useState<number[] | string[]>(readStoredSplitterSizes);

  useEffect(() => {
    localStorage.setItem(IDE_TABS_STORAGE_KEY, JSON.stringify(ideTabsByProject));
  }, [ideTabsByProject]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_IDE_TAB_STORAGE_KEY, JSON.stringify(activeIdeTabIdByProject));
  }, [activeIdeTabIdByProject]);

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
    const nextSizes = normalizeSplitterSizes(sizes);
    setSplitterSizes(nextSizes);
    try {
      localStorage.setItem(SPLITTER_SIZES_STORAGE_KEY, JSON.stringify(nextSizes));
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
