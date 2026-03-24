package api

import (
	"net/http"
	"strings"

	"github.com/sparky-proma/server/internal/store"
)

type channelPayload struct {
	ID        string               `json:"id,omitempty"`
	Name      string               `json:"name"`
	Provider  string               `json:"provider"`
	BaseURL   string               `json:"baseUrl"`
	APIKey    string               `json:"apiKey,omitempty"`
	Models    []store.ChannelModel `json:"models"`
	Enabled   *bool                `json:"enabled,omitempty"`
	CreatedAt string               `json:"createdAt,omitempty"`
	UpdatedAt string               `json:"updatedAt,omitempty"`
}

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListChannels(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var req channelPayload
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Provider) == "" || strings.TrimSpace(req.BaseURL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing name, provider or baseUrl"})
		return
	}
	created, err := s.store.CreateChannel(r.Context(), store.ChannelCreateInput{
		Name:     req.Name,
		Provider: req.Provider,
		BaseURL:  req.BaseURL,
		APIKey:   req.APIKey,
		Models:   append([]store.ChannelModel(nil), req.Models...),
		Enabled:  req.Enabled == nil || *req.Enabled,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleChannel(w http.ResponseWriter, r *http.Request) {
	channelID := channelIDFromPath(r.URL.Path)
	if channelID == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "channel not found"})
		return
	}

	switch r.Method {
	case http.MethodPatch:
		var req channelPayload
		if err := decodeJSON(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		updated, err := s.store.UpdateChannel(r.Context(), channelID, store.ChannelUpdateInput{
			Name:     optionalTrimmedString(req.Name),
			Provider: optionalTrimmedString(req.Provider),
			BaseURL:  optionalTrimmedString(req.BaseURL),
			APIKey:   optionalTrimmedString(req.APIKey),
			Models:   append([]store.ChannelModel(nil), req.Models...),
			Enabled:  req.Enabled,
		})
		if err != nil {
			writeChannelError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		if err := s.store.DeleteChannel(r.Context(), channelID); err != nil {
			writeChannelError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func channelIDFromPath(path string) string {
	prefix := "/api/channels/"
	trimmed := strings.TrimPrefix(path, prefix)
	parts := strings.Split(trimmed, "/")
	if len(parts) == 0 || parts[0] == "" {
		return ""
	}
	return parts[0]
}

func optionalTrimmedString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func writeChannelError(w http.ResponseWriter, err error) {
	if err == store.ErrChannelNotFound {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "channel not found"})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}
