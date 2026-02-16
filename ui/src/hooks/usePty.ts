import { useRef, useCallback, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface PtyInfo {
  projectPath: string;
  cols: number;
  rows: number;
}

export function usePty(onData?: (data: string, projectPath: string) => void) {
  const [isRunning, setIsRunning] = useState(false);
  const isResumedRef = useRef(false);
  const ptyRef = useRef<PtyInfo | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onDataRef = useRef(onData);

  // 获取 isResumed 的当前值
  const getIsResumed = useCallback(() => isResumedRef.current, []);

  // 更新 ref 当 onData 变化时
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  // 清理监听器
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);

  const startPty = useCallback(async (projectPath?: string) => {
    if (!projectPath) {
      console.error('Project path is required');
      return null;
    }

    // 如果已经有该项目的 PTY，直接返回
    if (ptyRef.current?.projectPath === projectPath && isRunning) {
      console.log('PTY already running for project:', projectPath);
      isResumedRef.current = true;
      return ptyRef.current;
    }

    try {
      console.log('Checking if PTY exists for project:', projectPath);

      // 检查是否已存在 PTY
      const exists = await invoke<boolean>('pty_exists', { projectPath });
      console.log('PTY exists:', exists);

      // 同步设置 isResumed
      isResumedRef.current = exists;

      if (exists) {
        console.log('Reconnecting to existing PTY for project:', projectPath);
        ptyRef.current = { projectPath, cols: 100, rows: 30 };
        setIsRunning(true);

        // 监听已存在 PTY 的数据
        if (unlistenRef.current) {
          unlistenRef.current();
        }

        const unlisten = await listen<{ projectPath: string; data: string }>('pty-data', (event) => {
          if (event.payload.projectPath === ptyRef.current?.projectPath) {
            console.log('PTY data received:', event.payload.data);
            // 写入终端显示
            if ((window as any).__terminalWrite) {
              (window as any).__terminalWrite(event.payload.data);
            }
            // 调用回调
            if (onDataRef.current) {
              onDataRef.current(event.payload.data, event.payload.projectPath);
            }
          }
        });

        unlistenRef.current = unlisten;
        return ptyRef.current;
      }

      console.log('Creating new PTY for project:', projectPath);

      // 创建新的 PTY
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

      // 监听 PTY 数据
      const unlisten = await listen<{ projectPath: string; data: string }>('pty-data', (event) => {
        if (event.payload.projectPath === ptyRef.current?.projectPath) {
          console.log('PTY data received:', event.payload.data);
          // 写入终端显示
          if ((window as any).__terminalWrite) {
            (window as any).__terminalWrite(event.payload.data);
          }
          // 调用回调
          if (onDataRef.current) {
            onDataRef.current(event.payload.data, event.payload.projectPath);
          }
        }
      });

      unlistenRef.current = unlisten;
      return ptyRef.current;
    } catch (error) {
      console.error('Failed to start PTY:', error);
      return null;
    }
  }, [isRunning]);

  const write = useCallback(async (data: string) => {
    if (ptyRef.current) {
      try {
        console.log('Writing to PTY:', data);
        await invoke('pty_write', {
          projectPath: ptyRef.current.projectPath,
          data,
        });
      } catch (error) {
        console.error('Failed to write to PTY:', error);
      }
    }
  }, []);

  const kill = useCallback(async () => {
    if (ptyRef.current) {
      try {
        await invoke('pty_kill', {
          projectPath: ptyRef.current.projectPath,
        });
      } catch (error) {
        console.error('Failed to kill PTY:', error);
      }
      ptyRef.current = null;
      setIsRunning(false);
      isResumedRef.current = false;
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  return {
    startPty,
    write,
    kill,
    isRunning,
    getIsResumed,
  };
}
