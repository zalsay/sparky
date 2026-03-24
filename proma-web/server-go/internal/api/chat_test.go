package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sparky-proma/server/internal/config"
	"github.com/sparky-proma/server/internal/store"
)

func newTestServer() (*Server, *store.MemoryStore) {
	st := store.NewMemoryStore()
	server := NewServer(config.Config{}, nil, st)
	return server, st
}

func createConversationViaAPI(t *testing.T, handler http.Handler) string {
	t.Helper()
	body := bytes.NewBufferString(`{"title":"Test Conversation","modelId":"model-test","channelId":"channel-test"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/chat/sessions", body)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create conversation status = %d body = %s", rec.Code, rec.Body.String())
	}
	var conversation store.Conversation
	if err := json.Unmarshal(rec.Body.Bytes(), &conversation); err != nil {
		t.Fatalf("decode conversation: %v", err)
	}
	return conversation.ID
}

func TestChatConversationLifecycleEndpoints(t *testing.T) {
	server, _ := newTestServer()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)

	listReq := httptest.NewRequest(http.MethodGet, "/api/chat/sessions", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", listRec.Code, listRec.Body.String())
	}

	renameReq := httptest.NewRequest(http.MethodPatch, "/api/chat/sessions/"+conversationID, bytes.NewBufferString(`{"title":"Renamed"}`))
	renameRec := httptest.NewRecorder()
	handler.ServeHTTP(renameRec, renameReq)
	if renameRec.Code != http.StatusOK || !strings.Contains(renameRec.Body.String(), "Renamed") {
		t.Fatalf("rename status = %d body = %s", renameRec.Code, renameRec.Body.String())
	}

	pinReq := httptest.NewRequest(http.MethodPatch, "/api/chat/sessions/"+conversationID, bytes.NewBufferString(`{"pinned":true}`))
	pinRec := httptest.NewRecorder()
	handler.ServeHTTP(pinRec, pinReq)
	if pinRec.Code != http.StatusOK || !strings.Contains(pinRec.Body.String(), `"pinned":true`) {
		t.Fatalf("pin status = %d body = %s", pinRec.Code, pinRec.Body.String())
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/chat/sessions/"+conversationID, nil)
	deleteRec := httptest.NewRecorder()
	handler.ServeHTTP(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d body = %s", deleteRec.Code, deleteRec.Body.String())
	}
}

func TestChatMessageEndpoints(t *testing.T) {
	server, _ := newTestServer()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)

	sendBody := bytes.NewBufferString(`{"content":"hello","attachments":[{"id":"att-1","name":"spec.txt","mimeType":"text/plain","size":12,"url":"https://example.invalid/spec.txt"}]}`)
	sendReq := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages", sendBody)
	sendRec := httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusCreated {
		t.Fatalf("send status = %d body = %s", sendRec.Code, sendRec.Body.String())
	}
	if !strings.Contains(sendRec.Body.String(), "spec.txt") {
		t.Fatalf("expected attachment in response body: %s", sendRec.Body.String())
	}
	var sendResult struct {
		Messages []store.Message `json:"messages"`
	}
	if err := json.Unmarshal(sendRec.Body.Bytes(), &sendResult); err != nil {
		t.Fatalf("decode send result: %v", err)
	}
	userMessageID := sendResult.Messages[0].ID

	editReq := httptest.NewRequest(http.MethodPut, "/api/chat/sessions/"+conversationID+"/messages/"+userMessageID+"/edit", bytes.NewBufferString(`{"content":"edited"}`))
	editRec := httptest.NewRecorder()
	handler.ServeHTTP(editRec, editReq)
	if editRec.Code != http.StatusOK || !strings.Contains(editRec.Body.String(), "edited") {
		t.Fatalf("edit status = %d body = %s", editRec.Code, editRec.Body.String())
	}

	resendReq := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages/resend", bytes.NewBufferString(`{"messageId":"`+userMessageID+`"}`))
	resendRec := httptest.NewRecorder()
	handler.ServeHTTP(resendRec, resendReq)
	if resendRec.Code != http.StatusCreated || !strings.Contains(resendRec.Body.String(), "最小非流式重发占位回复") {
		t.Fatalf("resend status = %d body = %s", resendRec.Code, resendRec.Body.String())
	}

	truncateReq := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages/truncate", bytes.NewBufferString(`{"messageId":"`+userMessageID+`"}`))
	truncateRec := httptest.NewRecorder()
	handler.ServeHTTP(truncateRec, truncateReq)
	if truncateRec.Code != http.StatusOK {
		t.Fatalf("truncate status = %d body = %s", truncateRec.Code, truncateRec.Body.String())
	}
	var truncateResult store.ConversationMessagesResult
	if err := json.Unmarshal(truncateRec.Body.Bytes(), &truncateResult); err != nil {
		t.Fatalf("decode truncate result: %v", err)
	}
	if truncateResult.Total != 0 {
		t.Fatalf("expected no messages after truncating from first user message, got %+v", truncateResult)
	}
}

func TestChatStreamAndDividerEndpoints(t *testing.T) {
	server, st := newTestServer()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)

	dividerMessages, err := st.AppendMessagePair(nil, conversationID,
		store.MessageCreateInput{Role: "user", Content: "ask", Status: "done"},
		store.MessageCreateInput{Role: "system", Content: "divider", Status: "done", Kind: "context_divider", ContextDivider: &store.ContextDivider{ID: "divider-1", Title: "Before", Content: "divider"}},
	)
	if err != nil {
		t.Fatalf("seed divider messages: %v", err)
	}
	dividerID := dividerMessages[1].ID

	streamReq := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages/stream", bytes.NewBufferString(`{"content":"stream me"}`))
	streamRec := httptest.NewRecorder()
	handler.ServeHTTP(streamRec, streamReq)
	if streamRec.Code != http.StatusOK {
		t.Fatalf("stream status = %d body = %s", streamRec.Code, streamRec.Body.String())
	}
	body := streamRec.Body.String()
	if !strings.Contains(body, `"type":"start"`) || !strings.Contains(body, `"type":"delta"`) || !strings.Contains(body, `"type":"done"`) {
		t.Fatalf("unexpected stream body: %s", body)
	}
	if strings.Index(body, `"type":"start"`) > strings.Index(body, `"type":"delta"`) || strings.Index(body, `"type":"delta"`) > strings.Index(body, `"type":"done"`) {
		t.Fatalf("unexpected event order: %s", body)
	}

	dividerReq := httptest.NewRequest(http.MethodPut, "/api/chat/sessions/"+conversationID+"/messages/"+dividerID+"/divider", bytes.NewBufferString(`{"title":"After","content":"updated"}`))
	dividerRec := httptest.NewRecorder()
	handler.ServeHTTP(dividerRec, dividerReq)
	if dividerRec.Code != http.StatusOK || !strings.Contains(dividerRec.Body.String(), "After") {
		t.Fatalf("divider status = %d body = %s", dividerRec.Code, dividerRec.Body.String())
	}
}
