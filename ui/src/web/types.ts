export interface IDEPlugin {
  id: string;
  name: string;
  desc: string;
  created_at?: number | null;
}

export interface WebIdeProjectStatus {
  project_id: string;
  project_path: string;
  project_name: string;
  active_pty_count: number;
  agent_id: string;
}

export interface WebIdeSummaryResponse {
  projects: WebIdeProjectStatus[];
  active_instances?: number;
}

export interface WebIdeEvent {
  event_type: 'agent_connected' | 'agent_disconnected' | 'pty_active_changed';
  agent_id: string;
  project?: WebIdeProjectStatus;
}

export interface AppConfig {
  app_id: string;
  app_secret: string;
  app_name?: string;
  encrypt_key?: string;
  verification_token?: string;
  chat_id?: string;
  project_path?: string;
  open_id?: string;
  hook_events_filter?: string;
  anthropic_logo_img_key?: string;
  terminal_bg_color?: string;
  terminal_fg_color?: string;
  terminal_font_size?: number;
  default_provider_id?: string;
}

export interface AIProviderEndpoint {
  id?: number;
  provider_id: string;
  app_type: string;
  url: string;
  added_at?: number;
}

export interface AIProvider {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  website_url?: string;
  category?: string;
  created_at?: number;
  sort_index?: number;
  notes?: string;
  icon?: string;
  icon_color?: string;
  meta: string;
  is_current: boolean;
  in_failover_queue: boolean;
  cost_multiplier: string;
  limit_daily_usd?: string;
  limit_monthly_usd?: string;
  provider_type?: string;
  endpoints: AIProviderEndpoint[];
}

export interface Project {
  id: number;
  name: string;
  path: string;
  hooks_installed: boolean;
  agent_teams_enabled?: boolean;
  default_provider_id?: string;
}

export interface IDETab {
  id: string;
  title: string;
  url: string;
  type: 'code-server' | 'webview';
  closable?: boolean;
}

export interface HookRecord {
  id: number;
  event_name: string;
  session_id: string;
  notification_text: string;
  transcript_path: string;
  content: string;
  result: string;
  created_at: number;
}

export interface HookRecordsResponse {
  records: HookRecord[];
  total: number;
  page: number;
  page_size: number;
}

export interface SessionInfo {
  id: number | string;
  session_id: string;
  project_path: string;
  started_at: number | null;
  ended_at: number | null;
  reason: string | null;
  name: string | null;
  project_name: string | null;
}

export interface ProjectDetailResponse {
  project: Project;
  sessions: SessionInfo[];
  terminal_history: string[];
}
