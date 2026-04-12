export const BRAND_LOGO_SRC = '/logo.png'
export const API_BASE = import.meta.env.VITE_API_BASE || `${window.location.protocol}//${window.location.host}`
export const WS_BASE = import.meta.env.VITE_WS_BASE || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
export const AUTH_STORAGE_KEY = 'sparky-auth'
export const LEGACY_AUTH_STORAGE_KEY = 'cc-bridge-auth'
export const PROJECT_STORAGE_KEY = 'sparky-last-project'
export const LEGACY_PROJECT_STORAGE_KEY = 'cc-bridge-last-project'
export const KEEPALIVE_INTERVAL_MS = 15000
export const WS_CONNECT_TIMEOUT_MS = 8000
export const PROJECT_PATH_PREFIX = '/projects/'
export const WORKSPACE_SIDEBAR_WIDTH_KEY = 'sparky-workspace-sidebar-width'
export const DEFAULT_SIDEBAR_WIDTH = 380
export const MIN_SIDEBAR_WIDTH = 320
export const MAX_SIDEBAR_WIDTH = 760
export const MIN_TERMINAL_WIDTH = 480

export const PROJECT_PRESETS = {
  default: {
    displayName: 'Claude',
    provider: 'Anthropic',
    accent: 'claude',
    order: 0,
  },
  codex: {
    displayName: 'Codex',
    provider: 'OpenAI',
    accent: 'codex',
    order: 1,
  },
}
