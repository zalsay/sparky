package store

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func newPostgresMockStore(t *testing.T) (*PostgresStore, sqlmock.Sqlmock, func()) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New failed: %v", err)
	}
	return NewPostgresStore(db), mock, func() { _ = db.Close() }
}

func expectEnsureSeed(mock sqlmock.Sqlmock) {
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_channel_id TEXT`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_model_id TEXT`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`CREATE TABLE IF NOT EXISTS channels (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT NOT NULL,
			base_url TEXT NOT NULL,
			encrypted_api_key TEXT NOT NULL DEFAULT '',
			models JSONB NOT NULL DEFAULT '[]'::jsonb,
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS model_id TEXT`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS channel_id TEXT`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status TEXT`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_invocation JSONB`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_result JSONB`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS context_divider JSONB`)).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta(`
		INSERT INTO settings (id, theme_mode, onboarding_completed, environment_check_skipped, notifications_enabled)
		VALUES (TRUE, 'system', TRUE, FALSE, TRUE)
		ON CONFLICT (id) DO NOTHING`)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT COUNT(*) FROM channels`)).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT COUNT(*) FROM workspaces`)).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT COUNT(*) FROM chat_sessions`)).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
}

func expectConversationExists(mock sqlmock.Sqlmock, conversationID string) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id = $1)`)).WithArgs(conversationID).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
}

func attachmentJSON(t *testing.T, attachments []Attachment) driver.Value {
	t.Helper()
	payload, err := json.Marshal(attachments)
	if err != nil {
		t.Fatalf("marshal attachments: %v", err)
	}
	return payload
}

func toolInvocationJSON(t *testing.T, value *ToolInvocation) driver.Value {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal tool invocation: %v", err)
	}
	return payload
}

func toolResultJSON(t *testing.T, value *ToolResult) driver.Value {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal tool result: %v", err)
	}
	return payload
}

func contextDividerJSON(t *testing.T, value *ContextDivider) driver.Value {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal context divider: %v", err)
	}
	return payload
}

func TestPostgresStoreChannelLifecycle(t *testing.T) {
	store, mock, cleanup := newPostgresMockStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC()
	models := []ChannelModel{{ID: "claude-opus-4-6", Name: "Claude Opus 4.6", Enabled: true}}
	modelsJSON, err := json.Marshal(models)
	if err != nil {
		t.Fatalf("marshal models: %v", err)
	}

	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO channels (id, name, provider, base_url, encrypted_api_key, models, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, name, provider, base_url, models, enabled, created_at, updated_at`)).
		WithArgs(sqlmock.AnyArg(), "Test Anthropic", "anthropic", "https://api.anthropic.com", encryptAPIKey("secret-key"), modelsJSON, true).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "provider", "base_url", "models", "enabled", "created_at", "updated_at"}).
			AddRow("channel-1", "Test Anthropic", "anthropic", "https://api.anthropic.com", modelsJSON, true, now, now))

	created, err := store.CreateChannel(ctx, ChannelCreateInput{
		Name:     "Test Anthropic",
		Provider: "anthropic",
		BaseURL:  "https://api.anthropic.com",
		APIKey:   "secret-key",
		Models:   models,
		Enabled:  true,
	})
	if err != nil {
		t.Fatalf("CreateChannel failed: %v", err)
	}
	if created.APIKey != "" || created.EncryptedAPIKey != "" {
		t.Fatalf("expected sanitized created channel, got %+v", created)
	}

	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, name, provider, base_url, models, enabled, created_at, updated_at FROM channels ORDER BY updated_at DESC`)).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "provider", "base_url", "models", "enabled", "created_at", "updated_at"}).
			AddRow("channel-1", "Test Anthropic", "anthropic", "https://api.anthropic.com", modelsJSON, true, now, now))

	listed, err := store.ListChannels(ctx)
	if err != nil {
		t.Fatalf("ListChannels failed: %v", err)
	}
	if len(listed) != 1 || listed[0].ID != "channel-1" {
		t.Fatalf("unexpected listed channels: %+v", listed)
	}
	if listed[0].APIKey != "" || listed[0].EncryptedAPIKey != "" {
		t.Fatalf("expected sanitized list channel, got %+v", listed[0])
	}

	updatedModels := []ChannelModel{{ID: "claude-sonnet-4-6", Name: "Claude Sonnet 4.6", Enabled: true}}
	updatedModelsJSON, err := json.Marshal(updatedModels)
	if err != nil {
		t.Fatalf("marshal updated models: %v", err)
	}
	updatedName := "Updated Anthropic"
	updatedBaseURL := "https://anthropic-proxy.example.com"
	updatedAPIKey := "new-secret-key"
	updatedEnabled := false

	expectEnsureSeed(mock)
	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, name, provider, base_url, encrypted_api_key, models, enabled, created_at, updated_at FROM channels WHERE id = $1`)).
		WithArgs("channel-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "provider", "base_url", "encrypted_api_key", "models", "enabled", "created_at", "updated_at"}).
			AddRow("channel-1", "Test Anthropic", "anthropic", "https://api.anthropic.com", encryptAPIKey("secret-key"), modelsJSON, true, now, now))
	mock.ExpectQuery(regexp.QuoteMeta(`
		UPDATE channels
		SET name = $2,
		    provider = $3,
		    base_url = $4,
		    encrypted_api_key = $5,
		    models = $6,
		    enabled = $7,
		    updated_at = NOW()
		WHERE id = $1
		RETURNING id, name, provider, base_url, models, enabled, created_at, updated_at`)).
		WithArgs("channel-1", updatedName, "anthropic", updatedBaseURL, encryptAPIKey(updatedAPIKey), updatedModelsJSON, updatedEnabled).
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "provider", "base_url", "models", "enabled", "created_at", "updated_at"}).
			AddRow("channel-1", updatedName, "anthropic", updatedBaseURL, updatedModelsJSON, updatedEnabled, now, now.Add(time.Second)))

	updated, err := store.UpdateChannel(ctx, "channel-1", ChannelUpdateInput{
		Name:    &updatedName,
		BaseURL: &updatedBaseURL,
		APIKey:  &updatedAPIKey,
		Models:  updatedModels,
		Enabled: &updatedEnabled,
	})
	if err != nil {
		t.Fatalf("UpdateChannel failed: %v", err)
	}
	if updated.APIKey != "" || updated.EncryptedAPIKey != "" {
		t.Fatalf("expected sanitized updated channel, got %+v", updated)
	}
	if updated.Name != updatedName || updated.BaseURL != updatedBaseURL || updated.Enabled != updatedEnabled {
		t.Fatalf("unexpected updated channel: %+v", updated)
	}

	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, name, provider, base_url, encrypted_api_key, models, enabled, created_at, updated_at FROM channels WHERE id = $1`)).
		WithArgs("channel-1").
		WillReturnRows(sqlmock.NewRows([]string{"id", "name", "provider", "base_url", "encrypted_api_key", "models", "enabled", "created_at", "updated_at"}).
			AddRow("channel-1", updatedName, "anthropic", updatedBaseURL, encryptAPIKey(updatedAPIKey), updatedModelsJSON, updatedEnabled, now, now.Add(time.Second)))

	runtime, err := store.GetChannelRuntime(ctx, "channel-1")
	if err != nil {
		t.Fatalf("GetChannelRuntime failed: %v", err)
	}
	if runtime.APIKey != updatedAPIKey || runtime.EncryptedAPIKey != encryptAPIKey(updatedAPIKey) {
		t.Fatalf("expected runtime secrets, got %+v", runtime)
	}
	if runtime.Name != updatedName || runtime.BaseURL != updatedBaseURL || len(runtime.Models) != 1 || runtime.Models[0].ID != "claude-sonnet-4-6" {
		t.Fatalf("unexpected runtime channel: %+v", runtime)
	}

	expectEnsureSeed(mock)
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM channels WHERE id = $1`)).WithArgs("channel-1").WillReturnResult(sqlmock.NewResult(0, 1))
	if err := store.DeleteChannel(ctx, "channel-1"); err != nil {
		t.Fatalf("DeleteChannel failed: %v", err)
	}

	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, name, provider, base_url, encrypted_api_key, models, enabled, created_at, updated_at FROM channels WHERE id = $1`)).
		WithArgs("channel-1").
		WillReturnError(sql.ErrNoRows)
	if _, err := store.GetChannelRuntime(ctx, "channel-1"); err != ErrChannelNotFound {
		t.Fatalf("expected ErrChannelNotFound after delete, got %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

	func TestPostgresStoreConversationLifecycle(t *testing.T) {
	store, mock, cleanup := newPostgresMockStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC()

	uploaded, err := store.SaveUploadedAttachment(ctx, UploadedFile{
		Name:     "spec.txt",
		MimeType: "text/plain",
		Size:     4,
		Reader:   bytes.NewBufferString("spec"),
	})
	if err != nil {
		t.Fatalf("SaveUploadedAttachment failed: %v", err)
	}
	if uploaded.Status != "ready" || uploaded.URL == "" {
		t.Fatalf("unexpected uploaded attachment: %+v", uploaded)
	}

	mock.ExpectQuery(regexp.QuoteMeta(`
		INSERT INTO chat_sessions (title, model_id, channel_id)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''))
		RETURNING id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at`)).
		WithArgs("Lifecycle", "model-test", "channel-test").
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "model_id", "channel_id", "pinned", "created_at", "updated_at"}).AddRow("conv-1", "Lifecycle", "model-test", "channel-test", false, now, now))

	conversation, err := store.CreateConversation(ctx, "Lifecycle", "model-test", "channel-test")
	if err != nil {
		t.Fatalf("CreateConversation failed: %v", err)
	}
	if conversation.ID != "conv-1" {
		t.Fatalf("unexpected conversation: %+v", conversation)
	}

	mock.ExpectQuery(regexp.QuoteMeta(`
		UPDATE chat_sessions
		SET title = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at`)).
		WithArgs("conv-1", "Renamed").
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "model_id", "channel_id", "pinned", "created_at", "updated_at"}).AddRow("conv-1", "Renamed", "model-test", "channel-test", false, now, now))
	if _, err := store.RenameConversation(ctx, "conv-1", "Renamed"); err != nil {
		t.Fatalf("RenameConversation failed: %v", err)
	}

	mock.ExpectQuery(regexp.QuoteMeta(`
		UPDATE chat_sessions
		SET pinned = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at`)).
		WithArgs("conv-1", true).
		WillReturnRows(sqlmock.NewRows([]string{"id", "title", "model_id", "channel_id", "pinned", "created_at", "updated_at"}).AddRow("conv-1", "Renamed", "model-test", "channel-test", true, now, now))
	pinned, err := store.SetConversationPinned(ctx, "conv-1", true)
	if err != nil {
		t.Fatalf("SetConversationPinned failed: %v", err)
	}
	if !pinned.Pinned {
		t.Fatal("expected pinned conversation")
	}

	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM chat_sessions WHERE id = $1`)).WithArgs("conv-1").WillReturnResult(sqlmock.NewResult(0, 1))
	if err := store.DeleteConversation(ctx, "conv-1"); err != nil {
		t.Fatalf("DeleteConversation failed: %v", err)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}

