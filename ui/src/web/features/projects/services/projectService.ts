import { WebApiError, webApi } from '../../../../services/webApi';
import type {
  HookRecordsResponse,
  Project,
  ProjectDetailResponse,
  SessionInfo,
  TerminalHistoryEntry,
  WebIdeSummaryResponse,
} from '../../../types';

function normalizeProject(project: Project): Project {
  return {
    ...project,
    hooks_installed: project.hooks_installed ?? project.hooks_enabled ?? false,
    hooks_enabled: project.hooks_enabled ?? project.hooks_installed ?? false,
  };
}

export async function fetchProjects() {
  const result = await webApi.listProjects<Project[]>();
  return (result || []).map(normalizeProject);
}

export async function createProject(payload: { name: string; path: string }) {
  const project = await webApi.createProject<Project>(payload);
  return normalizeProject(project);
}

export async function deleteProject(id: number) {
  return webApi.deleteProject(id);
}

export async function fetchProjectDetailWeb(projectId: number) {
  const detail = await webApi.getProjectDetail<ProjectDetailResponse>(projectId);
  return {
    ...detail,
    project: detail?.project ? normalizeProject(detail.project) : detail?.project,
  };
}

export async function fetchSessionsWeb(projectId: number) {
  return webApi.listSessions<SessionInfo[]>(projectId);
}

export async function fetchTerminalHistoryWeb(projectId: number) {
  return webApi.getTerminalHistory<TerminalHistoryEntry[]>(projectId);
}

export async function executeTerminalWeb(payload: { projectId?: number; sessionId?: string; command: string }) {
  return webApi.execTerminal<{ stdout?: string; stderr?: string; exit_code?: number }>({
    ...(payload.projectId !== undefined ? { project_id: payload.projectId } : {}),
    ...(payload.sessionId ? { session_id: payload.sessionId } : {}),
    command: payload.command,
  });
}

export async function renameSessionWeb(projectId: number, sessionId: string, name: string) {
  return webApi.renameSession(sessionId, { project_id: projectId, name });
}

export async function deleteSessionWeb(projectId: number, sessionId: string) {
  return webApi.deleteSession(sessionId, { project_id: projectId });
}

export async function resumeSessionWeb(projectId: number, sessionId: string) {
  return webApi.resumeSession<{ session_id?: string; status?: string }>(sessionId, { project_id: projectId });
}

export async function fetchHookRecords(projectId: number, page: number, pageSize: number) {
  return webApi.listHookRecords<HookRecordsResponse>(projectId, page, pageSize);
}

export async function fetchWebIdeSummary() {
  return webApi.getWebIdeSummary<WebIdeSummaryResponse>();
}

export function isUnauthorizedWebError(error: unknown) {
  if (!(error instanceof WebApiError)) {
    return false;
  }
  return error.status === 401 || error.status === 403;
}
