import { useEffect, useRef, useState } from 'react'
import { SessionCloseModal } from './SessionCloseModal'
import { DEFAULT_SIDEBAR_WIDTH } from '../app/constants'
import { logSessionDebug, summarizeContentPreview } from '../app/sessionDebug'
import { WorkspaceShell } from './WorkspaceShell'
import { WorkspaceTopbar } from './WorkspaceTopbar'

function MobileCodexComposer({
  connected,
  codexTimelineUpdatedAtMs,
  onRefreshCodexTimeline,
  onSendSessionInput,
  sessionId,
}) {
  const inputRef = useRef(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [value, setValue] = useState('')
  const [sendCoolingDown, setSendCoolingDown] = useState(false)
  const cooldownTimerRef = useRef(null)
  const lastSentAtRef = useRef(0)

  const clearCooldownTimer = () => {
    if (cooldownTimerRef.current) {
      window.clearTimeout(cooldownTimerRef.current)
      cooldownTimerRef.current = null
    }
  }

  useEffect(() => {
    setValue('')
    setSendCoolingDown(false)
    setComposerOpen(false)
    lastSentAtRef.current = 0
    clearCooldownTimer()
  }, [sessionId])

  useEffect(() => () => {
    clearCooldownTimer()
  }, [])

  useEffect(() => {
    if (!sendCoolingDown || !codexTimelineUpdatedAtMs || !lastSentAtRef.current) {
      return
    }

    if (codexTimelineUpdatedAtMs >= lastSentAtRef.current) {
      setSendCoolingDown(false)
      clearCooldownTimer()
    }
  }, [codexTimelineUpdatedAtMs, sendCoolingDown])

  useEffect(() => {
    if (!composerOpen) {
      return
    }

    logSessionDebug('mobile_composer_open', {
      sessionId,
      connected,
    })

    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)

    return () => {
      window.clearTimeout(timer)
    }
  }, [composerOpen])

  const sendInput = () => {
    const content = value.trim()
    logSessionDebug('mobile_composer_send_attempt', {
      sessionId,
      connected,
      sendCoolingDown,
      rawLength: value.length,
      trimmedLength: content.length,
      preview: summarizeContentPreview(content),
    })

    if (!content || !sessionId || sendCoolingDown) {
      logSessionDebug('mobile_composer_send_blocked', {
        sessionId,
        connected,
        sendCoolingDown,
        reason: !content ? 'empty_content' : !sessionId ? 'missing_session_id' : 'cooling_down',
      })
      return
    }

    const sent = onSendSessionInput?.(sessionId, content, {
      ensureTrailingReturn: true,
      replaceIntermediateReturns: true,
      bulkInput: true,
    })
    logSessionDebug('mobile_composer_send_result', {
      sessionId,
      connected,
      sent: Boolean(sent),
      preview: summarizeContentPreview(content),
    })
    if (!sent) {
      return
    }

    setValue('')
    setComposerOpen(false)
    const sentAt = Date.now()
    lastSentAtRef.current = sentAt
    setSendCoolingDown(true)
    clearCooldownTimer()
    cooldownTimerRef.current = window.setTimeout(() => {
      setSendCoolingDown(false)
      cooldownTimerRef.current = null
    }, 1800)
    onRefreshCodexTimeline?.()
    window.setTimeout(() => {
      onRefreshCodexTimeline?.()
    }, 1200)
  }

  return (
    <>
      <button
        type="button"
        className="mobile-codex-composer-fab"
        disabled={!sessionId || !connected}
        aria-label="打开输入框"
        title={!sessionId || !connected ? '等待 PTY 连接后可发送' : '打开输入框'}
        onClick={() => setComposerOpen(true)}
      >
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M3.75 10.2L15.8 4.9c.58-.26 1.14.3.88.88L11.38 17.8c-.23.54-1.01.5-1.18-.07l-1-3.53a1 1 0 00-.68-.68l-3.53-1c-.56-.16-.61-.94-.07-1.17z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M8.8 11.2l4.05-4.05"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {composerOpen ? (
        <div
          className="mobile-codex-composer-modal-backdrop"
          onClick={() => setComposerOpen(false)}
        >
          <div
            className="mobile-codex-composer-modal glass-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">发送到当前会话</span>
            <input
              ref={inputRef}
              type="text"
              className="mobile-codex-composer__input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  sendInput()
                }
              }}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={connected ? '输入内容，回车发送' : '等待 PTY 连接后可发送'}
              disabled={!sessionId || !connected}
            />
            <div className="mobile-codex-composer-modal__actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setComposerOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={!sessionId || !connected || !value.trim() || sendCoolingDown}
                onClick={sendInput}
              >
                {sendCoolingDown ? '发送中...' : '发送'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

export function WorkspacePage({
  codexLoading,
  codexResumeLoading,
  connected,
  onLeaveSessionView,
  onOpenPrimarySession,
  onResetSidebarWidth,
  onResumeCodexSession,
  selectedProject,
  sidePanelProps,
  sidebarResizing,
  startSidebarResize,
  step,
  sessionCloseModalProps,
  terminalPanelProps,
  workspaceShellRef,
  workspaceShellStyle,
}) {
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 780 : false
  ))
  const [mobileSidePanelOpen, setMobileSidePanelOpen] = useState(false)
  const codexTimelineItems = Array.isArray(terminalPanelProps?.codexTimeline?.items)
    ? terminalPanelProps.codexTimeline.items
    : []
  const latestCodexItem = codexTimelineItems[codexTimelineItems.length - 1] || null
  const codexBusyKinds = new Set(['reasoning', 'tool_call', 'tool_result', 'commentary', 'status'])
  const codexBusy = selectedProject?.runtime === 'codex' && (
    codexLoading
    || codexResumeLoading !== ''
    || terminalPanelProps?.codexTimelineLoading
    || step === 'connecting'
    || (connected && latestCodexItem && codexBusyKinds.has(latestCodexItem.kind))
  )
  const showMobileCodexComposer = isMobileViewport && selectedProject?.runtime === 'codex'

  useEffect(() => {
    const handleResize = () => {
      const nextIsMobile = window.innerWidth <= 780
      setIsMobileViewport(nextIsMobile)
      if (!nextIsMobile) {
        setMobileSidePanelOpen(false)
      }
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
    if (typeof document === 'undefined') {
      return
    }

    const { body, documentElement } = document
    if (showMobileCodexComposer) {
      body.classList.add('mobile-codex-body')
      documentElement.classList.add('mobile-codex-html')
      return () => {
        body.classList.remove('mobile-codex-body')
        documentElement.classList.remove('mobile-codex-html')
      }
    }

    body.classList.remove('mobile-codex-body')
    documentElement.classList.remove('mobile-codex-html')
    return undefined
  }, [showMobileCodexComposer])

  return (
    <div className={`app workspace-page ${showMobileCodexComposer ? 'workspace-page-has-mobile-composer' : ''}`}>
      <div className="app-aura app-aura-brand" />
      <div className="app-aura app-aura-signal" />
      <WorkspaceTopbar
        codexLoading={codexLoading}
        codexResumeLoading={codexResumeLoading}
        connected={connected}
        codexBusy={codexBusy}
        isMobileViewport={isMobileViewport}
        mobileSidePanelOpen={mobileSidePanelOpen}
        onLeaveSessionView={onLeaveSessionView}
        onOpenPrimarySession={onOpenPrimarySession}
        onResumeCodexSession={onResumeCodexSession}
        onToggleMobileSidePanel={() => setMobileSidePanelOpen((value) => !value)}
        selectedProject={selectedProject}
        sidePanelTab={sidePanelProps.sidePanelTab}
        step={step}
      />

      <WorkspaceShell
        isMobileViewport={isMobileViewport}
        mobileSidePanelOpen={mobileSidePanelOpen}
        onCloseMobileSidePanel={() => setMobileSidePanelOpen(false)}
        onResetSidebarWidth={onResetSidebarWidth || (() => DEFAULT_SIDEBAR_WIDTH)}
        onStartSidebarResize={startSidebarResize}
        sidebarResizing={sidebarResizing}
        sidePanelProps={{
          ...sidePanelProps,
          mobileActionProps: {
            canResumeCodex: selectedProject?.runtime === 'codex',
            codexLoading,
            codexResumeLoading,
            onOpenPrimarySession,
            onResumeCodexSession,
            step,
          },
        }}
        terminalPanelProps={terminalPanelProps}
        workspaceShellRef={workspaceShellRef}
        workspaceShellStyle={workspaceShellStyle}
      />
      {showMobileCodexComposer ? (
        <MobileCodexComposer
          connected={connected}
          codexTimelineUpdatedAtMs={terminalPanelProps?.codexTimeline?.updatedAtMs}
          onRefreshCodexTimeline={terminalPanelProps?.onRefreshCodexTimeline}
          onSendSessionInput={terminalPanelProps?.onSendSessionInput}
          sessionId={terminalPanelProps?.sessionId}
        />
      ) : null}
      <SessionCloseModal {...sessionCloseModalProps} />
    </div>
  )
}
