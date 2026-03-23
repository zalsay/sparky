package api

import "net/http"

type createConversationRequest struct {
	Title     string `json:"title"`
	ModelID   string `json:"modelId"`
	ChannelID string `json:"channelId"`
}

type sendMessageRequest struct {
	Content   string `json:"content"`
	ModelID   string `json:"modelId"`
	ChannelID string `json:"channelId"`
}

func (s *Server) handleListConversations(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListConversations(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleCreateConversation(w http.ResponseWriter, r *http.Request) {
	var req createConversationRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	item, err := s.store.CreateConversation(r.Context(), req.Title, req.ModelID, req.ChannelID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) handleConversationMessages(w http.ResponseWriter, r *http.Request) {
	conversationID := conversationIDFromPath(r.URL.Path)
	if conversationID == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		result, err := s.store.GetConversationMessages(r.Context(), conversationID, limitFromRequest(r))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	case http.MethodPost:
		var req sendMessageRequest
		if err := decodeJSON(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		items, err := s.store.AppendUserAndAssistantMessage(r.Context(), conversationID, req.Content, "这是 Go server 的最小非流式占位回复。")
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"messages": items})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}