func TestPostgresStoreMessageOperationsAndAdvancedFields(t *testing.T) {
	store, mock, cleanup := newPostgresMockStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC()
	userTime := now
	assistantTime := now.Add(time.Millisecond)
	attachments := []Attachment{{ID: "att-1", Name: "spec.txt", MimeType: "text/plain", Size: 12, URL: "https://example.invalid/spec.txt", Status: "ready"}}
	toolInvocation := &ToolInvocation{ID: "tool-1", Name: "grep", Status: "success", Input: "foo"}
	toolResult := &ToolResult{InvocationID: "tool-1", Name: "grep", Status: "success", Output: "bar"}
	divider := &ContextDivider{ID: "msg-divider", Title: "Before", Content: "divider body"}

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_messages (id, conversation_id, role, content, created_at, status, kind, attachments, tool_invocation, tool_result, context_divider) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11)`)).
		WithArgs(sqlmock.AnyArg(), "conv-1", "user", "hello", sqlmock.AnyArg(), "done", "", attachmentJSON(t, attachments), []byte("null"), []byte("null"), []byte("null")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_messages (id, conversation_id, role, content, created_at, status, kind, attachments, tool_invocation, tool_result, context_divider) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11)`)).
		WithArgs(sqlmock.AnyArg(), "conv-1", "assistant", "world", sqlmock.AnyArg(), "done", "tool_result", attachmentJSON(t, nil), toolInvocationJSON(t, toolInvocation), toolResultJSON(t, toolResult), []byte("null")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_sessions SET updated_at = $2, title = CASE WHEN title = '新对话' THEN $3 ELSE title END WHERE id = $1`)).WithArgs("conv-1", sqlmock.AnyArg(), "hello").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	created, err := store.AppendMessagePair(ctx, "conv-1",
		MessageCreateInput{Role: "user", Content: "hello", Status: "done", Attachments: attachments},
		MessageCreateInput{Role: "assistant", Content: "world", Status: "done", Kind: "tool_result", ToolInvocation: toolInvocation, ToolResult: toolResult},
	)
	if err != nil {
		t.Fatalf("AppendMessagePair failed: %v", err)
	}
	if len(created) != 2 || len(created[0].Attachments) != 1 || created[1].ToolResult == nil || created[1].ToolResult.Output != "bar" {
		t.Fatalf("unexpected created messages: %+v", created)
	}

	messagesQuery := regexp.QuoteMeta(`
		SELECT id, conversation_id, role, content, created_at, COALESCE(status, ''), COALESCE(kind, ''), attachments, tool_invocation, tool_result, context_divider
		FROM chat_messages
		WHERE conversation_id = $1
		ORDER BY created_at ASC
		LIMIT $2 OFFSET $3`)
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_messages SET content = $3, context_divider = CASE WHEN kind = 'context_divider' THEN jsonb_set(COALESCE(context_divider, '{}'::jsonb), '{content}', to_jsonb($3::text), true) ELSE context_divider END WHERE conversation_id = $1 AND id = $2`)).WithArgs("conv-1", "msg-user", "edited").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`)).WithArgs("conv-1").WillReturnResult(sqlmock.NewResult(0, 1))
	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1`)).WithArgs("conv-1").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(3))
	mock.ExpectQuery(messagesQuery).WithArgs("conv-1", 50, 0).WillReturnRows(sqlmock.NewRows([]string{"id", "conversation_id", "role", "content", "created_at", "status", "kind", "attachments", "tool_invocation", "tool_result", "context_divider"}).
		AddRow("msg-user", "conv-1", "user", "edited", userTime, "done", "", attachmentJSON(t, attachments), nil, nil, nil).
		AddRow("msg-assistant", "conv-1", "assistant", "world", assistantTime, "done", "tool_result", attachmentJSON(t, nil), toolInvocationJSON(t, toolInvocation), toolResultJSON(t, toolResult), nil).
		AddRow("msg-divider", "conv-1", "system", "divider body", assistantTime.Add(time.Millisecond), "done", "context_divider", attachmentJSON(t, nil), nil, nil, contextDividerJSON(t, divider)))
	edited, err := store.EditMessage(ctx, "conv-1", "msg-user", "edited")
	if err != nil {
		t.Fatalf("EditMessage failed: %v", err)
	}
	if edited[0].Content != "edited" {
		t.Fatalf("unexpected edited messages: %+v", edited)
	}

	mock.ExpectQuery(regexp.QuoteMeta(`SELECT content FROM chat_messages WHERE conversation_id = $1 AND id = $2 AND role = 'user'`)).WithArgs("conv-1", "msg-user").WillReturnRows(sqlmock.NewRows([]string{"content"}).AddRow("edited"))
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_messages (id, conversation_id, role, content, created_at, status, kind, attachments, tool_invocation, tool_result, context_divider) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11)`)).
		WithArgs(sqlmock.AnyArg(), "conv-1", "user", "edited", sqlmock.AnyArg(), "done", "", attachmentJSON(t, nil), []byte("null"), []byte("null"), []byte("null")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO chat_messages (id, conversation_id, role, content, created_at, status, kind, attachments, tool_invocation, tool_result, context_divider) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11)`)).
		WithArgs(sqlmock.AnyArg(), "conv-1", "assistant", "这是 Go server 的最小非流式重发占位回复。", sqlmock.AnyArg(), "done", "", attachmentJSON(t, nil), []byte("null"), []byte("null"), []byte("null")).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_sessions SET updated_at = $2, title = CASE WHEN title = '新对话' THEN $3 ELSE title END WHERE id = $1`)).WithArgs("conv-1", sqlmock.AnyArg(), "edited").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	resent, err := store.ResendMessage(ctx, "conv-1", "msg-user")
	if err != nil {
		t.Fatalf("ResendMessage failed: %v", err)
	}
	if len(resent) != 2 || resent[0].Content != "edited" {
		t.Fatalf("unexpected resent messages: %+v", resent)
	}

	mock.ExpectQuery(regexp.QuoteMeta(`SELECT created_at FROM chat_messages WHERE conversation_id = $1 AND id = $2`)).WithArgs("conv-1", "msg-assistant").WillReturnRows(sqlmock.NewRows([]string{"created_at"}).AddRow(assistantTime))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM chat_messages WHERE conversation_id = $1 AND created_at >= $2`)).WithArgs("conv-1", assistantTime).WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`)).WithArgs("conv-1").WillReturnResult(sqlmock.NewResult(0, 1))
	expectEnsureSeed(mock)
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1`)).WithArgs("conv-1").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery(messagesQuery).WithArgs("conv-1", 50, 0).WillReturnRows(sqlmock.NewRows([]string{"id", "conversation_id", "role", "content", "created_at", "status", "kind", "attachments", "tool_invocation", "tool_result", "context_divider"}).
		AddRow("msg-user", "conv-1", "user", "edited", userTime, "done", "", attachmentJSON(t, attachments), nil, nil, nil))
	truncated, err := store.TruncateMessages(ctx, "conv-1", "msg-assistant")
	if err != nil {
		t.Fatalf("TruncateMessages failed: %v", err)
	}
	if truncated.Total != 1 || len(truncated.Messages) != 1 {
		t.Fatalf("unexpected truncated result: %+v", truncated)
	}

	updatedDivider := &ContextDivider{ID: "msg-divider", Title: "After", Content: "updated body"}
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_messages SET content = $4, context_divider = $5, kind = 'context_divider' WHERE conversation_id = $1 AND id = $2 AND kind = 'context_divider'`)).
		WithArgs("conv-1", "msg-divider", "After", "updated body", contextDividerJSON(t, updatedDivider)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`)).WithArgs("conv-1").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id, conversation_id, role, content, created_at, COALESCE(status, ''), COALESCE(kind, ''), attachments, tool_invocation, tool_result, context_divider FROM chat_messages WHERE conversation_id = $1 AND id = $2`)).
		WithArgs("conv-1", "msg-divider").
		WillReturnRows(sqlmock.NewRows([]string{"id", "conversation_id", "role", "content", "created_at", "status", "kind", "attachments", "tool_invocation", "tool_result", "context_divider"}).
			AddRow("msg-divider", "conv-1", "system", "updated body", assistantTime.Add(time.Millisecond), "done", "context_divider", attachmentJSON(t, nil), nil, nil, contextDividerJSON(t, updatedDivider)))
	dividerMessage, err := store.UpdateContextDivider(ctx, "conv-1", "msg-divider", "After", "updated body")
	if err != nil {
		t.Fatalf("UpdateContextDivider failed: %v", err)
	}
	if dividerMessage.ContextDivider == nil || dividerMessage.ContextDivider.Title != "After" {
		t.Fatalf("unexpected divider message: %+v", dividerMessage)
	}

	expectEnsureSeed(mock)
	expectConversationExists(mock, "conv-1")
	chunks, err := store.BuildStreamingReply(ctx, "conv-1", "ping")
	if err != nil {
		t.Fatalf("BuildStreamingReply failed: %v", err)
	}
	if len(chunks) == 0 || chunks[len(chunks)-1].Status != "done" {
		t.Fatalf("unexpected stream chunks: %+v", chunks)
	}

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet expectations: %v", err)
	}
}
