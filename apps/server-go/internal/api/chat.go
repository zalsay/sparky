package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/sparky-proma/server/internal/store"
)

type createConversationRequest struct {
	Title     string `json:"title"`
	ModelID   string `json:"modelId"`
	ChannelID string `json:"channelId"`
}

type renameConversationRequest struct {
	Title string `json:"title"`
}

type pinConversationRequest struct {
	Pinned bool `json:"pinned"`
}

type sendMessageRequest struct {
	Content   string `json:"content"`
	ModelID   string `json:"modelId"`
	ChannelID string `json:"channelId"`
}

type editMessageRequest struct {
	Content string `json:"content"`
}

type resendMessageRequest struct {
	MessageID string `json:"messageId"`
}

type truncateMessagesRequest struct {
	MessageID string `json:"messageId"`
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

func (s *Server) handleConversation(w http.ResponseWriter, r *http.Request) {
	conversationID := conversationIDFromPath(r.URL.Path)
	if conversationID == "" || strings.Contains(r.URL.Path, "/messages") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	switch r.Method {
	case http.MethodPatch:
		var renameReq renameConversationRequest
		if err := decodeJSON(r, &renameReq); err == nil && strings.TrimSpace(renameReq.Title) != "" {
			updated, err := s.store.RenameConversation(r.Context(), conversationID, renameReq.Title)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, updated)
			return
		}

		var pinReq pinConversationRequest
		if err := decodeJSON(r, &pinReq); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		updated, err := s.store.SetConversationPinned(r.Context(), conversationID, pinReq.Pinned)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		if err := s.store.DeleteConversation(r.Context(), conversationID); err != nil {
			writeStoreError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *Server) handleConversationMessages(w http.ResponseWriter, r *http.Request) {
	conversationID := conversationIDFromPath(r.URL.Path)
	if conversationID == "" || !strings.Contains(r.URL.Path, "/messages") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		result, err := s.store.GetConversationMessages(r.Context(), conversationID, limitFromRequest(r), r.URL.Query().Get("before"))
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	case http.MethodPost:
		if strings.HasSuffix(r.URL.Path, "/resend") {
			var req resendMessageRequest
			if err := decodeJSON(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
				return
			}
			items, err := s.store.ResendMessage(r.Context(), conversationID, req.MessageID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]any{"messages": items})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/truncate") {
			var req truncateMessagesRequest
			if err := decodeJSON(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
				return
			}
			result, err := s.store.TruncateMessages(r.Context(), conversationID, req.MessageID)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, result)
			return
		}
		var req sendMessageRequest
		if err := decodeJSON(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		items, err := s.store.AppendUserAndAssistantMessage(r.Context(), conversationID, req.Content, "这是 Go server 的最小非流式占位回复。")
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"messages": items})
	case http.MethodPut:
		messageID := conversationMessageIDFromPath(r.URL.Path)
		if messageID == "" || !strings.HasSuffix(r.URL.Path, "/edit") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		var req editMessageRequest
		if err := decodeJSON(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		items, err := s.store.EditMessage(r.Context(), conversationID, messageID, req.Content)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": items})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrConversationNotFound) || errors.Is(err, store.ErrMessageNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}
