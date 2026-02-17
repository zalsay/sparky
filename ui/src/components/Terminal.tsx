import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  projectPath: string;
  onData?: (data: string) => void;
  mergeTop?: boolean;
  historyLines?: string[];
  fullscreen?: boolean;
}

interface TerminalCacheItem {
  term: Terminal;
  fit: FitAddon;
  historyApplied?: boolean;
}

const terminalCache = new Map<string, TerminalCacheItem>();
let activeProjectPath: string | null = null;
let globalWriterReady = false;

function getOrCreateTerminal(projectPath: string) {
  const cached = terminalCache.get(projectPath);
  if (cached) {
    return cached;
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
  term.writeln('正在启动终端...');

  const created = { term, fit, historyApplied: false };
  terminalCache.set(projectPath, created);
  return created;
}

export default function TerminalComponent({ projectPath, onData, mergeTop, historyLines, fullscreen }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    if (!globalWriterReady) {
      (window as any).__terminalWrite = (data: string) => {
        if (!activeProjectPath) {
          return;
        }
        const cached = terminalCache.get(activeProjectPath);
        if (cached) {
          cached.term.write(data);
        }
      };
      globalWriterReady = true;
    }
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;

    activeProjectPath = projectPath;
    const container = terminalRef.current;
    container.innerHTML = '';

    const cached = getOrCreateTerminal(projectPath);
    if (cached.term.element) {
      container.appendChild(cached.term.element);
    } else {
      cached.term.open(container);
    }

    setTimeout(() => {
      try {
        cached.fit.fit();
      } catch (e) {
        // ignore
      }
    }, 100);

    cached.term.focus();

    termRef.current = cached.term;
    fitRef.current = cached.fit;

    const dataDisposable = cached.term.onData((data) => {
      if (onDataRef.current) {
        onDataRef.current(data);
      }
    });

    const handleResize = () => {
      try {
        cached.fit.fit();
      } catch (e) {
        // ignore
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      dataDisposable.dispose();
      if (container) {
        container.innerHTML = '';
      }
      termRef.current = null;
    };
  }, [projectPath]);

  useEffect(() => {
    // 当 fullscreen 状态改变时，重新适应大小
    setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch (e) {
        // ignore
      }
    }, 100);
  }, [fullscreen]);

  useEffect(() => {
    if (!historyLines || historyLines.length === 0) {
      return;
    }
    const cached = terminalCache.get(projectPath);
    if (!cached || cached.historyApplied) {
      return;
    }
    cached.term.write(`${historyLines.join('\r\n')}\r\n`);
    cached.historyApplied = true;
  }, [historyLines, projectPath]);

  const handleClick = () => {
    termRef.current?.focus();
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
        borderRadius: fullscreen ? '0' : (mergeTop ? '0 0 8px 8px' : '8px'),
        boxShadow: 'inset 0 0 20px rgba(0, 0, 0, 0.5)',
        border: '1px solid transparent',
        transition: 'all 0.3s ease',
      }}
    />
  );
}
