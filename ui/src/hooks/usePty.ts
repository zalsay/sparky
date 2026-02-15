import { useRef, useCallback, useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

interface PtyInfo {
  pid: number;
  cols: number;
  rows: number;
}

export function usePty(onData?: (data: string) => void) {
  const [isRunning, setIsRunning] = useState(false);
  const ptyRef = useRef<PtyInfo | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const onDataRef = useRef(onData);

  // 更新 ref 当 onData 变化时
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  const startPty = useCallback(async () => {
    if (isRunning) return null;

    try {
      console.log('Creating PTY...');

      // 使用自定义的 PTY 命令
      const pid = await invoke<number>('pty_spawn', {
        program: 'zsh',
        args: [],
        cwd: '/Users/yingzhang',
        envs: {
          TERM: 'xterm-256color',
        },
        cols: 100,
        rows: 30,
      });

      console.log('PTY spawned with pid:', pid);
      ptyRef.current = { pid, cols: 100, rows: 30 };
      setIsRunning(true);

      // 监听 PTY 数据
      const unlisten = await listen<{ pid: number; data: string }>('pty-data', (event) => {
        if (event.payload.pid === ptyRef.current?.pid) {
          console.log('PTY data received:', event.payload.data);
          // 写入终端显示
          if ((window as any).__terminalWrite) {
            (window as any).__terminalWrite(event.payload.data);
          }
          // 调用回调
          if (onDataRef.current) {
            onDataRef.current(event.payload.data);
          }
        }
      });

      unlistenRef.current = unlisten;
      return { pid };
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
          pid: ptyRef.current.pid,
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
          pid: ptyRef.current.pid,
        });
      } catch (error) {
        console.error('Failed to kill PTY:', error);
      }
      ptyRef.current = null;
      setIsRunning(false);
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
  };
}
