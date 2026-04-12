import { useEffect, useMemo, useRef } from 'react'
import { formatClockTime } from '../app/data'

const EXPAND_CHAR_LIMIT = 220
const EXPAND_LINE_LIMIT = 8

function itemClassName(kind) {
  switch (kind) {
    case 'user':
      return 'codex-conversation-item codex-conversation-item-user'
    case 'assistant':
      return 'codex-conversation-item codex-conversation-item-assistant'
    case 'tool_call':
      return 'codex-conversation-item codex-conversation-item-tool'
    case 'tool_result':
      return 'codex-conversation-item codex-conversation-item-result'
    case 'reasoning':
      return 'codex-conversation-item codex-conversation-item-reasoning'
    case 'commentary':
      return 'codex-conversation-item codex-conversation-item-commentary'
    case 'error':
      return 'codex-conversation-item codex-conversation-item-error'
    default:
      return 'codex-conversation-item codex-conversation-item-status'
  }
}

function itemLabel(kind) {
  switch (kind) {
    case 'user':
      return '你'
    case 'assistant':
      return 'Codex'
    case 'tool_call':
      return '工具调用'
    case 'tool_result':
      return '工具结果'
    case 'reasoning':
      return '思考'
    case 'commentary':
      return '进度'
    case 'error':
      return '错误'
    default:
      return '状态'
  }
}

function itemDisplayLabel(item) {
  if (item.kind === 'user') {
    return '你'
  }

  if (item.kind === 'assistant') {
    return 'Codex'
  }

  return item.title || itemLabel(item.kind)
}

function isExpandable(kind, text) {
  if (!['user', 'assistant', 'commentary', 'tool_call', 'tool_result', 'reasoning'].includes(kind)) {
    return false
  }

  const value = String(text || '').trim()
  if (!value) {
    return false
  }

  return value.length > EXPAND_CHAR_LIMIT || value.split('\n').length > EXPAND_LINE_LIMIT
}

function previewText(text) {
  const value = String(text || '').trim()
  if (!value) {
    return ''
  }

  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean)
  const preview = (lines[0] || value).slice(0, EXPAND_CHAR_LIMIT)
  return preview.length < value.length ? `${preview}...` : preview
}

function isPreformattedKind(kind) {
  return kind === 'tool_call' || kind === 'tool_result'
}

function isResolvedTransitionItem(item) {
  if (!item) {
    return false
  }

  if (item.kind === 'reasoning') {
    return true
  }

  if (item.kind === 'commentary') {
    return true
  }

  if (item.kind !== 'status') {
    return false
  }

  return item.title === '任务开始' || String(item.text || '').includes('Codex 已开始处理当前请求')
}

function buildDisplayItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return []
  }

  return items.filter((item, index) => {
    if (!isResolvedTransitionItem(item)) {
      return true
    }

    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const nextItem = items[cursor]
      if (nextItem.kind === 'assistant') {
        return false
      }

      if (nextItem.kind === 'status' && nextItem.title === '任务开始') {
        return true
      }
    }

    return true
  })
}

function renderItemBody(item) {
  const asPre = isPreformattedKind(item.kind)

  if (isExpandable(item.kind, item.text)) {
    return (
      <details className="codex-conversation-details">
        <summary>{previewText(item.text)}</summary>
        {asPre ? (
          <pre className="codex-conversation-pre">{item.text}</pre>
        ) : (
          <div className="codex-conversation-text">{item.text}</div>
        )}
      </details>
    )
  }

  if (asPre) {
    return <pre className="codex-conversation-pre">{item.text}</pre>
  }

  return <div className="codex-conversation-text">{item.text}</div>
}

export function CodexConversationPanel({
  codexTimeline,
  codexTimelineError,
  codexTimelineLoading,
  sessionId,
  scrollToBottomRequest,
}) {
  const scrollRef = useRef(null)
  const autoScrollAttemptsRef = useRef(0)
  const autoScrollTimerRef = useRef(null)
  const items = useMemo(() => buildDisplayItems(codexTimeline?.items || []), [codexTimeline?.items])

  const clearAutoScrollTimer = () => {
    if (autoScrollTimerRef.current) {
      window.clearTimeout(autoScrollTimerRef.current)
      autoScrollTimerRef.current = null
    }
  }

  const forceScrollToBottom = () => {
    const node = scrollRef.current
    if (!node) {
      return
    }

    node.scrollTop = node.scrollHeight
  }

  const scheduleAutoScroll = () => {
    clearAutoScrollTimer()
    if (autoScrollAttemptsRef.current <= 0) {
      return
    }

    autoScrollTimerRef.current = window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        forceScrollToBottom()
      })
      autoScrollAttemptsRef.current -= 1
      scheduleAutoScroll()
    }, 120)
  }

  useEffect(() => {
    autoScrollAttemptsRef.current = 10
    window.requestAnimationFrame(() => {
      forceScrollToBottom()
    })
    scheduleAutoScroll()

    return () => {
      clearAutoScrollTimer()
    }
  }, [sessionId])

  useEffect(() => {
    if (!autoScrollAttemptsRef.current || codexTimelineLoading) {
      return
    }

    window.requestAnimationFrame(() => {
      forceScrollToBottom()
    })
  }, [sessionId, items.length, codexTimelineLoading])

  useEffect(() => () => {
    clearAutoScrollTimer()
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) {
      return
    }

    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    if (nearBottom) {
      node.scrollTop = node.scrollHeight
    }
  }, [items.length, codexTimelineLoading])

  useEffect(() => {
    if (!scrollToBottomRequest) {
      return
    }

    const node = scrollRef.current
    if (!node) {
      return
    }

    node.scrollTo({
      top: node.scrollHeight,
      behavior: 'smooth',
    })
  }, [scrollToBottomRequest])

  return (
    <section className="codex-conversation">
      <div ref={scrollRef} className="codex-conversation-scroll">
        {codexTimelineLoading ? (
          <div className="codex-conversation-state">正在读取 Codex 时间线...</div>
        ) : codexTimelineError ? (
          <div className="codex-conversation-state codex-conversation-state-error">{codexTimelineError}</div>
        ) : items.length === 0 ? (
          <div className="codex-conversation-state">当前会话还没有可展示的结构化输出。</div>
        ) : (
          <div className="codex-conversation-list">
            {items.map((item) => (
              <article key={item.id} className={itemClassName(item.kind)}>
                <div className="codex-conversation-item-head">
                  <span className="codex-conversation-item-label">{itemDisplayLabel(item)}</span>
                  <span className="codex-conversation-item-time">{formatClockTime(item.timestamp)}</span>
                </div>
                {renderItemBody(item)}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
