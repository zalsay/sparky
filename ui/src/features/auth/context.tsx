import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { WebApiError, registerWebApiAuth } from '../../services/webApi';
import { authService } from './service';
import { clearAuthSession, readAuthSession, writeAuthSession } from './storage';
import type { AuthResponse, AuthUser, LoginPayload, RefreshResponse, RegisterPayload, StoredAuthSession } from './types';

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  initialized: boolean;
  isAuthenticated: boolean;
  login: (payload: LoginPayload) => Promise<AuthUser>;
  register: (payload: RegisterPayload) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refreshAccessToken: () => Promise<string | null>;
  validateSession: () => Promise<AuthUser | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function toExpiresAt(expiresIn: number | null | undefined) {
  if (!expiresIn || !Number.isFinite(expiresIn)) {
    return null;
  }
  return Date.now() + expiresIn * 1000;
}

function applyAuthResponse(response: AuthResponse): StoredAuthSession {
  return {
    user: response.user,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: toExpiresAt(response.expires_in),
  };
}

function applyRefreshResponse(session: StoredAuthSession, response: RefreshResponse): StoredAuthSession {
  return {
    ...session,
    accessToken: response.access_token,
    expiresAt: toExpiresAt(response.expires_in),
  };
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<StoredAuthSession | null>(() => readAuthSession());
  const [initialized, setInitialized] = useState(false);
  const refreshPromiseRef = useRef<Promise<string | null> | null>(null);
  const sessionRef = useRef<StoredAuthSession | null>(session);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const persistSession = useCallback((nextSession: StoredAuthSession | null) => {
    setSession(nextSession);
    sessionRef.current = nextSession;
    if (nextSession) {
      writeAuthSession(nextSession);
    } else {
      clearAuthSession();
    }
  }, []);

  const refreshAccessToken = useCallback(async () => {
    const current = sessionRef.current;
    if (!current?.refreshToken) {
      persistSession(null);
      return null;
    }

    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const refreshed = await authService.refresh(current.refreshToken);
        const nextSession = applyRefreshResponse(current, refreshed);
        persistSession(nextSession);
        return nextSession.accessToken;
      } catch {
        persistSession(null);
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, [persistSession]);

  useEffect(() => {
    registerWebApiAuth({
      getAccessToken: () => sessionRef.current?.accessToken || '',
      refreshAccessToken,
      clearSession: () => persistSession(null),
    });

    return () => registerWebApiAuth(null);
  }, [persistSession, refreshAccessToken]);

  const validateSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current?.accessToken) {
      persistSession(null);
      return null;
    }

    try {
      const user = await authService.getMe();
      persistSession({ ...current, user });
      return user;
    } catch (error) {
      if (!(error instanceof WebApiError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }

      const refreshedToken = await refreshAccessToken();
      if (!refreshedToken) {
        return null;
      }
      try {
        const user = await authService.getMe();
        const refreshedSession = sessionRef.current;
        if (refreshedSession) {
          persistSession({ ...refreshedSession, user });
        }
        return user;
      } catch {
        persistSession(null);
        return null;
      }
    }
  }, [persistSession, refreshAccessToken]);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      const current = sessionRef.current;
      if (!current?.accessToken) {
        if (!cancelled) {
          setInitialized(true);
        }
        return;
      }

      try {
        await validateSession();
      } catch {
        // leave the current session in place for transient network failures
      } finally {
        if (!cancelled) {
          setInitialized(true);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [validateSession]);

  const handleAuthSuccess = useCallback(async (response: AuthResponse) => {
    const nextSession = applyAuthResponse(response);
    persistSession(nextSession);

    try {
      const user = await authService.getMe();
      persistSession({ ...nextSession, user });
      return user;
    } catch {
      return response.user;
    }
  }, [persistSession]);

  const login = useCallback(async (payload: LoginPayload) => {
    const response = await authService.login(payload);
    return handleAuthSuccess(response);
  }, [handleAuthSuccess]);

  const register = useCallback(async (payload: RegisterPayload) => {
    const response = await authService.register(payload);
    return handleAuthSuccess(response);
  }, [handleAuthSuccess]);

  const logout = useCallback(async () => {
    const current = sessionRef.current;
    try {
      if (current?.refreshToken) {
        await authService.logout(current.refreshToken);
      }
    } catch {
      // ignore logout errors and clear local session anyway
    } finally {
      persistSession(null);
    }
  }, [persistSession]);

  const value = useMemo<AuthContextValue>(() => ({
    user: session?.user ?? null,
    accessToken: session?.accessToken ?? '',
    refreshToken: session?.refreshToken ?? '',
    expiresAt: session?.expiresAt ?? null,
    initialized,
    isAuthenticated: Boolean(session?.accessToken),
    login,
    register,
    logout,
    refreshAccessToken,
    validateSession,
  }), [initialized, login, logout, refreshAccessToken, register, session, validateSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
