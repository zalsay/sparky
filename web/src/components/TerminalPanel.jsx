import { useEffect, useRef, useState } from 'react'
import { CodexConversationPanel } from './CodexConversationPanel'

function sessionTabLabel(tab, sessionTabs) {
  if (!tab.temporary) {
    const primaryTabs = sessionTabs.filter((item) => !item.temporary)
    if (primaryTabs.length > 1) {
      return `主 ${tab.id.slice(0, 4)}`
    }

    return '主会话'
  }

  const temporaryTabs = sessionTabs.filter((item) => item.temporary)
  const index = temporaryTabs.findIndex((item) => item.id === tab.id)
  return index >= 0 ? `终端 ${index + 1}` : '终端'
}

function getDropPlacement(event) {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientX >= rect.left + (rect.width / 2) ? 'after' : 'before'
}

function DesktopSessionTabs({
  onReorderSessionTab,
  onSwitchSessionTab,
  sessionId,
  sessionTabs,
}) {
  const [draggingId, setDraggingId] = useState('')
  const [dropHint, setDropHint] = useState(null)

  const clearDragState = () => {
    setDraggingId('')
    setDropHint(null)
  }

  return (
    <div className="terminal-tabs" role="tablist" aria-label="PTY 标签">
      {sessionTabs.map((tab) => {
        const isDragging = tab.id === draggingId
        const dropBefore = dropHint?.targetId === tab.id && dropHint.position === 'before'
        const dropAfter = dropHint?.targetId === tab.id && dropHint.position === 'after'

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            draggable={sessionTabs.length > 1}
            aria-selected={tab.id === sessionId}
            className={`terminal-tab ${tab.id === sessionId ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${dropBefore ? 'drop-before' : ''} ${dropAfter ? 'drop-after' : ''}`}
            onClick={() => onSwitchSessionTab(tab)}
            onDragStart={(event) => {
              setDraggingId(tab.id)
              setDropHint(null)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', tab.id)
            }}
            onDragOver={(event) => {
              if (!draggingId || draggingId === tab.id) {
                return
              }

              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const nextPlacement = getDropPlacement(event)
              setDropHint((prev) => (
                prev?.targetId === tab.id && prev.position === nextPlacement
                  ? prev
                  : { targetId: tab.id, position: nextPlacement }
              ))
            }}
            onDragEnd={clearDragState}
            onDrop={(event) => {
              event.preventDefault()
              const draggedId = event.dataTransfer.getData('text/plain') || draggingId
              if (!draggedId || draggedId === tab.id) {
                clearDragState()
                return
              }

              const placement = dropHint?.targetId === tab.id
                ? dropHint.position
                : getDropPlacement(event)

              onReorderSessionTab?.(draggedId, tab.id, placement)
              clearDragState()
            }}
            title={`${tab.label} · ${tab.id} · 按住拖动调整顺序`}
          >
            <span className={`terminal-tab-dot ${tab.temporary ? 'temporary' : 'default'}`} />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function MobilePtyManager({
  connected,
  currentSessionTemporary,
  onDestroyCurrentSession,
  onOpenTemporarySession,
  onOpenRawTerminal,
  onRefreshTimeline,
  onScrollToBottom,
  onSwitchSessionTab,
  selectedProject,
  sessionId,
  sessionTabs,
  step,
  variant = 'panel',
}) {
  if (!sessionTabs.length) {
    return null
  }

  const statusLabel = connected ? '运行中' : '未连接'

  return (
    <div className={`mobile-pty-manager mobile-pty-manager-${variant}`}>
      <div className="mobile-pty-manager__header">
        <span className="eyebrow">会话列表</span>
        <div className="mobile-pty-manager__actions">
          {variant === 'panel' ? (
            <>
              <button
                type="button"
                className="mobile-pty-manager__icon-btn"
                onClick={onScrollToBottom}
                aria-label="滚动到底部"
                title="滚动到底部"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 4.25v9.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M6.3 10.7L10 14.45l3.7-3.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5.25 16h9.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className="mobile-pty-manager__icon-btn"
                onClick={onRefreshTimeline}
                aria-label="刷新"
                title="刷新"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M15.5 7.5A6 6 0 106.3 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M15.5 4.75v4h-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="mobile-pty-manager__icon-btn"
                onClick={onOpenRawTerminal}
                aria-label="原始终端"
                title="原始终端"
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M4.5 5.75h11a1.25 1.25 0 011.25 1.25v6a1.25 1.25 0 01-1.25 1.25h-11A1.25 1.25 0 013.25 13V7A1.25 1.25 0 014.5 5.75z" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M6.25 8.4l1.85 1.6-1.85 1.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9.9 11.6h3.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="mobile-pty-manager__icon-btn"
            onClick={onOpenTemporarySession}
            disabled={!selectedProject?.id || step === 'connecting'}
            aria-label="新开临时 PTY"
            title="新开临时 PTY"
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 4.5v11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="mobile-pty-manager__icon-btn"
            onClick={onDestroyCurrentSession}
            disabled={!sessionId}
            aria-label={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
            title={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M6 6l8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <div className="terminal-tabs mobile-pty-manager__tabs" role="tablist" aria-label="移动端会话列表">
        {sessionTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === sessionId}
            className={`terminal-tab ${tab.id === sessionId ? 'active' : ''}`}
            onClick={() => onSwitchSessionTab(tab)}
            title={`${tab.label} · ${tab.id}`}
          >
            <span className={`terminal-tab-dot ${tab.temporary ? 'temporary' : 'default'}`} />
            <span>{sessionTabLabel(tab, sessionTabs)}</span>
            {tab.id === sessionId ? (
              <span className={`terminal-tab-status ${connected ? 'is-online' : 'is-offline'}`}>
                {statusLabel}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function MobileRawTerminalScrollbar({
  containerRef,
  enabled,
}) {
  const trackRef = useRef(null)
  const viewportRef = useRef(null)
  const dragStateRef = useRef({
    pointerId: null,
    dragging: false,
    thumbOffset: 0,
  })
  const [metrics, setMetrics] = useState({
    visible: false,
    height: 0,
    top: 0,
  })

  useEffect(() => {
    if (!enabled) {
      viewportRef.current = null
      setMetrics({
        visible: false,
        height: 0,
        top: 0,
      })
      return undefined
    }

    let frameId = 0
    let intervalId = 0
    let detachScroll = null
    let resizeObserver = null

    const updateMetrics = () => {
      const container = containerRef.current
      const nextViewport = container?.querySelector('.terminal-host.active .xterm-viewport') || null
      if (viewportRef.current !== nextViewport) {
        if (detachScroll) {
          detachScroll()
          detachScroll = null
        }
        viewportRef.current = nextViewport
        if (nextViewport) {
          const onScroll = () => {
            updateMetrics()
          }
          nextViewport.addEventListener('scroll', onScroll, { passive: true })
          detachScroll = () => nextViewport.removeEventListener('scroll', onScroll)
        }
      }

      const viewport = viewportRef.current
      const track = trackRef.current
      if (!viewport || !track) {
        setMetrics((prev) => (
          prev.visible
            ? { visible: false, height: 0, top: 0 }
            : prev
        ))
        return
      }

      const scrollHeight = viewport.scrollHeight
      const clientHeight = viewport.clientHeight
      const scrollTop = viewport.scrollTop
      const trackHeight = track.clientHeight
      const maxScrollTop = Math.max(scrollHeight - clientHeight, 0)
      const shouldShow = scrollHeight > clientHeight + 12 && trackHeight > 0

      if (!shouldShow) {
        setMetrics((prev) => (
          prev.visible
            ? { visible: false, height: 0, top: 0 }
            : prev
        ))
        return
      }

      const thumbHeight = Math.max((clientHeight / scrollHeight) * trackHeight, 34)
      const maxThumbTop = Math.max(trackHeight - thumbHeight, 0)
      const thumbTop = maxScrollTop > 0
        ? (scrollTop / maxScrollTop) * maxThumbTop
        : 0

      setMetrics((prev) => {
        const next = {
          visible: true,
          height: thumbHeight,
          top: thumbTop,
        }

        if (
          prev.visible === next.visible
          && Math.abs(prev.height - next.height) < 0.5
          && Math.abs(prev.top - next.top) < 0.5
        ) {
          return prev
        }

        return next
      })
    }

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frameId)
      frameId = window.requestAnimationFrame(updateMetrics)
    }

    scheduleUpdate()
    intervalId = window.setInterval(scheduleUpdate, 220)

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleUpdate()
      })

      if (containerRef.current) {
        resizeObserver.observe(containerRef.current)
      }

      if (trackRef.current) {
        resizeObserver.observe(trackRef.current)
      }
    }

    return () => {
      window.cancelAnimationFrame(frameId)
      window.clearInterval(intervalId)
      if (detachScroll) {
        detachScroll()
      }
      if (resizeObserver) {
        resizeObserver.disconnect()
      }
    }
  }, [containerRef, enabled])

  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    const handlePointerMove = (event) => {
      const dragState = dragStateRef.current
      if (!dragState.dragging || dragState.pointerId !== event.pointerId) {
        return
      }

      const viewport = viewportRef.current
      const track = trackRef.current
      if (!viewport || !track) {
        return
      }

      event.preventDefault()
      const trackRect = track.getBoundingClientRect()
      const thumbHeight = Math.max(metrics.height, 34)
      const maxThumbTop = Math.max(trackRect.height - thumbHeight, 0)
      const nextThumbTop = Math.min(
        Math.max(event.clientY - trackRect.top - dragState.thumbOffset, 0),
        maxThumbTop,
      )
      const nextScrollTop = maxThumbTop > 0
        ? (nextThumbTop / maxThumbTop) * Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
        : 0

      viewport.scrollTop = nextScrollTop
    }

    const handlePointerUp = (event) => {
      if (dragStateRef.current.pointerId !== event.pointerId) {
        return
      }

      dragStateRef.current = {
        pointerId: null,
        dragging: false,
        thumbOffset: 0,
      }
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [enabled, metrics.height])

  const scrollViewportTo = (clientY, thumbOffset = metrics.height / 2) => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) {
      return
    }

    const trackRect = track.getBoundingClientRect()
    const thumbHeight = Math.max(metrics.height, 34)
    const maxThumbTop = Math.max(trackRect.height - thumbHeight, 0)
    const nextThumbTop = Math.min(
      Math.max(clientY - trackRect.top - thumbOffset, 0),
      maxThumbTop,
    )
    const nextScrollTop = maxThumbTop > 0
      ? (nextThumbTop / maxThumbTop) * Math.max(viewport.scrollHeight - viewport.clientHeight, 0)
      : 0

    viewport.scrollTop = nextScrollTop
  }

  if (!enabled) {
    return null
  }

  return (
    <div
      ref={trackRef}
      className={`mobile-terminal-scrollbar ${metrics.visible ? 'is-visible' : 'is-hidden'}`}
      onPointerDown={(event) => {
        if (metrics.visible && event.target === event.currentTarget) {
          scrollViewportTo(event.clientY)
        }
      }}
    >
      {metrics.visible ? (
        <button
          type="button"
          className="mobile-terminal-scrollbar__thumb"
          style={{
            height: `${metrics.height}px`,
            transform: `translateY(${metrics.top}px)`,
          }}
          aria-label="拖动滚动终端"
          onPointerDown={(event) => {
            event.preventDefault()
            const thumbRect = event.currentTarget.getBoundingClientRect()
            event.currentTarget.setPointerCapture?.(event.pointerId)
            dragStateRef.current = {
              pointerId: event.pointerId,
              dragging: true,
              thumbOffset: event.clientY - thumbRect.top,
            }
          }}
        />
      ) : null}
    </div>
  )
}

export function TerminalPanel({
  canReconnectCurrentSession,
  connected,
  codexTimeline,
  codexTimelineError,
  codexTimelineLoading,
  currentSessionTemporary,
  onDestroyCurrentSession,
  onLeaveSessionView,
  onRefreshCodexTimeline,
  onOpenTemporarySession,
  onReconnectCurrentSession,
  onReorderSessionTab,
  onSwitchSessionTab,
  reconnectNotice,
  selectedProject,
  sessionId,
  sessionTabs,
  step,
  registerTerminalHost,
}) {
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 780 : false
  ))
  const [showRawTerminal, setShowRawTerminal] = useState(false)
  const autoRawTerminalRef = useRef(false)
  const rawTerminalBodyRef = useRef(null)
  const [scrollToBottomRequest, setScrollToBottomRequest] = useState(0)
  const isCodexMobile = selectedProject?.runtime === 'codex' && isMobileViewport

  useEffect(() => {
    const handleResize = () => {
      setIsMobileViewport(window.innerWidth <= 780)
    }

    handleResize()
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
    }
  }, [])

  useEffect(() => {
    if (!isCodexMobile) {
      autoRawTerminalRef.current = false
      setShowRawTerminal(false)
    }
  }, [isCodexMobile, sessionId])

  useEffect(() => {
    if (!isCodexMobile) {
      autoRawTerminalRef.current = false
      return
    }

    if (currentSessionTemporary) {
      if (!showRawTerminal) {
        autoRawTerminalRef.current = true
        setShowRawTerminal(true)
      }
      return
    }

    if (autoRawTerminalRef.current) {
      autoRawTerminalRef.current = false
      setShowRawTerminal(false)
    }
  }, [currentSessionTemporary, isCodexMobile, showRawTerminal, sessionId])

  if (isCodexMobile) {
    return (
      <section className="terminal-panel glass-panel terminal-panel-codex-mobile">
        <MobilePtyManager
          connected={connected}
          currentSessionTemporary={currentSessionTemporary}
          onDestroyCurrentSession={onDestroyCurrentSession}
          onOpenTemporarySession={onOpenTemporarySession}
          onOpenRawTerminal={() => {
            autoRawTerminalRef.current = false
            setShowRawTerminal(true)
          }}
          onRefreshTimeline={onRefreshCodexTimeline}
          onScrollToBottom={() => setScrollToBottomRequest((value) => value + 1)}
          onSwitchSessionTab={onSwitchSessionTab}
          selectedProject={selectedProject}
          sessionId={sessionId}
          sessionTabs={sessionTabs}
          step={step}
          variant="panel"
        />

        {showRawTerminal ? (
          <section className="codex-raw-terminal-sheet">
            <div className="codex-raw-terminal-sheet__header">
              <strong className="codex-raw-terminal-sheet__title">原始终端</strong>
              <button
                type="button"
                className="chat-panel__info-button codex-raw-terminal-sheet__close"
                onClick={() => {
                  autoRawTerminalRef.current = false
                  setShowRawTerminal(false)
                }}
              >
                关闭
              </button>
            </div>
            <div ref={rawTerminalBodyRef} className="terminal-host-shell codex-raw-terminal-sheet__body">
              <div className="terminal-host-stack">
                {sessionTabs.length ? (
                  sessionTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`terminal-host ${tab.id === sessionId ? 'active' : 'inactive'}`}
                      aria-hidden={tab.id === sessionId ? undefined : 'true'}
                    >
                      <div ref={registerTerminalHost(tab.id)} className="terminal-host-canvas" />
                    </div>
                  ))
                ) : (
                  <div className="codex-conversation-state">当前没有可附着的终端会话。</div>
                )}
              </div>
              <MobileRawTerminalScrollbar
                containerRef={rawTerminalBodyRef}
                enabled={Boolean(showRawTerminal && sessionTabs.length && sessionId)}
              />
            </div>
          </section>
        ) : (
          <CodexConversationPanel
            codexTimeline={codexTimeline}
            codexTimelineError={codexTimelineError}
            codexTimelineLoading={codexTimelineLoading}
            sessionId={sessionId}
            scrollToBottomRequest={scrollToBottomRequest}
          />
        )}

        {reconnectNotice ? (
          <div className="terminal-reconnect-banner codex-mobile-reconnect-banner" role="status" aria-live="polite">
            <span className="terminal-reconnect-text">{reconnectNotice.message}</span>
            <button
              type="button"
              className="toolbar-btn terminal-reconnect-btn"
              onClick={onReconnectCurrentSession}
              disabled={!canReconnectCurrentSession}
            >
              {step === 'connecting' ? '恢复中' : '恢复当前 PTY'}
            </button>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section className="terminal-panel glass-panel">
      <div className="terminal-panel-bar">
        <div className="terminal-toolbar">
          <div className="terminal-dots">
            <button
              type="button"
              className="terminal-dot terminal-dot-close"
              onClick={onDestroyCurrentSession}
              disabled={!sessionId}
              aria-label={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
              title={currentSessionTemporary ? '关闭临时 PTY' : '关闭主会话'}
            />
            <button
              type="button"
              className="terminal-dot terminal-dot-minimize"
              onClick={onLeaveSessionView}
              aria-label="返回列表"
              title="返回列表"
            />
            <button
              type="button"
              className="terminal-dot terminal-dot-expand"
              onClick={onOpenTemporarySession}
              disabled={!selectedProject?.id || step === 'connecting'}
              aria-label="打开新的临时 PTY"
              title="打开新的临时 PTY"
            />
          </div>
          <DesktopSessionTabs
            onReorderSessionTab={onReorderSessionTab}
            onSwitchSessionTab={onSwitchSessionTab}
            sessionId={sessionId}
            sessionTabs={sessionTabs}
          />
        </div>
        <div className="terminal-panel-meta">
          <span>{currentSessionTemporary ? '临时 Shell' : `${selectedProject?.provider || '自定义'} 运行时`}</span>
          <span>{connected ? '实时流' : '等待流建立'}</span>
        </div>
      </div>

      <div className="terminal-host-shell">
        <div className="terminal-host-stack">
          {sessionTabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-host ${tab.id === sessionId ? 'active' : 'inactive'}`}
              aria-hidden={tab.id === sessionId ? undefined : 'true'}
            >
              <div ref={registerTerminalHost(tab.id)} className="terminal-host-canvas" />
            </div>
          ))}
        </div>
        {reconnectNotice ? (
          <div className="terminal-reconnect-banner" role="status" aria-live="polite">
            <span className="terminal-reconnect-text">{reconnectNotice.message}</span>
            <button
              type="button"
              className="toolbar-btn terminal-reconnect-btn"
              onClick={onReconnectCurrentSession}
              disabled={!canReconnectCurrentSession}
            >
              {step === 'connecting' ? '恢复中' : '恢复当前 PTY'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}
