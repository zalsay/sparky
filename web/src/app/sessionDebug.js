const DEBUG_WINDOW_KEY = '__sparkySessionDebug'
const MAX_DEBUG_EVENTS = 400

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

export function describeContent(value) {
  const text = String(value || '')

  return {
    length: text.length,
    preview: summarizeContentPreview(text, 40),
    codes: Array.from(text).map((char) => char.codePointAt(0)),
  }
}

export function summarizeContentPreview(value, maxLength = 120) {
  const normalized = normalizeText(value)
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength)}...`
}

export function socketReadyStateLabel(readyState) {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING'
    case WebSocket.OPEN:
      return 'OPEN'
    case WebSocket.CLOSING:
      return 'CLOSING'
    case WebSocket.CLOSED:
      return 'CLOSED'
    default:
      return `UNKNOWN(${String(readyState)})`
  }
}

function ensureDebugStore() {
  if (typeof window === 'undefined') {
    return null
  }

  if (!window[DEBUG_WINDOW_KEY]) {
    const store = {
      events: [],
      clear() {
        store.events = []
      },
      recent(limit = 50) {
        return store.events.slice(-limit)
      },
      dump() {
        return JSON.stringify(store.events, null, 2)
      },
    }
    window[DEBUG_WINDOW_KEY] = store
  }

  return window[DEBUG_WINDOW_KEY]
}

export function logSessionDebug(kind, details = {}) {
  if (typeof window === 'undefined') {
    return
  }

  const store = ensureDebugStore()
  if (!store) {
    return
  }

  const entry = {
    ts: new Date().toISOString(),
    kind,
    ...details,
  }

  const nextEvents = store.events.concat(entry)
  store.events = nextEvents.length > MAX_DEBUG_EVENTS
    ? nextEvents.slice(nextEvents.length - MAX_DEBUG_EVENTS)
    : nextEvents

  console.debug(`[sparky][session] ${kind}`, entry)
}
