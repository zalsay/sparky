package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelEndpoints(t *testing.T) {
	server, _ := newTestServer()
	handler := server.Handler()

	createReq := httptest.NewRequest(http.MethodPost, "/api/channels", bytes.NewBufferString(`{"name":"Test Anthropic","provider":"anthropic","baseUrl":"https://api.anthropic.com","apiKey":"secret-key","models":[{"id":"claude-opus-4-6","name":"Claude Opus 4.6","enabled":true}],"enabled":true}`))
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create channel status = %d body = %s", createRec.Code, createRec.Body.String())
	}
	var created struct {
		ID     string `json:"id"`
		APIKey string `json:"apiKey"`
	}
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create channel: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected created channel id")
	}
	if created.APIKey != "" {
		t.Fatalf("expected sanitized apiKey, got %q", created.APIKey)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/channels", nil)
	listRec := httptest.NewRecorder()
	handler.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK || !strings.Contains(listRec.Body.String(), created.ID) {
		t.Fatalf("list channels status = %d body = %s", listRec.Code, listRec.Body.String())
	}
	if strings.Contains(listRec.Body.String(), "secret-key") {
		t.Fatalf("expected channel list to hide api key, got %s", listRec.Body.String())
	}

	updateReq := httptest.NewRequest(http.MethodPatch, "/api/channels/"+created.ID, bytes.NewBufferString(`{"name":"Updated Anthropic"}`))
	updateRec := httptest.NewRecorder()
	handler.ServeHTTP(updateRec, updateReq)
	if updateRec.Code != http.StatusOK || !strings.Contains(updateRec.Body.String(), "Updated Anthropic") {
		t.Fatalf("update channel status = %d body = %s", updateRec.Code, updateRec.Body.String())
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/channels/"+created.ID, nil)
	deleteRec := httptest.NewRecorder()
	handler.ServeHTTP(deleteRec, deleteReq)
	if deleteRec.Code != http.StatusNoContent {
		t.Fatalf("delete channel status = %d body = %s", deleteRec.Code, deleteRec.Body.String())
	}
}
