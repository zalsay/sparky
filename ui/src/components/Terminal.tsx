import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { invoke } from '@tauri-apps/api/core';
import { usePty } from '../hooks/usePty';
import CodeIcon from '../assets/Code.svg';

interface TerminalProps {
  projectPath: string;
  terminalId: string;
  title?: string;
  onData?: (data: string) => void;
  onLinkClick?: (path: string) => void;
  mergeTop?: boolean;
  historyLines?: string[];
  fullscreen?: boolean;
  theme?: {
    background?: string;
    foreground?: string;
    fontSize?: number;
  };
}

export interface TerminalRef {
  scrollToBottom: () => void;
}

interface TerminalCacheItem {
  term: Terminal;
  fit: FitAddon;
  historyApplied?: boolean;
}

const terminalCache = new Map<string, TerminalCacheItem>();

let globalWriterReady = false;



function getOrCreateTerminal(terminalId: string, title?: string, themeVals?: { background?: string; foreground?: string; fontSize?: number }) {
  const cached = terminalCache.get(terminalId);
  if (cached) {
    if (themeVals) {
      cached.term.options.theme = {
        ...cached.term.options.theme,
        background: themeVals.background || '#1e1e1e',
        foreground: themeVals.foreground || '#e0e0e0',
      };
      if (themeVals.fontSize) {
        cached.term.options.fontSize = themeVals.fontSize;
      }
    }
    return cached;
  }

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: themeVals?.fontSize || 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontWeight: 'bold',
    fontWeightBold: '900',
    theme: {
      background: themeVals?.background || '#1e1e1e',
      foreground: themeVals?.foreground || '#e0e0e0',
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
  term.writeln(`正在启动 ${title || '终端'}...`);

  const created = { term, fit, historyApplied: false };
  terminalCache.set(terminalId, created);
  return created;
}

export default forwardRef<TerminalRef, TerminalProps>(function TerminalComponent({ projectPath, terminalId, title, onData, onLinkClick, mergeTop, historyLines, fullscreen, theme }: TerminalProps, ref) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);
  const onLinkClickRef = useRef(onLinkClick);

  const { startPty, write, clearPty } = usePty();

  useImperativeHandle(ref, () => ({
    scrollToBottom: () => {
      termRef.current?.scrollToBottom();
    }
  }));

  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);

  useEffect(() => {
    onLinkClickRef.current = onLinkClick;
  }, [onLinkClick]);

  const notifyBackendActiveProject = async (path: string) => {
    try {
      await invoke('set_active_project', { projectPath: path });
    } catch (e) {
      console.error('Failed to set active project:', e);
    }
  };

  useEffect(() => {
    if (!globalWriterReady) {
      (window as any).__terminalWrite = (tid: string, data: string) => {
        const cached = terminalCache.get(tid);
        if (cached) {
          cached.term.write(data);
        }
      };
      globalWriterReady = true;
    }
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;
    let disposed = false;
    let ptyReady = false;

    notifyBackendActiveProject(projectPath);

    const container = terminalRef.current;
    container.innerHTML = '';

    const cached = getOrCreateTerminal(terminalId, title, theme);
    if (cached.term.element) {
      container.appendChild(cached.term.element);
    } else {
      cached.term.open(container);
    }

    cached.term.focus();

    termRef.current = cached.term;
    fitRef.current = cached.fit;

    cached.term.attachCustomKeyEventHandler(() => {
      return true;
    });

    // Register link provider for file paths (handles underline and clicking)
    const linkProvider = cached.term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void) {
        const line = cached.term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) { callback(undefined); return; }
        const lineText = line.translateToString(true);
        const links: any[] = [];

        // Match Linux/Mac paths (absolute, relative, home)
        const pathRegex = /(?:^|\s)(\/?|\.\/|\.\.\/|~\/)([a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)+)(?::\d+)?/g;
        let match;

        while ((match = pathRegex.exec(lineText)) !== null) {
          const matchText = match[1] + match[2]; // The actual path part, excluding leading spaces

          let startIndex = match.index;
          const spaceMatch = match[0].match(/^\s/);
          if (spaceMatch) startIndex += spaceMatch[0].length;

          const startX = startIndex + 1; // xterm is 1-indexed
          const endX = startIndex + matchText.length;

          let popoverEl: HTMLDivElement | null = null;

          links.push({
            range: {
              start: { x: startX, y: bufferLineNumber },
              end: { x: endX, y: bufferLineNumber },
            },
            text: matchText,
            decorations: { underline: true, pointerCursor: true },
            activate: (_event: MouseEvent, text: string) => {
              // Strip line:col suffix for path resolution
              const cleanPath = text.replace(/:\d+(:\d+)?$/, '');
              let resolvedPath = cleanPath;
              if (cleanPath.startsWith('~/')) {
                // Cannot resolve ~ on frontend, pass as-is
                resolvedPath = cleanPath;
              } else if (cleanPath.startsWith('/')) {
                // Absolute path: pass as-is
                resolvedPath = cleanPath;
              } else if (cleanPath.startsWith('Users/')) {
                // Absolute path missing leading slash
                resolvedPath = '/' + cleanPath;
              } else {
                // Relative path: resolve against project path
                resolvedPath = projectPath + '/' + cleanPath.replace(/^\.\//, '');
              }
              console.log('Terminal Link Clicked:', { text, cleanPath, resolvedPath });
              if (onLinkClickRef.current) {
                onLinkClickRef.current(resolvedPath);
              }
            },
            hover: (event: MouseEvent, text: string) => {
              if (popoverEl) return;

              popoverEl = document.createElement('div');
              popoverEl.style.position = 'absolute';
              popoverEl.style.zIndex = '9999';
              popoverEl.style.display = 'flex';
              popoverEl.style.alignItems = 'center';
              popoverEl.style.justifyContent = 'center';
              popoverEl.style.padding = '4px';
              popoverEl.style.borderRadius = '4px';
              popoverEl.style.background = 'var(--bg-secondary)';
              popoverEl.style.border = '1px solid var(--border-color)';
              popoverEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
              popoverEl.style.cursor = 'pointer';
              popoverEl.innerHTML = `<img src="${CodeIcon}" alt="Open" style="width: 14px; height: 14px; filter: var(--icon-filter);" />`;

              // Position it slightly above and right of the mouse
              popoverEl.style.left = `${event.clientX + 10}px`;
              popoverEl.style.top = `${event.clientY - 20}px`;

              // Forward click to activate
              popoverEl.onclick = (e) => {
                e.stopPropagation();
                // Accessing the last added link since `this` context doesn't exist here cleanly
                links[links.length - 1].activate(e, text);
              };

              document.body.appendChild(popoverEl);
            },
            leave: () => {
              if (popoverEl) {
                popoverEl.remove();
                popoverEl = null;
              }
            },
          });
        }
        // Match Claude action patterns like Update(path/to/file.tsx), Create(path), Read(path), Write(path), Edit(path)
        const actionRegex = /\b(Update|Create|Read|Write|Edit|Wrote|Updated|Created|Reading|Writing|Editing)\(([a-zA-Z0-9_./\-@]+(?:\.[a-zA-Z0-9]+)?)\)/g;
        let actionMatch;

        while ((actionMatch = actionRegex.exec(lineText)) !== null) {
          const filePath = actionMatch[2];  // e.g. "path/to/file.tsx"
          const matchStart = actionMatch.index;

          // Calculate position of just the file path inside parentheses
          const actionWord = actionMatch[1];
          const pathStartInLine = matchStart + actionWord.length + 1; // skip "Update("
          const pathStartX = pathStartInLine + 1; // xterm is 1-indexed
          const pathEndX = pathStartInLine + filePath.length;

          let popoverEl: HTMLDivElement | null = null;

          links.push({
            range: {
              start: { x: pathStartX, y: bufferLineNumber },
              end: { x: pathEndX, y: bufferLineNumber },
            },
            text: filePath,
            decorations: { underline: true, pointerCursor: true },
            activate: (_event: MouseEvent, text: string) => {
              const cleanPath = text.replace(/:\d+(:\d+)?$/, '');
              let resolvedPath = cleanPath;
              if (cleanPath.startsWith('/')) {
                resolvedPath = cleanPath;
              } else if (cleanPath.startsWith('~/')) {
                resolvedPath = cleanPath;
              } else if (cleanPath.startsWith('Users/')) {
                resolvedPath = '/' + cleanPath;
              } else {
                resolvedPath = projectPath + '/' + cleanPath.replace(/^\.\//, '');
              }
              console.log('Terminal Action Link Clicked:', { text, cleanPath, resolvedPath, action: actionWord });
              if (onLinkClickRef.current) {
                onLinkClickRef.current(resolvedPath);
              }
            },
            hover: (event: MouseEvent, text: string) => {
              if (popoverEl) return;

              popoverEl = document.createElement('div');
              popoverEl.style.position = 'absolute';
              popoverEl.style.zIndex = '9999';
              popoverEl.style.display = 'flex';
              popoverEl.style.alignItems = 'center';
              popoverEl.style.justifyContent = 'center';
              popoverEl.style.padding = '4px';
              popoverEl.style.borderRadius = '4px';
              popoverEl.style.background = 'var(--bg-secondary)';
              popoverEl.style.border = '1px solid var(--border-color)';
              popoverEl.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
              popoverEl.style.cursor = 'pointer';
              popoverEl.innerHTML = `<img src="${CodeIcon}" alt="Open" style="width: 14px; height: 14px; filter: var(--icon-filter);" />`;

              popoverEl.style.left = `${event.clientX + 10}px`;
              popoverEl.style.top = `${event.clientY - 20}px`;

              popoverEl.onclick = (e) => {
                e.stopPropagation();
                links[links.length - 1].activate(e, text);
              };

              document.body.appendChild(popoverEl);
            },
            leave: () => {
              if (popoverEl) {
                popoverEl.remove();
                popoverEl = null;
              }
            },
          });
        }

        callback(links.length > 0 ? links : undefined);
      }
    });

    const dataDisposable = cached.term.onData((data) => {
      write(data);
      if (onDataRef.current) {
        onDataRef.current(data);
      }
    });

    const resizeDisposable = cached.term.onResize(async ({ cols, rows }) => {
      if (disposed || !ptyReady) return;
      try {
        await invoke('pty_resize', { terminalId, cols, rows });
      } catch (e) {
        // ignore
      }
    });

    // ResizeObserver: only fit after PTY is ready, debounced
    let resizeRaf = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed || !ptyReady) return;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (disposed || !ptyReady) return;
        if (container && container.clientWidth > 0 && container.clientHeight > 0) {
          try {
            cached.fit.fit();
          } catch (e) {
            // ignore
          }
        }
      });
    });
    resizeObserver.observe(container);

    // Start PTY, then mark ready and do initial fit
    startPty(projectPath, terminalId).then((result) => {
      if (!disposed && result) {
        ptyReady = true;
        setTimeout(() => {
          if (!disposed) {
            try {
              cached.fit.fit();
            } catch (e) {
              // ignore
            }
          }
        }, 50);
      }
    });

    return () => {
      disposed = true;
      ptyReady = false;
      resizeObserver.disconnect();
      linkProvider.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();

      clearPty();
      // Don't delete from cache - keep terminal state for when user navigates back
      if (container) {
        container.innerHTML = '';
      }
      termRef.current = null;
    };
  }, [terminalId, projectPath]);

  // 当 theme 改变时，更新 xterm 内部背景色以及外层容器背景色
  useEffect(() => {
    const cached = terminalCache.get(terminalId);
    if (cached && theme) {
      cached.term.options.theme = {
        ...cached.term.options.theme,
        background: theme.background || '#1e1e1e',
        foreground: theme.foreground || '#e0e0e0',
      };
      if (terminalRef.current) {
        terminalRef.current.style.backgroundColor = 'transparent';
      }
    }
  }, [theme?.background, theme?.foreground, terminalId]);

  // 当 fontSize 改变时，动态更新终端字体大小
  useEffect(() => {
    const cached = terminalCache.get(terminalId);
    if (cached && theme?.fontSize) {
      cached.term.options.fontSize = theme.fontSize;
      // 字体大小变化后需要重新 fit
      setTimeout(() => {
        try {
          fitRef.current?.fit();
        } catch (e) {
          // ignore
        }
      }, 50);
    }
  }, [theme?.fontSize, terminalId]);

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
    const cached = terminalCache.get(terminalId);
    if (!cached || cached.historyApplied) {
      return;
    }
    cached.term.write(`${historyLines.join('\r\n')}\r\n`);
    cached.historyApplied = true;
  }, [historyLines, terminalId]);

  const handleClick = () => {
    termRef.current?.focus();
    notifyBackendActiveProject(projectPath);
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        minHeight: '0',
        backgroundColor: 'var(--bg-color)',
        padding: '0',
        boxSizing: 'border-box',
        overflow: 'hidden',
        cursor: 'text',
        borderRadius: fullscreen ? '0' : (mergeTop ? '0 0 8px 8px' : '8px'),
        transition: 'all 0.3s ease',
        display: 'flex',
        flexDirection: 'column',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 0 20px rgba(150, 150, 150, 0.3), inset 0 0 30px rgba(0, 0, 0, 0.5)';
        e.currentTarget.style.border = '1px solid rgba(150, 150, 150, 0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = 'inset 0 0 20px rgba(0, 0, 0, 0.5)';
        e.currentTarget.style.border = '1px solid transparent';
      }}
    >
      <div
        style={{
          flex: 1,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: theme?.background || '#1e1e1e',
          padding: '8px 12px',
          borderRadius: fullscreen ? '0' : (mergeTop ? '0 0 8px 8px' : '8px'),
          overflow: 'hidden',
          minHeight: 0,
        }}
      >
        <div
          ref={terminalRef}
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={(e) => {
            if (e.shiftKey) {
              e.stopPropagation();
            }
          }}
          style={{
            flex: 1,
            width: '100%',
            overflow: 'hidden',
            minHeight: 0,
          }}
        />
      </div>
    </div>
  );
});
