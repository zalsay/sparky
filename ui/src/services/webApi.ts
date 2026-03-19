export class WebApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WebApiError';
    this.status = status;
  }
}

export interface SseMessage {
  event: string;
  data: string;
}

type AuthMode = 'required' | 'optional' | 'none';

interface RequestOptions {
  authMode?: AuthMode;
  retryOnUnauthorized?: boolean;
  accessToken?: string;
}

interface WebApiAuthAdapter {
  getAccessToken: () => string;
  refreshAccessToken: () => Promise<string | null>;
  clearSession: () => void;
}

const API_BASE_URL = import.meta.env.VITE_WEB_API_BASE_URL?.trim() || 'https://i.meetlife.com.cn:3010';

let authAdapter: WebApiAuthAdapter | null = null;

export function registerWebApiAuth(adapter: WebApiAuthAdapter | null) {
  authAdapter = adapter;
}

export function resolvePath(path: string) {
  if (!API_BASE_URL) {
    return path;
  }
  return `${API_BASE_URL.replace(/\/$/, '')}${path}`;
}

function buildHeaders(
  accessToken?: string,
  includeJsonContentType = false,
  headers?: HeadersInit,
  authMode: AuthMode = 'required',
): HeadersInit {
  return {
    ...(authMode !== 'none' && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(includeJsonContentType ? { 'content-type': 'application/json' } : {}),
    ...(headers || {}),
  };
}

async function parseError(response: Response): Promise<WebApiError> {
  const text = await response.text();
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      const message = parsed.error || parsed.message;
      if (message) {
        return new WebApiError(response.status, message);
      }
    } catch {
      // ignore invalid json errors
    }
  }
  return new WebApiError(response.status, text || response.statusText || 'Request failed');
}

