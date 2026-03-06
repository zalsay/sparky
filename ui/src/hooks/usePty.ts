import { useRef, useCallback, useState, useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface PtyInfo {
  projectPath: string;
  terminalId: string;
  cols: number;
  rows: number;
}

export function usePty(terminalId: string, projectPath: string, customEnvs?: Record<string, string>, onData?: (data: string, projectPath: string, terminalId: string) => void) {
  const [isRunning, setIsRunning] = useState(false);
  const ptyRef = useRef<PtyInfo | null>(null);
  const currentTerminalRef = useRef<string | null>(terminalId);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onDataRef = useRef(onData);
  const tauriAvailable = isTauri();
  const listenerGenRef = useRef(0);

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

  const setupListener = useCallback(async (tid: string) => {
    if (!tauriAvailable) {
      return;
    }
    cleanupListener();
    // Increment generation to detect stale async listeners
    const gen = ++listenerGenRef.current;

    const unlisten = await listen<{ projectPath: string; terminalId: string; data: string }>('pty-data', (event) => {
      // Ignore if this listener is stale (a newer one was created)
      if (listenerGenRef.current !== gen) return;
      // 这里的逻辑是过滤属于当前这个 terminalId 的事件
      if (event.payload.terminalId === tid) {
        setIsRunning(true); // PTY data received, it is now truly running and ready
        if ((window as any).__terminalWrite) {
          (window as any).__terminalWrite(event.payload.terminalId, event.payload.data);
        }
        if (onDataRef.current) {
          onDataRef.current(event.payload.data, event.payload.projectPath, event.payload.terminalId);
        }
      }
    });

    // If another setupListener was called while we awaited, discard this listener
    if (listenerGenRef.current !== gen) {
      unlisten();
      return;
    }

    unlistenRef.current = unlisten;
  }, [cleanupListener, tauriAvailable]);

  const startPty = useCallback(async () => {
    if (!tauriAvailable) {
      return null;
    }
    if (!projectPath || !terminalId) {
      console.error('Project path and terminalId are required');
      return null;
    }

    try {
      console.log('Checking if PTY exists for terminal:', terminalId);

      const exists = await invoke<boolean>('pty_exists', { terminal_id: terminalId });
      console.log('PTY exists:', exists);

      if (isRunning && exists) {
        console.log('Same terminal, setting up listener');
        await setupListener(terminalId);
        return ptyRef.current;
      }

      if (exists) {
        console.log('Reconnecting to existing PTY for terminal:', terminalId);
        ptyRef.current = { projectPath, terminalId, cols: 100, rows: 30 };
        setIsRunning(true);
        await setupListener(terminalId);
        return ptyRef.current;
      }

      console.log('Creating new PTY for terminal:', terminalId);

      // Set up listener BEFORE spawn so we don't miss initial shell output
      await setupListener(terminalId);

      const spawnEnvs = {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: navigator.language.includes('zh') ? 'zh_CN.UTF-8' : 'en_US.UTF-8',
        LC_ALL: navigator.language.includes('zh') ? 'zh_CN.UTF-8' : 'en_US.UTF-8',
        PROMPT_EOL_MARK: '',
        ...customEnvs
      };

      const result = await invoke<string>('pty_spawn', {
        program: '',
        args: ['-l'],
        cwd: projectPath,
        envs: spawnEnvs,
        cols: 100,
        rows: 30,
        project_path: projectPath,
        terminal_id: terminalId,
      });

      console.log('PTY spawned for terminal:', result);
      ptyRef.current = { projectPath, terminalId: result, cols: 100, rows: 30 };
      // Do not setIsRunning(true) here; wait for actual pty-data from setupListener
      return ptyRef.current;
    } catch (error) {
      console.error('Failed to start PTY:', error);
      return null;
    }
  }, [isRunning, setupListener, projectPath, terminalId, customEnvs, tauriAvailable]);

  const write = useCallback(async (data: string) => {
    if (!tauriAvailable) {
      return;
    }
    if (ptyRef.current) {
      try {
        await invoke('pty_write', {
          terminal_id: ptyRef.current.terminalId,
          data,
        });
      } catch (error) {
        console.error('Failed to write to PTY:', error);
      }
    }
  }, []);

  const clearPty = useCallback(() => {
    // Note: this just clears frontend state; it doesn't kill the backend PTY.
    setIsRunning(false);
    ptyRef.current = null;
    currentTerminalRef.current = null;
    cleanupListener();
  }, [cleanupListener]);

  return {
    startPty,
    write,
    isRunning,
    clearPty,
  };
}
