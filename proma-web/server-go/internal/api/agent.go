package api

import (
	"errors"
	"net/http"

	"github.com/sparky-proma/server/internal/agent"
)

func (s *Server) handleListAgentRunners(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []AgentRunnerInfo{toAgentRunnerInfo(s.agentService.DefaultRunner(r.Context()))})
}

func (s *Server) handleGetAgentRunner(w http.ResponseWriter, r *http.Request) {
	runnerID := agentRunnerIDFromPath(r.URL.Path)
	runner := toAgentRunnerInfo(s.agentService.DefaultRunner(r.Context()))
	if runnerID == "" || runnerID != runner.ID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent runner not found"})
		return
	}

	writeJSON(w, http.StatusOK, runner)
}

func (s *Server) handleListAgentSessions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, toAgentSessionListResult(s.agentService.ListSessions()))
}

func (s *Server) handleCreateAgentSession(w http.ResponseWriter, r *http.Request) {
	var input CreateAgentSessionInput
	if err := decodeJSON(r, &input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if input.WorkspaceID == "" || input.Name == "" || input.ChannelID == "" || input.ModelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing workspaceId, name, channelId or modelId"})
		return
	}

	channel, err := s.store.GetChannelRuntime(r.Context(), input.ChannelID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent channel not found"})
		return
	}
	if !channel.Enabled {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "agent channel is disabled"})
		return
	}
	if channel.Provider != "anthropic" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "agent runtime only supports anthropic channels"})
		return
	}
	modelEnabled := false
	for _, model := range channel.Models {
		if model.ID == input.ModelID && model.Enabled {
			modelEnabled = true
			break
		}
	}
	if !modelEnabled {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "agent model is unavailable for selected channel"})
		return
	}

	result, err := s.agentService.CreateSession(r.Context(), agent.CreateSessionInput{
		WorkspaceID: input.WorkspaceID,
		Name:        input.Name,
		ChannelID:   input.ChannelID,
		ModelID:     input.ModelID,
		RuntimeConfig: agent.ClaudeRuntimeConfig{
			APIKey:  channel.APIKey,
			BaseURL: channel.BaseURL,
			ModelID: input.ModelID,
		},
	})
	if err != nil {
		s.handleAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toAgentSessionActionResult(result))
}

func (s *Server) handleGetAgentSession(w http.ResponseWriter, r *http.Request) {
	sessionID := agentSessionIDFromPath(r.URL.Path)
	session, err := s.agentService.GetSession(sessionID)
	if err != nil {
		s.handleAgentError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, toAgentSession(session))
}

func (s *Server) handleAgentSessionAction(w http.ResponseWriter, r *http.Request) {
	sessionID := agentSessionIDFromPath(r.URL.Path)
	action := agentSessionActionFromPath(r.URL.Path)
	if sessionID == "" || action == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}

	switch action {
	case "connect":
		var input ConnectAgentSessionInput
		if err := decodeJSON(r, &input); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		result, err := s.agentService.ConnectSession(r.Context(), sessionID, agent.ConnectSessionInput{ConversationID: input.ConversationID})
		if err != nil {
			s.handleAgentError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, toAgentSessionConnectionResult(result))
	case "close":
		result, err := s.agentService.CloseSession(r.Context(), sessionID)
		if err != nil {
			s.handleAgentError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, toAgentSessionActionResult(result))
	case "restart":
		result, err := s.agentService.RestartSession(r.Context(), sessionID)
		if err != nil {
			s.handleAgentError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, toAgentSessionActionResult(result))
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *Server) handleAgentError(w http.ResponseWriter, err error) {
	if errors.Is(err, agent.ErrSessionNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	if errors.Is(err, agent.ErrInvalidSessionState) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "agent session action is not allowed in current status"})
		return
	}
	var runnerErr *agent.RunnerError
	if errors.As(err, &runnerErr) {
		status := http.StatusBadGateway
		if runnerErr.StatusCode >= 400 && runnerErr.StatusCode < 500 {
			status = http.StatusConflict
		}
		writeJSON(w, status, map[string]string{"error": runnerErr.Message})
		return
	}
	if err.Error() == "agent control plane is disabled" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
}
