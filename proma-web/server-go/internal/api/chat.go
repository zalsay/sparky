package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/sparky-proma/server/internal/store"
)

type attachmentPayload struct {
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	URL      string `json:"url,omitempty"`
}

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
	Content     string              `json:"content"`
	ModelID     string              `json:"modelId"`
	ChannelID   string              `json:"channelId"`
	Attachments []attachmentPayload `json:"attachments,omitempty"`
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

type updateDividerRequest struct {
	Title   string `json:"title"`
	Content string `json:"content"`
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
		var req struct {
			Title  *string `json:"title"`
			Pinned *bool   `json:"pinned"`
		}
		if err := decodeJSON(r, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		if req.Title != nil && strings.TrimSpace(*req.Title) != "" {
			updated, err := s.store.RenameConversation(r.Context(), conversationID, strings.TrimSpace(*req.Title))
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, updated)
			return
		}
		if req.Pinned != nil {
			updated, err := s.store.SetConversationPinned(r.Context(), conversationID, *req.Pinned)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, updated)
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing title or pinned"})
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
		if strings.HasSuffix(r.URL.Path, "/stream") {
			s.handleStreamMessage(w, r, conversationID)
			return
		}
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
		items, err := s.store.AppendMessagePair(r.Context(), conversationID,
			store.MessageCreateInput{Role: "user", Content: req.Content, Status: "done", Attachments: normalizeAttachments(req.Attachments)},
			store.MessageCreateInput{Role: "assistant", Content: "这是 Go server 的最小非流式占位回复。", Status: "done"},
		)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"messages": items})
	case http.MethodPut:
		messageID := conversationMessageIDFromPath(r.URL.Path)
		if messageID == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/edit") {
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
			return
		}
		if strings.HasSuffix(r.URL.Path, "/divider") {
			var req updateDividerRequest
			if err := decodeJSON(r, &req); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
				return
			}
			item, err := s.store.UpdateContextDivider(r.Context(), conversationID, messageID, strings.TrimSpace(req.Title), req.Content)
			if err != nil {
				writeStoreError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, item)
			return
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *Server) handleStreamMessage(w http.ResponseWriter, r *http.Request, conversationID string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	var req sendMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	chunks, err := s.store.BuildStreamingReply(r.Context(), conversationID, req.Content)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	assistantID := uuid.NewString()
	assistantCreatedAt := time.Now().UTC().Add(time.Millisecond)
	assistant := store.Message{ID: assistantID, ConversationID: conversationID, Role: "assistant", Content: "", CreatedAt: assistantCreatedAt, Status: "loading"}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	_ = writeSSEEvent(w, "message", map[string]any{"type": "start", "conversationId": conversationID, "message": assistant})
	flusher.Flush()

	content := ""
	status := "loading"
	for _, chunk := range chunks {
		content += chunk.Content
		status = chunk.Status
		_ = writeSSEEvent(w, "message", map[string]any{"type": "delta", "conversationId": conversationID, "delta": map[string]any{"messageId": assistantID, "content": chunk.Content, "status": chunk.Status}})
		flusher.Flush()
	}

	created, err := s.store.AppendMessagePair(r.Context(), conversationID,
		store.MessageCreateInput{Role: "user", Content: req.Content, Status: "done", Attachments: normalizeAttachments(req.Attachments)},
		store.MessageCreateInput{Role: "assistant", Content: content, Status: status},
	)
	if err != nil {
		_ = writeSSEEvent(w, "message", map[string]any{"type": "error", "conversationId": conversationID, "error": err.Error()})
		flusher.Flush()
		return
	}
	finalMessage := created[len(created)-1]
	_ = writeSSEEvent(w, "message", map[string]any{"type": "done", "conversationId": conversationID, "message": finalMessage})
	flusher.Flush()
}

func normalizeAttachments(items []attachmentPayload) []store.Attachment {
	if len(items) == 0 {
		return nil
	}
	result := make([]store.Attachment, 0, len(items))
	for _, item := range items {
		id := item.ID
		if id == "" {
			id = uuid.NewString()
		}
		result = append(result, store.Attachment{ID: id, Name: item.Name, MimeType: item.MimeType, Size: item.Size, URL: item.URL, Status: "ready"})
	}
	return result
}

func writeSSEEvent(w http.ResponseWriter, event string, payload any) error {
	encoded, err := marshalJSON(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\n", event); err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", encoded); err != nil {
		return err
	}
	return nil
}

func writeStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrConversationNotFound) || errors.Is(err, store.ErrMessageNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}
