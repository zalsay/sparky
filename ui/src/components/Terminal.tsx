import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onData?: (data: string) => void;
  getIsResumed?: () => boolean;
}

export default function TerminalComponent({ onData, getIsResumed }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);

  // 更新 onData ref
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  // 暴露写入方法给全局，供 PTY 数据回传使用
  useEffect(() => {
    (window as any).__terminalWrite = (data: string) => {
      if (terminalInstance.current) {
        terminalInstance.current.write(data);
      }
    };
    return () => {
      delete (window as any).__terminalWrite;
    };
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    // 如果终端已经存在，不重新创建
    if (terminalInstance.current) {
      return;
    }

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 15,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontWeight: 'bold',
      fontWeightBold: '900',
      theme: {
        background: '#1e1e1e',
        foreground: '#e0e0e0',
        cursor: '#ffffff',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#bd93f9',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#bfbfbf',
        brightBlack: '#4d4d4d',
        brightRed: '#ff6e67',
        brightGreen: '#5af78e',
        brightYellow: '#f4f99d',
        brightBlue: '#caa9fa',
        brightMagenta: '#ff92d0',
        brightCyan: '#9aedfe',
        brightWhite: '#e6e6e6',
      },
      convertEol: true,
      rows: 24,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(terminalRef.current);

    // 延迟一下再 fit，确保容器已渲染
    setTimeout(() => {
      try {
        fit.fit();
      } catch (e) {
        console.warn('Fit error:', e);
      }
    }, 100);

    // 自动聚焦终端
    term.focus();

    terminalInstance.current = term;
    fitAddon.current = fit;

    // 如果是恢复会话，不显示启动消息
    const isResumed = getIsResumed ? getIsResumed() : false;
    if (!isResumed) {
      term.writeln('正在启动终端...');
    }

    // 当用户输入时发送给 PTY
    term.onData((data) => {
      console.log('Terminal input:', data);
      if (onDataRef.current) {
        onDataRef.current(data);
      }
    });

    const handleResize = () => {
      try {
        fit.fit();
      } catch (e) {
        // ignore
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      terminalInstance.current = null;
    };
  }, []); // 空依赖项，只在挂载时运行一次

  // 点击时聚焦终端
  const handleClick = () => {
    terminalInstance.current?.focus();
  };

  return (
    <div
      ref={terminalRef}
      onClick={handleClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 0 20px rgba(86, 182, 255, 0.3), inset 0 0 30px rgba(0, 0, 0, 0.5)';
        e.currentTarget.style.border = '1px solid rgba(86, 182, 255, 0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'inset 0 0 20px rgba(0, 0, 0, 0.5)';
        e.currentTarget.style.border = '1px solid transparent';
      }}
      style={{
        width: '100%',
        height: '100%',
        minHeight: '400px',
        backgroundColor: '#1e1e1e',
        padding: '12px',
        boxSizing: 'border-box',
        cursor: 'text',
        borderRadius: '8px',
        boxShadow: 'inset 0 0 20px rgba(0, 0, 0, 0.5)',
        border: '1px solid transparent',
        transition: 'all 0.3s ease',
      }}
    />
  );
}
