package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sparky-proma/server/internal/config"
	"github.com/sparky-proma/server/internal/store"
)

type runnerTestServer struct {
	server               *httptest.Server
	sessions             map[string]AgentSession
	messageBodies        []string
	streamMessageBodies  []string
}

func newRunnerTestServer() *runnerTestServer {
	runner := &runnerTestServer{sessions: make(map[string]AgentSession)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", runner.handleHealth)
	mux.HandleFunc("POST /internal/sessions", runner.handleCreateSession)
	mux.HandleFunc("GET /internal/sessions/", runner.handleGetSession)
	mux.HandleFunc("POST /internal/sessions/", runner.handleSessionAction)
	runner.server = httptest.NewServer(mux)
	return runner
}

func (r *runnerTestServer) close() {
	r.server.Close()
}

func (r *runnerTestServer) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "healthy",
		"service":   "proma-agent-runner",
		"version":   "0.1.0",
		"sdkReady":  true,
		"checkedAt": time.Now().UTC(),
	})
}

func (r *runnerTestServer) handleCreateSession(w http.ResponseWriter, req *http.Request) {
	var input CreateAgentSessionInput
	if err := json.NewDecoder(req.Body).Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	now := time.Now().UTC()
	session := AgentSession{
		ID:          "runner-session-1",
		WorkspaceID: input.WorkspaceID,
		Name:        input.Name,
		Status:      AgentSessionStatusRunning,
		RunnerID:    "default",
		Transport:   "http",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	r.sessions[session.ID] = session
	writeJSON(w, http.StatusCreated, AgentSessionActionResult{Session: session})
}

func (r *runnerTestServer) handleGetSession(w http.ResponseWriter, req *http.Request) {
	sessionID := strings.TrimPrefix(req.URL.Path, "/internal/sessions/")
	sessionID = strings.Split(sessionID, "/")[0]
	session, ok := r.sessions[sessionID]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (r *runnerTestServer) handleSessionAction(w http.ResponseWriter, req *http.Request) {
	trimmed := strings.TrimPrefix(req.URL.Path, "/internal/sessions/")
	parts := strings.Split(trimmed, "/")
	if len(parts) < 2 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}
	session, ok := r.sessions[parts[0]]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "agent session not found"})
		return
	}

	switch parts[1] {
	case "connect":
		if session.Status != AgentSessionStatusRunning {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "agent session action is not allowed in current status"})
			return
		}
		var input ConnectAgentSessionInput
		_ = json.NewDecoder(req.Body).Decode(&input)
		now := time.Now().UTC()
		session.ConnectedAt = &now
		session.UpdatedAt = now
		r.sessions[session.ID] = session
		writeJSON(w, http.StatusOK, AgentSessionConnectionResult{
			Session: session,
			Connection: AgentSessionConnection{
				SessionID:      session.ID,
				ConversationID: input.ConversationID,
				ConnectedAt:    now,
			},
		})
	case "messages":
		if session.Status != AgentSessionStatusRunning {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "agent session action is not allowed in current status"})
			return
		}
		if len(parts) >= 3 && parts[2] == "stream" {
			var input struct {
				Content string `json:"content"`
			}
			if err := json.NewDecoder(req.Body).Decode(&input); err != nil || strings.TrimSpace(input.Content) == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing content"})
				return
			}
			r.streamMessageBodies = append(r.streamMessageBodies, input.Content)
			session.UpdatedAt = time.Now().UTC()
			r.sessions[session.ID] = session
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("event: message\n"))
			_, _ = w.Write([]byte("data: {\"chunk\":{\"content\":\"runner stream: \",\"status\":\"partial\"}}\n\n"))
			_, _ = w.Write([]byte("event: message\n"))
			_, _ = w.Write([]byte("data: {\"chunk\":{\"content\":\"" + input.Content + "\",\"status\":\"done\"}}\n\n"))
			_, _ = w.Write([]byte("event: message\n"))
			_, _ = w.Write([]byte("data: {\"done\":true,\"updatedAt\":\"2026-03-24T00:01:45.000Z\"}\n\n"))
			return
		}
		var input struct {
			Content string `json:"content"`
		}
		if err := json.NewDecoder(req.Body).Decode(&input); err != nil || strings.TrimSpace(input.Content) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing content"})
			return
		}
		r.messageBodies = append(r.messageBodies, input.Content)
		session.UpdatedAt = time.Now().UTC()
		r.sessions[session.ID] = session
		writeJSON(w, http.StatusOK, map[string]any{
			"session": session,
			"message": map[string]any{
				"role":    "assistant",
				"content": "runner reply: " + input.Content,
			},
		})
	case "close":
		if session.Status != AgentSessionStatusRunning {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "agent session action is not allowed in current status"})
			return
		}
		session.Status = AgentSessionStatusStopped
		session.UpdatedAt = time.Now().UTC()
		r.sessions[session.ID] = session
		writeJSON(w, http.StatusOK, AgentSessionActionResult{Session: session})
	case "restart":
		if session.Status != AgentSessionStatusStopped && session.Status != AgentSessionStatusError {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "agent session action is not allowed in current status"})
			return
		}
		session.Status = AgentSessionStatusRunning
		session.UpdatedAt = time.Now().UTC()
		r.sessions[session.ID] = session
		writeJSON(w, http.StatusOK, AgentSessionActionResult{Session: session})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func newTestServer() (*Server, *store.MemoryStore) {
	st := store.NewMemoryStore()
	server := NewServer(config.Config{}, nil, st)
	return server, st
}

