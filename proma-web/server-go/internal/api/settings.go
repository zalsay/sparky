package api

import (
	"net/http"

	"github.com/sparky-proma/server/internal/store"
)

type updateSettingsRequest struct {
	ThemeMode               string `json:"themeMode"`
	OnboardingCompleted     bool   `json:"onboardingCompleted"`
	EnvironmentCheckSkipped bool   `json:"environmentCheckSkipped"`
	NotificationsEnabled    bool   `json:"notificationsEnabled"`
	AgentChannelID          string `json:"agentChannelId"`
	AgentModelID            string `json:"agentModelId"`
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	value, err := s.store.GetSettings(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req updateSettingsRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	updated, err := s.store.UpdateSettings(r.Context(), store.Settings{
		ThemeMode:               req.ThemeMode,
		OnboardingCompleted:     req.OnboardingCompleted,
		EnvironmentCheckSkipped: req.EnvironmentCheckSkipped,
		NotificationsEnabled:    req.NotificationsEnabled,
		AgentChannelID:          req.AgentChannelID,
		AgentModelID:            req.AgentModelID,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, updated)
}
