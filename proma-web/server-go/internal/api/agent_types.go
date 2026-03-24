package api

import (
	"time"

	"github.com/sparky-proma/server/internal/agent"
)

type AgentRunnerStatus string

type AgentSessionStatus string

const (
	AgentRunnerStatusUnknown     AgentRunnerStatus = "unknown"
	AgentRunnerStatusHealthy     AgentRunnerStatus = "healthy"
	AgentRunnerStatusUnreachable AgentRunnerStatus = "unreachable"
)

const (
	AgentSessionStatusCreating   AgentSessionStatus = "creating"
	AgentSessionStatusStarting   AgentSessionStatus = "starting"
	AgentSessionStatusRunning    AgentSessionStatus = "running"
	AgentSessionStatusConnecting AgentSessionStatus = "connecting"
	AgentSessionStatusStopped    AgentSessionStatus = "stopped"
	AgentSessionStatusClosing    AgentSessionStatus = "closing"
	AgentSessionStatusRestarting AgentSessionStatus = "restarting"
	AgentSessionStatusError      AgentSessionStatus = "error"
)

type AgentRunnerInfo struct {
	ID              string            `json:"id"`
	BaseURL         string            `json:"baseUrl"`
	Status          AgentRunnerStatus `json:"status"`
	Version         string            `json:"version,omitempty"`
	LastHeartbeatAt *time.Time        `json:"lastHeartbeatAt,omitempty"`
	LastError       string            `json:"lastError,omitempty"`
}

type AgentSession struct {
	ID          string             `json:"id"`
	WorkspaceID string             `json:"workspaceId"`
	Name        string             `json:"name"`
	ChannelID   string             `json:"channelId,omitempty"`
	ModelID     string             `json:"modelId,omitempty"`
	Status      AgentSessionStatus `json:"status"`
	RunnerID    string             `json:"runnerId"`
	Transport   string             `json:"transport"`
	CreatedAt   time.Time          `json:"createdAt"`
	UpdatedAt   time.Time          `json:"updatedAt"`
	ConnectedAt *time.Time         `json:"connectedAt,omitempty"`
	LastError   string             `json:"lastError,omitempty"`
}

type AgentSessionConnection struct {
	SessionID      string    `json:"sessionId"`
	ConversationID string    `json:"conversationId,omitempty"`
	ConnectedAt    time.Time `json:"connectedAt"`
}

type CreateAgentSessionInput struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	ChannelID   string `json:"channelId"`
	ModelID     string `json:"modelId"`
}

type ConnectAgentSessionInput struct {
	ConversationID string `json:"conversationId,omitempty"`
}

type AgentSessionActionResult struct {
	Session AgentSession `json:"session"`
}

type AgentSessionConnectionResult struct {
	Session    AgentSession           `json:"session"`
	Connection AgentSessionConnection `json:"connection"`
}

type AgentSessionListResult struct {
	Sessions        []AgentSession `json:"sessions"`
	ActiveSessionID string         `json:"activeSessionId,omitempty"`
}

type agentControlPlaneRuntime struct {
	Enabled             bool              `json:"enabled"`
	RunnerCount         int               `json:"runnerCount"`
	DefaultRunnerStatus AgentRunnerStatus `json:"defaultRunnerStatus"`
}

type runtimeResponse struct {
	Service           string                   `json:"service"`
	Version           string                   `json:"version"`
	Environment       string                   `json:"environment"`
	Database          map[string]any           `json:"database"`
	AgentControlPlane agentControlPlaneRuntime `json:"agentControlPlane"`
}

func agentRunnerStatus(status agent.RunnerStatus) AgentRunnerStatus {
	return AgentRunnerStatus(status)
}

func agentSessionStatus(status agent.SessionStatus) AgentSessionStatus {
	return AgentSessionStatus(status)
}

func toAgentRunnerInfo(value agent.RunnerInfo) AgentRunnerInfo {
	return AgentRunnerInfo{
		ID:              value.ID,
		BaseURL:         value.BaseURL,
		Status:          agentRunnerStatus(value.Status),
		Version:         value.Version,
		LastHeartbeatAt: value.LastHeartbeatAt,
		LastError:       value.LastError,
	}
}

func toAgentSession(value agent.SessionRecord) AgentSession {
	return AgentSession{
		ID:          value.ID,
		WorkspaceID: value.WorkspaceID,
		Name:        value.Name,
		ChannelID:   value.ChannelID,
		ModelID:     value.ModelID,
		Status:      agentSessionStatus(value.Status),
		RunnerID:    value.RunnerID,
		Transport:   value.Transport,
		CreatedAt:   value.CreatedAt,
		UpdatedAt:   value.UpdatedAt,
		ConnectedAt: value.ConnectedAt,
		LastError:   value.LastError,
	}
}

func toAgentSessionListResult(value agent.SessionListResult) AgentSessionListResult {
	sessions := make([]AgentSession, 0, len(value.Sessions))
	for _, session := range value.Sessions {
		sessions = append(sessions, toAgentSession(session))
	}
	return AgentSessionListResult{Sessions: sessions, ActiveSessionID: value.ActiveSessionID}
}

func toAgentSessionActionResult(value agent.SessionActionResult) AgentSessionActionResult {
	return AgentSessionActionResult{Session: toAgentSession(value.Session)}
}

func toAgentSessionConnectionResult(value agent.SessionConnectionResult) AgentSessionConnectionResult {
	return AgentSessionConnectionResult{
		Session: toAgentSession(value.Session),
		Connection: AgentSessionConnection{
			SessionID:      value.Connection.SessionID,
			ConversationID: value.Connection.ConversationID,
			ConnectedAt:    value.Connection.ConnectedAt,
		},
	}
}
