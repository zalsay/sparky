import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

import { invoke, isTauri } from '@tauri-apps/api/core';
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
  envs?: Record<string, string>;
  defaultProviderId?: string;
  selectedModelId?: string;
  agentType?: string;
}

export interface TerminalRef {
  scrollToBottom: () => void;
}

interface TerminalCacheItem {
  term: Terminal;
  fit: FitAddon;
  historyApplied?: boolean;
  followOutput: boolean;
  lastContainerWidth?: number;
  lastContainerHeight?: number;
}

const terminalCache = new Map<string, TerminalCacheItem>();

let globalWriterReady = false;

const isNearBottom = (term: Terminal, threshold = 2) => {
  const buf = term.buffer.active;
  return buf.baseY - buf.viewportY <= threshold;
};

const fitIfNeeded = (cached: TerminalCacheItem, container: HTMLElement) => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (cached.lastContainerWidth === w && cached.lastContainerHeight === h) return;
  cached.lastContainerWidth = w;
  cached.lastContainerHeight = h;
  cached.fit.fit();
};



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

  const created: TerminalCacheItem = { term, fit, historyApplied: false, followOutput: true, lastContainerWidth: undefined, lastContainerHeight: undefined };
  terminalCache.set(terminalId, created);
  return created;
}

export default forwardRef<TerminalRef, TerminalProps>(function TerminalComponent({ projectPath, terminalId, title, onData, onLinkClick, mergeTop, historyLines, fullscreen, theme, envs, defaultProviderId, selectedModelId, agentType = 'claude' }: TerminalProps, ref) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);
  const onLinkClickRef = useRef(onLinkClick);
  const webInputBufferRef = useRef('');


  const tauriAvailable = isTauri();
  const { startPty, write, clearPty } = usePty(terminalId, projectPath, envs, undefined, defaultProviderId, selectedModelId, agentType);

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
    if (!tauriAvailable) return;
    try {
      await invoke('set_active_project', { project_path: path });
    } catch (e) {
      console.error('Failed to set active project:', e);
    }
  };

  useEffect(() => {
    if (!globalWriterReady) {
      (window as any).__terminalWrite = (tid: string, data: string) => {
        const cached = terminalCache.get(tid);
        if (!cached) return;

        // 高频输出时不要强制滚动到底部：用户一旦滚动离开底部，就暂停跟随，直到回到底部。
        const shouldScroll = cached.followOutput;
        cached.term.write(data, () => {
          if (shouldScroll) {
            cached.term.scrollToBottom();
          }
        });
      };
      if (!(window as any).__terminalExec) {
        (window as any).__terminalExec = async (_tid: string, data: string) => {
          const exec = (window as any).__terminalExecImpl;
          if (exec) {
            await exec(data);
          }
        };
      }
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

    // 追踪用户是否在底部：离开底部则暂停自动跟随，回到底部再恢复。
    const followDisposable = cached.term.onScroll(() => {
      cached.followOutput = isNearBottom(cached.term);
    });

    const dataDisposable = cached.term.onData((data) => {
      if (!tauriAvailable && (window as any).__terminalExec) {
        let buffer = webInputBufferRef.current;
        let i = 0;
        while (i < data.length) {
          const code = data.charCodeAt(i);
          if (code === 0x1b) {
            i++;
            if (i < data.length && data[i] === '[') {
              i++;
              while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++;
              i++;
            } else if (i < data.length) {
              i++;
            }
            continue;
          }
          if (data[i] === '\r' || data[i] === '\n') {
            const command = buffer + '\n';
            buffer = '';
            if (command.trim()) {
              (window as any).__terminalExec(terminalId, command);
            }
            i++;
            continue;
          }
          if (code === 127) {
            buffer = buffer.slice(0, -1);
            i++;
            continue;
          }
          if (code < 32) {
            i++;
            continue;
          }
          buffer += data[i];
          i++;
        }
        webInputBufferRef.current = buffer;
      } else {
        write(data);
      }
      if (onDataRef.current) {
        onDataRef.current(data);
      }
    });

    const resizeDisposable = cached.term.onResize(async ({ cols, rows }) => {
      if (disposed || !ptyReady) return;
      if (!tauriAvailable) return;
      try {
        await invoke('pty_resize', { terminal_id: terminalId, cols, rows });
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
            cached.term.scrollToBottom();
          } catch (e) {
            // ignore
          }
        }
      });
    });
    resizeObserver.observe(container);

    if (tauriAvailable) {
      // Start PTY, then mark ready and do initial fit
      startPty().then((result) => {
        if (!disposed && result) {
          ptyReady = true;
          setTimeout(() => {
            if (!disposed) {
              try {
                fitIfNeeded(cached, container);
              } catch (e) {
                // ignore
              }
            }
          }, 50);
        }
      });
    } else {
      ptyReady = true;
      setTimeout(() => {
        if (!disposed) {
          try {
            fitIfNeeded(cached, container);
          } catch (e) {
            // ignore
          }
        }
      }, 50);
    }

    return () => {
      disposed = true;
      ptyReady = false;
      resizeObserver.disconnect();
      linkProvider.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      followDisposable?.dispose();
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
          const shouldScroll = isNearBottom(cached.term);
          fitRef.current?.fit();
          if (shouldScroll) {
            cached.term.scrollToBottom();
          }
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
    cached.term.write(`${historyLines.join('\r\n')}\r\n`, () => {
      const shouldScroll = isNearBottom(cached.term);
      if (shouldScroll) {
        cached.term.scrollToBottom();
      }
    });
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
            // IME / 中文输入法组合输入期间（以及 macOS 常见的 key="Process" / keyCode=229），
            // 不能拦截/吞掉 keydown，否则可能导致中文/全角符号无法提交到 xterm。
            const anyEvent = e as any;
            if (anyEvent.isComposing || e.key === 'Process' || anyEvent.keyCode === 229) {
              return;
            }

            // 仅在“组合键快捷键”场景下阻止冒泡，避免触发外层快捷键；
            // 不要对单纯的 Shift（常用于输入中文标点/全角符号）做 stopPropagation。
            if (e.shiftKey && (e.metaKey || e.ctrlKey || e.altKey)) {
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
