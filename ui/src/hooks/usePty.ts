import { useRef, useCallback, useState, useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface PtyInfo {
  projectPath: string;
  cols: number;
  rows: number;
}

export function usePty(onData?: (data: string, projectPath: string) => void) {
  const [isRunning, setIsRunning] = useState(false);
  const ptyRef = useRef<PtyInfo | null>(null);
  const currentProjectRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onDataRef = useRef(onData);
  const tauriAvailable = isTauri();

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  // 清理事件监听器
  const cleanupListener = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupListener();
    };
  }, [cleanupListener]);

  const setupListener = useCallback(async (projectPath: string) => {
    if (!tauriAvailable) {
      return;
    }
    cleanupListener();

    const unlisten = await listen<{ projectPath: string; data: string }>('pty-data', (event) => {
      if (event.payload.projectPath === projectPath) {
        if ((window as any).__terminalWrite) {
          (window as any).__terminalWrite(event.payload.data);
        }
        if (onDataRef.current) {
          onDataRef.current(event.payload.data, event.payload.projectPath);
        }
      }
    });

    unlistenRef.current = unlisten;
  }, [cleanupListener]);

  const startPty = useCallback(async (projectPath?: string) => {
    if (!tauriAvailable) {
      return null;
    }
    if (!projectPath) {
      console.error('Project path is required');
      return null;
    }

    // 如果当前项目相同且正在运行，直接设置监听器
    if (currentProjectRef.current === projectPath && isRunning) {
      console.log('Same project, setting up listener');
      await setupListener(projectPath);
      return ptyRef.current;
    }

    try {
      console.log('Checking if PTY exists for project:', projectPath);

      const exists = await invoke<boolean>('pty_exists', { projectPath });
      console.log('PTY exists:', exists);

      currentProjectRef.current = projectPath;

      if (exists) {
        console.log('Reconnecting to existing PTY for project:', projectPath);
        ptyRef.current = { projectPath, cols: 100, rows: 30 };
        setIsRunning(true);
        await setupListener(projectPath);
        return ptyRef.current;
      }

      console.log('Creating new PTY for project:', projectPath);

      const result = await invoke<string>('pty_spawn', {
        program: 'zsh',
        args: [],
        cwd: projectPath,
        envs: {
          TERM: 'xterm-256color',
        },
        cols: 100,
        rows: 30,
        projectPath,
      });

      console.log('PTY spawned for project:', result);
      ptyRef.current = { projectPath: result, cols: 100, rows: 30 };
      setIsRunning(true);
      await setupListener(projectPath);
      return ptyRef.current;
    } catch (error) {
      console.error('Failed to start PTY:', error);
      return null;
    }
  }, [isRunning, setupListener]);

  const write = useCallback(async (data: string) => {
    if (!tauriAvailable) {
      return;
    }
    if (ptyRef.current) {
      try {
        await invoke('pty_write', {
          projectPath: ptyRef.current.projectPath,
          data,
        });
      } catch (error) {
        console.error('Failed to write to PTY:', error);
      }
    }
  }, []);

  return {
    startPty,
    write,
    isRunning,
  };
}