func newAgentEnabledTestServer(t *testing.T) (*Server, *store.MemoryStore, *runnerTestServer) {
	t.Helper()
	runner := newRunnerTestServer()
	cfg := config.Config{
		AgentControlEnabled:  true,
		AgentRunnerBaseURL:   runner.server.URL,
		AgentDefaultRunnerID: "default",
		AgentRunnerTimeout:   3 * time.Second,
	}
	st := store.NewMemoryStore()
	server := NewServer(cfg, nil, st)
	return server, st, runner
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

func createAgentSessionViaAPI(t *testing.T, handler http.Handler, st *store.MemoryStore) string {
	t.Helper()
	settings, err := st.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("GetSettings failed: %v", err)
	}
	body := bytes.NewBufferString(`{"workspaceId":"workspace-test","name":"Default Agent","channelId":"` + settings.AgentChannelID + `","modelId":"` + settings.AgentModelID + `"}`)
	req := httptest.NewRequest(http.MethodPost, "/api/agent/sessions", body)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create agent session status = %d body = %s", rec.Code, rec.Body.String())
	}
	var result struct {
		Session AgentSession `json:"session"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode agent session: %v", err)
	}
	return result.Session.ID
}

func TestUploadAttachmentEndpoint(t *testing.T) {
	server, _ := newTestServer()
	handler := server.Handler()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "spec.txt")
	if err != nil {
		t.Fatalf("CreateFormFile failed: %v", err)
	}
	if _, err := part.Write([]byte("spec")); err != nil {
		t.Fatalf("write file failed: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("writer.Close failed: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/chat/attachments", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d body = %s", rec.Code, rec.Body.String())
	}
	var attachment store.Attachment
	if err := json.Unmarshal(rec.Body.Bytes(), &attachment); err != nil {
		t.Fatalf("decode attachment: %v", err)
	}
	if attachment.Name != "spec.txt" || attachment.Status != "ready" || attachment.URL == "" || attachment.Size != 4 {
		t.Fatalf("unexpected attachment: %+v", attachment)
	}
}

func TestAgentSessionEndpoints(t *testing.T) {
	server, st, runner := newAgentEnabledTestServer(t)
	defer runner.close()
	handler := server.Handler()
	sessionID := createAgentSessionViaAPI(t, handler, st)

	listReq := httptest.NewRequest(http.MethodGet, "/api/agent/sessions", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK || !strings.Contains(listRec.Body.String(), sessionID) {
		t.Fatalf("list sessions status = %d body = %s", listRec.Code, listRec.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/agent/sessions/"+sessionID, nil)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK || !strings.Contains(getRec.Body.String(), `"status":"running"`) {
		t.Fatalf("get session status = %d body = %s", getRec.Code, getRec.Body.String())
	}

	connectReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/connect", bytes.NewBufferString(`{"conversationId":"conversation-1"}`))
	connectRec := httptest.NewRecorder()
	handler.ServeHTTP(connectRec, connectReq)
	if connectRec.Code != http.StatusOK || !strings.Contains(connectRec.Body.String(), `"sessionId":"`+sessionID+`"`) {
		t.Fatalf("connect session status = %d body = %s", connectRec.Code, connectRec.Body.String())
	}

	closeReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/close", nil)
	closeRec := httptest.NewRecorder()
	handler.ServeHTTP(closeRec, closeReq)
	if closeRec.Code != http.StatusOK || !strings.Contains(closeRec.Body.String(), `"status":"stopped"`) {
		t.Fatalf("close session status = %d body = %s", closeRec.Code, closeRec.Body.String())
	}

	restartReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/restart", nil)
	restartRec := httptest.NewRecorder()
	handler.ServeHTTP(restartRec, restartReq)
	if restartRec.Code != http.StatusOK || !strings.Contains(restartRec.Body.String(), `"status":"running"`) {
		t.Fatalf("restart session status = %d body = %s", restartRec.Code, restartRec.Body.String())
	}
}

func TestAgentSessionRequiresHealthyRunner(t *testing.T) {
	st := store.NewMemoryStore()
	cfg := config.Config{AgentControlEnabled: true, AgentRunnerBaseURL: "http://127.0.0.1:1", AgentDefaultRunnerID: "default", AgentRunnerTimeout: 200 * time.Millisecond}
	server := NewServer(cfg, nil, st)
	handler := server.Handler()

	settings, err := st.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("GetSettings failed: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/agent/sessions", bytes.NewBufferString(`{"workspaceId":"workspace-test","name":"Default Agent","channelId":"`+settings.AgentChannelID+`","modelId":"`+settings.AgentModelID+`"}`))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway && rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected runner failure status, got %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestChatMessageRequiresConnectedAgentSession(t *testing.T) {
	server, st, runner := newAgentEnabledTestServer(t)
	defer runner.close()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)

	sendReq := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	sendRec := httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusConflict || !strings.Contains(sendRec.Body.String(), "agent session must be connected") {
		t.Fatalf("expected connected session guard, got %d body = %s", sendRec.Code, sendRec.Body.String())
	}

	sessionID := createAgentSessionViaAPI(t, handler, st)
	connectReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/connect", bytes.NewBufferString(`{"conversationId":"`+conversationID+`"}`))
	connectRec := httptest.NewRecorder()
	handler.ServeHTTP(connectRec, connectReq)
	if connectRec.Code != http.StatusOK {
		t.Fatalf("connect session status = %d body = %s", connectRec.Code, connectRec.Body.String())
	}

	sendReq = httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages", bytes.NewBufferString(`{"content":"hello"}`))
	sendRec = httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusCreated {
		t.Fatalf("expected send allowed after connect, got %d body = %s", sendRec.Code, sendRec.Body.String())
	}

	closeReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/close", nil)
	closeRec := httptest.NewRecorder()
	handler.ServeHTTP(closeRec, closeReq)
	if closeRec.Code != http.StatusOK {
		t.Fatalf("close session status = %d body = %s", closeRec.Code, closeRec.Body.String())
	}

	sendReq = httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages", bytes.NewBufferString(`{"content":"again"}`))
	sendRec = httptest.NewRecorder()
	handler.ServeHTTP(sendRec, sendReq)
	if sendRec.Code != http.StatusConflict || !strings.Contains(sendRec.Body.String(), "agent session must be connected") {
		t.Fatalf("expected send blocked after close, got %d body = %s", sendRec.Code, sendRec.Body.String())
	}
}

func TestChatStreamingUsesRunnerSession(t *testing.T) {
	server, st, runner := newAgentEnabledTestServer(t)
	defer runner.close()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)
	sessionID := createAgentSessionViaAPI(t, handler, st)

	connectReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/connect", bytes.NewBufferString(`{"conversationId":"`+conversationID+`"}`))
	connectRec := httptest.NewRecorder()
	handler.ServeHTTP(connectRec, connectReq)
	if connectRec.Code != http.StatusOK {
		t.Fatalf("connect session status = %d body = %s", connectRec.Code, connectRec.Body.String())
	}

	streamReq := httptest.NewRequest(http.MethodPost, "/api/chat/sessions/"+conversationID+"/messages/stream", bytes.NewBufferString(`{"content":"hello stream"}`))
	streamRec := httptest.NewRecorder()
	handler.ServeHTTP(streamRec, streamReq)
	if streamRec.Code != http.StatusOK {
		t.Fatalf("stream status = %d body = %s", streamRec.Code, streamRec.Body.String())
	}
	body := streamRec.Body.String()
	if !strings.Contains(body, `"type":"delta"`) || !strings.Contains(body, `runner stream: `) || !strings.Contains(body, `hello stream`) {
		t.Fatalf("unexpected stream body: %s", body)
	}
	if len(runner.streamMessageBodies) != 1 || runner.streamMessageBodies[0] != "hello stream" {
		t.Fatalf("expected stream request to reach runner, got %+v", runner.streamMessageBodies)
	}

	messages, err := st.GetConversationMessages(t.Context(), conversationID, 20, "")
	if err != nil {
		t.Fatalf("GetConversationMessages failed: %v", err)
	}
	if len(messages.Messages) < 2 {
		t.Fatalf("expected stored user and assistant messages, got %d", len(messages.Messages))
	}
	last := messages.Messages[len(messages.Messages)-1]
	if last.Role != "assistant" || last.Content != "runner stream: hello stream" || last.Status != "done" {
		t.Fatalf("unexpected final assistant message: %+v", last)
	}
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
	server, st, runner := newAgentEnabledTestServer(t)
	defer runner.close()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)
	sessionID := createAgentSessionViaAPI(t, handler, st)

	connectReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/connect", bytes.NewBufferString(`{"conversationId":"`+conversationID+`"}`))
	connectRec := httptest.NewRecorder()
	handler.ServeHTTP(connectRec, connectReq)
	if connectRec.Code != http.StatusOK {
		t.Fatalf("connect session status = %d body = %s", connectRec.Code, connectRec.Body.String())
	}

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
	if !strings.Contains(sendRec.Body.String(), "runner reply: hello") {
		t.Fatalf("expected runner reply in response body: %s", sendRec.Body.String())
	}
	if len(runner.messageBodies) != 1 || runner.messageBodies[0] != "hello" {
		t.Fatalf("expected runner to receive sent message, got %+v", runner.messageBodies)
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
	server, st, runner := newAgentEnabledTestServer(t)
	defer runner.close()
	handler := server.Handler()
	conversationID := createConversationViaAPI(t, handler)
	sessionID := createAgentSessionViaAPI(t, handler, st)

	connectReq := httptest.NewRequest(http.MethodPost, "/api/agent/sessions/"+sessionID+"/connect", bytes.NewBufferString(`{"conversationId":"`+conversationID+`"}`))
	connectRec := httptest.NewRecorder()
	handler.ServeHTTP(connectRec, connectReq)
	if connectRec.Code != http.StatusOK {
		t.Fatalf("connect session status = %d body = %s", connectRec.Code, connectRec.Body.String())
	}

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