async function fetchWithAuth(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<Response> {
  const {
    authMode = 'required',
    retryOnUnauthorized = true,
    accessToken: explicitAccessToken,
  } = options;
  const hasBody = init?.body !== undefined && init?.body !== null;

  const execute = async (accessToken?: string) => fetch(resolvePath(path), {
    ...init,
    headers: buildHeaders(accessToken, hasBody, init?.headers, authMode),
  });

  const initialAccessToken = explicitAccessToken ?? authAdapter?.getAccessToken() ?? '';
  if (authMode === 'required' && !initialAccessToken) {
    throw new WebApiError(401, 'Missing auth token');
  }

  let response = await execute(initialAccessToken || undefined);
  if (response.status !== 401 || authMode !== 'required' || !retryOnUnauthorized || explicitAccessToken) {
    return response;
  }

  const refreshedAccessToken = await authAdapter?.refreshAccessToken();
  if (!refreshedAccessToken) {
    authAdapter?.clearSession();
    return response;
  }

  response = await execute(refreshedAccessToken);
  if (response.status === 401) {
    authAdapter?.clearSession();
  }
  return response;
}

async function requestJson<T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> {
  const response = await fetchWithAuth(path, init, options);

  if (!response.ok) {
    throw await parseError(response);
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function requestVoid(path: string, init?: RequestInit, options?: RequestOptions): Promise<void> {
  const response = await fetchWithAuth(path, init, options);

  if (!response.ok) {
    throw await parseError(response);
  }
}

export async function streamSse(
  path: string,
  signal: AbortSignal,
  onMessage: (message: SseMessage) => void,
  options?: RequestOptions,
): Promise<void> {
  const response = await fetchWithAuth(path, {
    signal,
    headers: {
      accept: 'text/event-stream',
    },
  }, options);

  if (!response.ok) {
    throw await parseError(response);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let sepIndex = buffer.indexOf('\n\n');

    while (sepIndex !== -1) {
      const chunk = buffer.slice(0, sepIndex).trim();
      buffer = buffer.slice(sepIndex + 2);

      if (chunk) {
        const lines = chunk.split('\n');
        let event = 'message';
        let data = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data += line.slice(5).trim();
          }
        }

        if (data) {
          onMessage({ event, data });
        }
      }

      sepIndex = buffer.indexOf('\n\n');
    }
  }
}

export const webApi = {
  register: <T>(payload: unknown) =>
    requestJson<T>('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) }, { authMode: 'none' }),
  login: <T>(payload: unknown) =>
    requestJson<T>('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }, { authMode: 'none' }),
  refresh: <T>(payload: unknown) =>
    requestJson<T>('/api/auth/refresh', { method: 'POST', body: JSON.stringify(payload) }, { authMode: 'none', retryOnUnauthorized: false }),
  logout: <T>(payload: unknown) =>
    requestJson<T>('/api/auth/logout', { method: 'POST', body: JSON.stringify(payload) }, { authMode: 'none', retryOnUnauthorized: false }),
  getMe: <T>() => requestJson<T>('/api/me'),
  listProjects: <T>() => requestJson<T>('/api/projects'),
  createProject: <T>(payload: { name: string; path: string }) =>
    requestJson<T>('/api/projects', { method: 'POST', body: JSON.stringify(payload) }),
  deleteProject: (id: number) =>
    requestVoid(`/api/projects/${id}`, { method: 'DELETE' }),
  getProjectDetail: <T>(projectId: number) =>
    requestJson<T>(`/api/projects/${projectId}/detail`),
  listSessions: <T>(projectId: number) =>
    requestJson<T>(`/api/sessions?project_id=${projectId}`),
  getTerminalHistory: <T>(projectId: number, page = 1, pageSize = 100) =>
    requestJson<T>(`/api/terminal/history?project_id=${projectId}&page=${page}&page_size=${pageSize}`),
  execTerminal: <T>(payload: { project_id?: number | string; session_id?: string; command: string }) =>
    requestJson<T>('/api/terminal/exec', { method: 'POST', body: JSON.stringify(payload) }),
  getConfig: <T>() => requestJson<T>('/api/config'),
  saveConfig: (config: unknown) =>
    requestVoid('/api/config', { method: 'POST', body: JSON.stringify(config) }),
  listProviders: <T>() => requestJson<T>('/api/providers'),
  saveProvider: <T>(provider: unknown) =>
    requestJson<T>('/api/providers', { method: 'POST', body: JSON.stringify(provider) }),
  deleteProvider: (idOrAppType: string, maybeId?: string) => {
    const path = maybeId
      ? `/api/providers/${encodeURIComponent(idOrAppType)}/${encodeURIComponent(maybeId)}`
      : `/api/providers/${encodeURIComponent(idOrAppType)}`;
    return requestVoid(path, { method: 'DELETE' });
  },
  listHookRecords: <T>(projectId: number, page: number, pageSize: number) =>
    requestJson<T>(`/api/hooks?project_id=${projectId}&page=${page}&page_size=${pageSize}`),
  deleteHookRecord: (projectId: number, id: number) =>
    requestVoid(`/api/hooks/${id}?project_id=${projectId}`, { method: 'DELETE' }),
  deleteHookRecords: (payload: { project_id: string | number; ids: Array<number | string> }) =>
    requestVoid('/api/hooks/batch-delete', { method: 'POST', body: JSON.stringify(payload) }),
  getWebIdeSummary: <T>() => requestJson<T>('/api/web-ide/summary'),
  renameSession: (sessionId: string, payload: { project_id?: string | number; name: string }) =>
    requestVoid(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, { method: 'POST', body: JSON.stringify(payload) }),
  deleteSession: (sessionId: string, payload: { project_id?: string | number }) =>
    requestVoid(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, { method: 'POST', body: JSON.stringify(payload) }),
  resumeSession: <T>(sessionId: string, payload: { project_id?: string | number }) =>
    requestJson<T>(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST', body: JSON.stringify(payload) }),
};
