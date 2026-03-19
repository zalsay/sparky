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

const API_BASE_URL = import.meta.env.VITE_WEB_API_BASE_URL?.trim() || 'https://i.meetlife.com.cn:3010';

function resolvePath(path: string) {
  if (!API_BASE_URL) {
    return path;
  }
  return `${API_BASE_URL.replace(/\/$/, '')}${path}`;
}

function buildHeaders(apiKey: string, includeJsonContentType = false, headers?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
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

async function requestJson<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const response = await fetch(resolvePath(path), {
    ...init,
    headers: buildHeaders(apiKey, hasBody, init?.headers),
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function requestVoid(path: string, apiKey: string, init?: RequestInit): Promise<void> {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const response = await fetch(resolvePath(path), {
    ...init,
    headers: buildHeaders(apiKey, hasBody, init?.headers),
  });

  if (!response.ok) {
    throw await parseError(response);
  }
}

export async function streamSse(
  path: string,
  apiKey: string,
  signal: AbortSignal,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const response = await fetch(resolvePath(path), {
    headers: buildHeaders(apiKey),
    signal,
  });

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
  listProjects: <T>(apiKey: string) => requestJson<T>('/api/projects', apiKey),
  createProject: <T>(apiKey: string, payload: { name: string; path: string }) =>
    requestJson<T>('/api/projects', apiKey, { method: 'POST', body: JSON.stringify(payload) }),
  deleteProject: (apiKey: string, id: number) =>
    requestVoid(`/api/projects/${id}`, apiKey, { method: 'DELETE' }),
  getProjectDetail: <T>(apiKey: string, projectId: number) =>
    requestJson<T>(`/api/projects/${projectId}/detail`, apiKey),
  listSessions: <T>(apiKey: string, projectId: number) =>
    requestJson<T>(`/api/sessions?project_id=${projectId}`, apiKey),
  getTerminalHistory: <T>(apiKey: string, projectId: number) =>
    requestJson<T>(`/api/terminal/history?project_id=${projectId}`, apiKey),
  execTerminal: (apiKey: string, payload: { project_id: number; command: string }) =>
    requestVoid('/api/terminal/exec', apiKey, { method: 'POST', body: JSON.stringify(payload) }),
  getConfig: <T>(apiKey: string) => requestJson<T>('/api/config', apiKey),
  saveConfig: (apiKey: string, config: unknown) =>
    requestVoid('/api/config', apiKey, { method: 'POST', body: JSON.stringify(config) }),
  listProviders: <T>(apiKey: string) => requestJson<T>('/api/providers', apiKey),
  saveProvider: <T>(apiKey: string, provider: unknown) =>
    requestJson<T>('/api/providers', apiKey, { method: 'POST', body: JSON.stringify(provider) }),
  deleteProvider: (apiKey: string, appType: string, id: string) =>
    requestVoid(`/api/providers/${encodeURIComponent(appType)}/${encodeURIComponent(id)}`, apiKey, { method: 'DELETE' }),
  listHookRecords: <T>(apiKey: string, projectId: number, page: number, pageSize: number) =>
    requestJson<T>(`/api/hooks?project_id=${projectId}&page=${page}&page_size=${pageSize}`, apiKey),
  deleteHookRecord: (apiKey: string, projectId: number, id: number) =>
    requestVoid(`/api/hooks/${id}?project_id=${projectId}`, apiKey, { method: 'DELETE' }),
  deleteHookRecords: (apiKey: string, payload: { project_id: string; ids: number[] }) =>
    requestVoid('/api/hooks/batch-delete', apiKey, { method: 'POST', body: JSON.stringify(payload) }),
  getWebIdeSummary: <T>(apiKey: string) => requestJson<T>('/api/web-ide/summary', apiKey),
  renameSession: (apiKey: string, sessionId: string, payload: { project_id: string; name: string }) =>
    requestVoid(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, apiKey, { method: 'POST', body: JSON.stringify(payload) }),
  deleteSession: (apiKey: string, sessionId: string, payload: { project_id: string }) =>
    requestVoid(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, apiKey, { method: 'POST', body: JSON.stringify(payload) }),
  resumeSession: (apiKey: string, sessionId: string, payload: { project_id: string }) =>
    requestVoid(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, apiKey, { method: 'POST', body: JSON.stringify(payload) }),
};
