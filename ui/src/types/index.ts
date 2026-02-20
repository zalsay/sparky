// Message types for WebSocket communication

export type MessageType = 
  | 'command' 
  | 'log' 
  | 'status' 
  | 'permission_request' 
  | 'permission_response'
  | 'chat_log_stream';

export type Sender = 'web_ui' | 'tauri_worker' | 'orchestrator';

export interface MessagePayload {
  sender: Sender;
  task_id: string;
  type: MessageType;
  action?: string;
  data: Record<string, unknown>;
}

// Chat message for UI
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  stepId?: string;
  isStreaming?: boolean;
}

// Permission request for action cards
export interface PermissionRequest {
  request_id: string;
  hook_type: string;
  raw_command: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected';
}

// Connection status
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
