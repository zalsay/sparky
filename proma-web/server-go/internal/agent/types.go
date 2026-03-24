package agent

import "time"

type RunnerStatus string

type SessionStatus string

const (
	RunnerStatusUnknown     RunnerStatus = "unknown"
	RunnerStatusHealthy     RunnerStatus = "healthy"
	RunnerStatusUnreachable RunnerStatus = "unreachable"
)

const (
	SessionStatusCreating   SessionStatus = "creating"
	SessionStatusStarting   SessionStatus = "starting"
	SessionStatusRunning    SessionStatus = "running"
	SessionStatusConnecting SessionStatus = "connecting"
	SessionStatusStopped    SessionStatus = "stopped"
	SessionStatusClosing    SessionStatus = "closing"
	SessionStatusRestarting SessionStatus = "restarting"
	SessionStatusError      SessionStatus = "error"
)

type RunnerInfo struct {
	ID              string       `json:"id"`
	BaseURL         string       `json:"baseUrl"`
	Status          RunnerStatus `json:"status"`
	Version         string       `json:"version,omitempty"`
	LastHeartbeatAt *time.Time   `json:"lastHeartbeatAt,omitempty"`
	LastError       string       `json:"lastError,omitempty"`
}

type SessionRecord struct {
	ID          string        `json:"id"`
	WorkspaceID string        `json:"workspaceId"`
	Name        string        `json:"name"`
	ChannelID   string        `json:"channelId,omitempty"`
	ModelID     string        `json:"modelId,omitempty"`
	Status      SessionStatus `json:"status"`
	RunnerID    string        `json:"runnerId"`
	Transport   string        `json:"transport"`
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
	ConnectedAt *time.Time    `json:"connectedAt,omitempty"`
	LastError   string        `json:"lastError,omitempty"`
}

type ClaudeRuntimeConfig struct {
	APIKey  string `json:"apiKey"`
	BaseURL string `json:"baseUrl,omitempty"`
	ModelID string `json:"modelId"`
}

type CreateSessionInput struct {
	WorkspaceID   string              `json:"workspaceId"`
	Name          string              `json:"name"`
	ChannelID     string              `json:"channelId"`
	ModelID       string              `json:"modelId"`
	RuntimeConfig ClaudeRuntimeConfig `json:"runtimeConfig"`
}

type ConnectSessionInput struct {
	ConversationID string `json:"conversationId,omitempty"`
}

type SendMessageInput struct {
	Content string `json:"content"`
}

type RunnerMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type StreamChunk struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

type MessageResult struct {
	Session SessionRecord `json:"session"`
	Message RunnerMessage `json:"message"`
}

type MessageStreamResult struct {
	Session SessionRecord `json:"session"`
	Chunks  []StreamChunk `json:"chunks"`
}

type RunnerStreamEvent struct {
	Chunk     *StreamChunk `json:"chunk,omitempty"`
	Done      bool         `json:"done,omitempty"`
	UpdatedAt string       `json:"updatedAt,omitempty"`
}

type SessionConnection struct {
	SessionID      string    `json:"sessionId"`
	ConversationID string    `json:"conversationId,omitempty"`
	ConnectedAt    time.Time `json:"connectedAt"`
}

type SessionActionResult struct {
	Session SessionRecord `json:"session"`
}

type SessionConnectionResult struct {
	Session    SessionRecord     `json:"session"`
	Connection SessionConnection `json:"connection"`
}

type SessionListResult struct {
	Sessions        []SessionRecord `json:"sessions"`
	ActiveSessionID string          `json:"activeSessionId,omitempty"`
}

type RunnerHealth struct {
	Status     RunnerStatus `json:"status"`
	Service    string       `json:"service,omitempty"`
	Version    string       `json:"version,omitempty"`
	SDKReady   bool         `json:"sdkReady,omitempty"`
	LastError  string       `json:"lastError,omitempty"`
	CheckedAt  time.Time    `json:"checkedAt"`
}
