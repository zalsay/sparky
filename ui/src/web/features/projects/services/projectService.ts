import { WebApiError, webApi } from '../../../../services/webApi';
import type { HookRecordsResponse, Project, ProjectDetailResponse, SessionInfo, WebIdeSummaryResponse } from '../../../types';

export async function fetchProjects(apiKey: string) {
  return webApi.listProjects<Project[]>(apiKey);
}

export async function createProject(apiKey: string, payload: { name: string; path: string }) {
  return webApi.createProject<Project>(apiKey, payload);
}

export async function deleteProject(apiKey: string, id: number) {
  return webApi.deleteProject(apiKey, id);
}

export async function fetchProjectDetailWeb(apiKey: string, projectId: number) {
  return webApi.getProjectDetail<ProjectDetailResponse>(apiKey, projectId);
}

export async function fetchSessionsWeb(apiKey: string, projectId: number) {
  return webApi.listSessions<SessionInfo[]>(apiKey, projectId);
}

export async function fetchTerminalHistoryWeb(apiKey: string, projectId: number) {
  return webApi.getTerminalHistory<string[]>(apiKey, projectId);
}

export async function executeTerminalWeb(apiKey: string, projectId: number, command: string) {
  return webApi.execTerminal(apiKey, { project_id: projectId, command });
}

export async function renameSessionWeb(apiKey: string, projectId: number, sessionId: string, name: string) {
  return webApi.renameSession(apiKey, sessionId, { project_id: String(projectId), name });
}

export async function deleteSessionWeb(apiKey: string, projectId: number, sessionId: string) {
  return webApi.deleteSession(apiKey, sessionId, { project_id: String(projectId) });
}

export async function resumeSessionWeb(apiKey: string, projectId: number, sessionId: string) {
  return webApi.resumeSession(apiKey, sessionId, { project_id: String(projectId) });
}

export async function fetchHookRecords(apiKey: string, projectId: number, page: number, pageSize: number) {
  return webApi.listHookRecords<HookRecordsResponse>(apiKey, projectId, page, pageSize);
}

export async function fetchWebIdeSummary(apiKey: string) {
  return webApi.getWebIdeSummary<WebIdeSummaryResponse>(apiKey);
}

export function isUnauthorizedWebError(error: unknown) {
  if (!(error instanceof WebApiError)) {
    return false;
  }
  return error.status === 401 || error.status === 403;
}
