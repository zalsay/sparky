import { useEffect, useRef, useState } from 'react'
import { SessionCloseModal } from './SessionCloseModal'
import { DEFAULT_SIDEBAR_WIDTH } from '../app/constants'
import { logSessionDebug, summarizeContentPreview } from '../app/sessionDebug'
import { WorkspaceShell } from './WorkspaceShell'
import { WorkspaceTopbar } from './WorkspaceTopbar'

const APP_TITLE = 'Sparky'
const CODEX_COMPLETION_FLASH_MS = 1000

function MobileCodexComposer({
  connected,
  codexTimelineUpdatedAtMs,
  onRefreshCodexTimeline,
  onSendSessionInput,
  sessionId,
}) {
  const inputRef = useRef(null)
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
    <form
      className="mobile-codex-composer"
      onSubmit={(event) => {
        event.preventDefault()
        sendInput()
      }}
    >
      <textarea
        ref={inputRef}
        className="mobile-codex-composer__input"
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            sendInput()
          }
        }}
        enterKeyHint="send"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={connected ? '向 Codex 发送消息' : '正在连接 Codex…'}
        disabled={!sessionId || !connected}
        aria-label="向 Codex 发送消息"
      />
      <button
        type="submit"
        className="mobile-codex-composer__send"
        disabled={!sessionId || !connected || !value.trim() || sendCoolingDown}
        aria-label={sendCoolingDown ? '发送中' : '发送'}
      >
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M10 15.5v-11M5.5 9l4.5-4.5L14.5 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </form>
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
  const previousCodexBusyRef = useRef(false)
  const lastCodexCompletionAtRef = useRef(0)
  const codexCompletionAlertRef = useRef(false)
  const codexCompletionFlashRef = useRef(true)
  const codexCompletionTimerRef = useRef(null)
  const codexTimelineItems = Array.isArray(terminalPanelProps?.codexTimeline?.items)
    ? terminalPanelProps.codexTimeline.items
    : []
  const latestCodexItem = codexTimelineItems[codexTimelineItems.length - 1] || null
  const codexTimelineUpdatedAtMs = Number(terminalPanelProps?.codexTimeline?.updatedAtMs || 0)
  const currentSessionId = terminalPanelProps?.sessionId || ''
  const codexBusyKinds = new Set(['reasoning', 'tool_call', 'tool_result', 'commentary', 'status'])
  const codexBusy = selectedProject?.runtime === 'codex' && (
    codexLoading
    || codexResumeLoading !== ''
    || terminalPanelProps?.codexTimelineLoading
    || step === 'connecting'
    || (connected && latestCodexItem && codexBusyKinds.has(latestCodexItem.kind))
  )
  const showMobileCodexComposer = isMobileViewport && selectedProject?.runtime === 'codex'
  const baseTitle = selectedProject?.name ? `${selectedProject.name} · ${APP_TITLE}` : APP_TITLE
  const updateDocumentTitle = () => {
    if (typeof document === 'undefined') {
      return
    }

    if (codexCompletionAlertRef.current) {
      document.title = codexCompletionFlashRef.current
        ? `Codex 已完成 · ${baseTitle}`
        : `● ${baseTitle}`
      return
    }

    document.title = baseTitle
  }

  const clearCodexCompletionTimer = () => {
    if (codexCompletionTimerRef.current) {
      window.clearInterval(codexCompletionTimerRef.current)
      codexCompletionTimerRef.current = null
    }
  }

  const clearCodexCompletionAlert = () => {
    codexCompletionAlertRef.current = false
    codexCompletionFlashRef.current = true
    clearCodexCompletionTimer()
    updateDocumentTitle()
  }

  const triggerCodexCompletionAlert = () => {
    codexCompletionAlertRef.current = true
    codexCompletionFlashRef.current = true
    clearCodexCompletionTimer()
    updateDocumentTitle()
    codexCompletionTimerRef.current = window.setInterval(() => {
      codexCompletionFlashRef.current = !codexCompletionFlashRef.current
      updateDocumentTitle()
    }, CODEX_COMPLETION_FLASH_MS)
  }

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

  useEffect(() => {
    clearCodexCompletionAlert()
    previousCodexBusyRef.current = codexBusy
    lastCodexCompletionAtRef.current = codexTimelineUpdatedAtMs
  }, [currentSessionId, selectedProject?.id])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined
    }

    const clearAlertIfForeground = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        clearCodexCompletionAlert()
      }
    }

    document.addEventListener('visibilitychange', clearAlertIfForeground)
    window.addEventListener('focus', clearAlertIfForeground)
    window.addEventListener('pageshow', clearAlertIfForeground)

    return () => {
      document.removeEventListener('visibilitychange', clearAlertIfForeground)
      window.removeEventListener('focus', clearAlertIfForeground)
      window.removeEventListener('pageshow', clearAlertIfForeground)
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') {
      previousCodexBusyRef.current = codexBusy
      return
    }

    const completionDetected = (
      previousCodexBusyRef.current
      && !codexBusy
      && selectedProject?.runtime === 'codex'
      && connected
      && latestCodexItem?.kind === 'assistant'
      && codexTimelineUpdatedAtMs > lastCodexCompletionAtRef.current
    )

    if (completionDetected) {
      const backgrounded = document.visibilityState !== 'visible' || !document.hasFocus()
      if (backgrounded) {
        triggerCodexCompletionAlert()
      }
      lastCodexCompletionAtRef.current = codexTimelineUpdatedAtMs
    }

    if (codexBusy) {
      clearCodexCompletionAlert()
    }

    previousCodexBusyRef.current = codexBusy
  }, [codexBusy, codexTimelineUpdatedAtMs, connected, latestCodexItem?.kind, selectedProject?.runtime])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined
    }

    updateDocumentTitle()

    return () => {
      clearCodexCompletionTimer()
      document.title = APP_TITLE
    }
  }, [baseTitle])

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
        mobileSessionActions={{
          currentSessionTemporary: terminalPanelProps?.currentSessionTemporary,
          onDestroyCurrentSession: terminalPanelProps?.onDestroyCurrentSession,
          onOpenRawTerminal: () => window.dispatchEvent(new Event('sparky:open-mobile-raw-terminal')),
          onOpenTemporarySession: terminalPanelProps?.onOpenTemporarySession,
          onRefreshTimeline: terminalPanelProps?.onRefreshCodexTimeline,
          onScrollToBottom: () => window.dispatchEvent(new Event('sparky:scroll-mobile-session-bottom')),
          sessionId: terminalPanelProps?.sessionId,
        }}
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
