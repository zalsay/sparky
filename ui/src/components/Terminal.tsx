import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onData?: (data: string) => void;
}

export default function TerminalComponent({ onData }: TerminalProps) {
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
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        selectionBackground: '#264f78',
      },
      convertEol: true,
      rows: 20,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    term.open(terminalRef.current);
    fit.fit();

    // 自动聚焦终端
    term.focus();

    terminalInstance.current = term;
    fitAddon.current = fit;

    term.writeln('═══ Claude Monitor 终端 ═══');
    term.writeln('');
    term.writeln('已连接到终端');
    term.writeln('');

    // 当用户输入时发送给 PTY
    term.onData((data) => {
      console.log('Terminal input:', data);
      if (onDataRef.current) {
        onDataRef.current(data);
      }
    });

    const handleResize = () => {
      fit.fit();
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
      style={{
        width: '100%',
        height: '100%',
        minHeight: '400px',
        backgroundColor: '#1e1e1e',
        padding: '8px',
        boxSizing: 'border-box',
        cursor: 'text',
      }}
    />
  );
}
