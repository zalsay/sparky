import type { StoredAuthSession } from './types';

export const AUTH_SESSION_STORAGE_KEY = 'sparky-auth-session';
export const LEGACY_WEB_ACCESS_TOKEN_STORAGE_KEY = 'sparky-web-access-token';
export const LEGACY_WEB_API_KEY_STORAGE_KEY = 'sparky-web-api-key';

function readLegacyAccessToken() {
  try {
    return localStorage.getItem(LEGACY_WEB_ACCESS_TOKEN_STORAGE_KEY) || localStorage.getItem(LEGACY_WEB_API_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function normalizeStoredSession(value: unknown): StoredAuthSession | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  if (!candidate.accessToken || typeof candidate.accessToken !== 'string') {
    return null;
  }

  return {
    user: candidate.user ?? null,
    accessToken: candidate.accessToken,
    refreshToken: typeof candidate.refreshToken === 'string' ? candidate.refreshToken : '',
    expiresAt: typeof candidate.expiresAt === 'number' ? candidate.expiresAt : null,
  };
}

export function readAuthSession(): StoredAuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
    if (raw) {
      const parsed = normalizeStoredSession(JSON.parse(raw));
      if (parsed) {
        return parsed;
      }
    }
  } catch {
    // ignore storage errors
  }

  const legacyToken = readLegacyAccessToken();
  if (!legacyToken) {
    return null;
  }

  return {
    user: null,
    accessToken: legacyToken,
    refreshToken: '',
    expiresAt: null,
  };
}

export function writeAuthSession(session: StoredAuthSession) {
  try {
    localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
    localStorage.removeItem(LEGACY_WEB_ACCESS_TOKEN_STORAGE_KEY);
    localStorage.removeItem(LEGACY_WEB_API_KEY_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function clearAuthSession() {
  try {
    localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    localStorage.removeItem(LEGACY_WEB_ACCESS_TOKEN_STORAGE_KEY);
    localStorage.removeItem(LEGACY_WEB_API_KEY_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}
