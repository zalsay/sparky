package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type PostgresStore struct {
	db *sql.DB
}

func NewPostgresStore(db *sql.DB) *PostgresStore {
	return &PostgresStore{db: db}
}

func (s *PostgresStore) ensureSchema(ctx context.Context) error {
	statements := []string{
		`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_channel_id TEXT`,
		`ALTER TABLE settings ADD COLUMN IF NOT EXISTS agent_model_id TEXT`,
		`CREATE TABLE IF NOT EXISTS channels (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT NOT NULL,
			base_url TEXT NOT NULL,
			encrypted_api_key TEXT NOT NULL DEFAULT '',
			models JSONB NOT NULL DEFAULT '[]'::jsonb,
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS model_id TEXT`,
		`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS channel_id TEXT`,
		`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS status TEXT`,
		`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT`,
		`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`,
		`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_invocation JSONB`,
		`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_result JSONB`,
		`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS context_divider JSONB`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *PostgresStore) ensureSeed(ctx context.Context) error {
	if err := s.ensureSchema(ctx); err != nil {
		return err
	}

	const insertSettings = `
		INSERT INTO settings (id, theme_mode, onboarding_completed, environment_check_skipped, notifications_enabled)
		VALUES (TRUE, 'system', TRUE, FALSE, TRUE)
		ON CONFLICT (id) DO NOTHING`
	if _, err := s.db.ExecContext(ctx, insertSettings); err != nil {
		return err
	}

	const countChannels = `SELECT COUNT(*) FROM channels`
	var channelCount int
	if err := s.db.QueryRowContext(ctx, countChannels).Scan(&channelCount); err != nil {
		return err
	}
	if channelCount == 0 {
		defaultModels, _ := json.Marshal([]ChannelModel{{ID: "claude-opus-4-6", Name: "Claude Opus 4.6", Enabled: true}})
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO channels (id, name, provider, base_url, encrypted_api_key, models, enabled)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, uuid.NewString(), "Default Anthropic", "anthropic", "https://api.anthropic.com", encryptAPIKey("test-anthropic-key"), defaultModels, true); err != nil {
			return err
		}
	}

	const countWorkspaces = `SELECT COUNT(*) FROM workspaces`
	var workspaceCount int
	if err := s.db.QueryRowContext(ctx, countWorkspaces).Scan(&workspaceCount); err != nil {
		return err
	}
	if workspaceCount == 0 {
		if _, err := s.db.ExecContext(ctx, `INSERT INTO workspaces (name, root_path) VALUES ($1, $2)`, "Proma", "/Volumes/RC500/cib/Proma"); err != nil {
			return err
		}
	}

	const countConversations = `SELECT COUNT(*) FROM chat_sessions`
	var sessionCount int
	if err := s.db.QueryRowContext(ctx, countConversations).Scan(&sessionCount); err != nil {
		return err
	}
	if sessionCount == 0 {
		conversationID := uuid.NewString()
		if _, err := s.db.ExecContext(ctx, `INSERT INTO chat_sessions (id, title) VALUES ($1, $2)`, conversationID, "欢迎使用 Sparky Web"); err != nil {
			return err
		}
		dividerID := uuid.NewString()
		divider, _ := json.Marshal(ContextDivider{ID: dividerID, Title: "会话开始", Content: "欢迎进入 Proma Web 对话上下文。"})
		if _, err := s.db.ExecContext(ctx, `INSERT INTO chat_messages (id, conversation_id, role, content, kind, context_divider, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`, dividerID, conversationID, "system", "欢迎进入 Proma Web 对话上下文。", "context_divider", divider, "done"); err != nil {
			return err
		}
		toolInvocation, _ := json.Marshal(ToolInvocation{ID: uuid.NewString(), Name: "bootstrap-check", Status: "success", Input: "runtime"})
		toolResult, _ := json.Marshal(ToolResult{Name: "bootstrap-check", Status: "success", Output: "已完成初始化检查。"})
		if _, err := s.db.ExecContext(ctx, `INSERT INTO chat_messages (conversation_id, role, content, kind, tool_invocation, tool_result, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`, conversationID, "system", "已完成初始化检查。", "tool_result", toolInvocation, toolResult, "done"); err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx, `INSERT INTO chat_messages (conversation_id, role, content, status) VALUES ($1, $2, $3, $4)`, conversationID, "assistant", "Sparky Web 已连接到 PostgreSQL-backed Go server。", "done"); err != nil {
			return err
		}
	}

	return nil
}

func (s *PostgresStore) GetSettings(ctx context.Context) (Settings, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return Settings{}, err
	}
	const query = `
		SELECT theme_mode, onboarding_completed, environment_check_skipped, notifications_enabled,
		       COALESCE(agent_channel_id, ''), COALESCE(agent_model_id, '')
		FROM settings WHERE id = TRUE`
	var out Settings
	if err := s.db.QueryRowContext(ctx, query).Scan(
		&out.ThemeMode,
		&out.OnboardingCompleted,
		&out.EnvironmentCheckSkipped,
		&out.NotificationsEnabled,
		&out.AgentChannelID,
		&out.AgentModelID,
	); err != nil {
		return Settings{}, err
	}
	return out, nil
}

func (s *PostgresStore) UpdateSettings(ctx context.Context, updates Settings) (Settings, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return Settings{}, err
	}
	const query = `
		UPDATE settings
		SET theme_mode = $1,
		    onboarding_completed = $2,
		    environment_check_skipped = $3,
		    notifications_enabled = $4,
		    agent_channel_id = NULLIF($5, ''),
		    agent_model_id = NULLIF($6, ''),
		    updated_at = NOW()
		WHERE id = TRUE`
	_, err := s.db.ExecContext(ctx, query,
		updates.ThemeMode,
		updates.OnboardingCompleted,
		updates.EnvironmentCheckSkipped,
		updates.NotificationsEnabled,
		updates.AgentChannelID,
		updates.AgentModelID,
	)
	if err != nil {
		return Settings{}, err
	}
	return s.GetSettings(ctx)
}

func (s *PostgresStore) ListChannels(ctx context.Context) ([]Channel, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, provider, base_url, models, enabled, created_at, updated_at FROM channels ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []Channel{}
	for rows.Next() {
		item, err := scanChannel(rows, false)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CreateChannel(ctx context.Context, input ChannelCreateInput) (Channel, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return Channel{}, err
	}
	modelsJSON, err := json.Marshal(input.Models)
	if err != nil {
		return Channel{}, err
	}
	const query = `
		INSERT INTO channels (id, name, provider, base_url, encrypted_api_key, models, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, name, provider, base_url, models, enabled, created_at, updated_at`
	row := s.db.QueryRowContext(ctx, query,
		uuid.NewString(),
		strings.TrimSpace(input.Name),
		strings.TrimSpace(input.Provider),
		strings.TrimSpace(input.BaseURL),
		encryptAPIKey(input.APIKey),
		modelsJSON,
		input.Enabled,
	)
	return scanChannel(row, false)
}

func (s *PostgresStore) UpdateChannel(ctx context.Context, channelID string, input ChannelUpdateInput) (Channel, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return Channel{}, err
	}
	current, err := s.GetChannelRuntime(ctx, channelID)
	if err != nil {
		return Channel{}, err
	}

	name := current.Name
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
	}
	provider := current.Provider
	if input.Provider != nil {
		provider = strings.TrimSpace(*input.Provider)
	}
	baseURL := current.BaseURL
	if input.BaseURL != nil {
		baseURL = strings.TrimSpace(*input.BaseURL)
	}
	encryptedAPIKey := current.EncryptedAPIKey
	if input.APIKey != nil && strings.TrimSpace(*input.APIKey) != "" {
		encryptedAPIKey = encryptAPIKey(*input.APIKey)
	}
	models := current.Models
	if input.Models != nil {
		models = append([]ChannelModel(nil), input.Models...)
	}
	enabled := current.Enabled
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	modelsJSON, err := json.Marshal(models)
	if err != nil {
		return Channel{}, err
	}

	const query = `
		UPDATE channels
		SET name = $2,
		    provider = $3,
		    base_url = $4,
		    encrypted_api_key = $5,
		    models = $6,
		    enabled = $7,
		    updated_at = NOW()
		WHERE id = $1
		RETURNING id, name, provider, base_url, models, enabled, created_at, updated_at`
	row := s.db.QueryRowContext(ctx, query, channelID, name, provider, baseURL, encryptedAPIKey, modelsJSON, enabled)
	item, err := scanChannel(row, false)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Channel{}, ErrChannelNotFound
		}
		return Channel{}, err
	}
	return item, nil
}

func (s *PostgresStore) DeleteChannel(ctx context.Context, channelID string) error {
	if err := s.ensureSeed(ctx); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM channels WHERE id = $1`, channelID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrChannelNotFound
	}
	return nil
}

func (s *PostgresStore) GetChannelRuntime(ctx context.Context, channelID string) (Channel, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return Channel{}, err
	}
	const query = `SELECT id, name, provider, base_url, encrypted_api_key, models, enabled, created_at, updated_at FROM channels WHERE id = $1`
	item, err := scanChannel(s.db.QueryRowContext(ctx, query, channelID), true)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Channel{}, ErrChannelNotFound
		}
		return Channel{}, err
	}
	return item, nil
}

func scanChannel(scanner interface{ Scan(dest ...any) error }, includeSecret bool) (Channel, error) {
	var item Channel
	var modelsRaw []byte
	if includeSecret {
		if err := scanner.Scan(&item.ID, &item.Name, &item.Provider, &item.BaseURL, &item.EncryptedAPIKey, &modelsRaw, &item.Enabled, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return Channel{}, err
		}
	} else {
		if err := scanner.Scan(&item.ID, &item.Name, &item.Provider, &item.BaseURL, &modelsRaw, &item.Enabled, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return Channel{}, err
		}
	}
	if len(modelsRaw) > 0 {
		if err := json.Unmarshal(modelsRaw, &item.Models); err != nil {
			return Channel{}, err
		}
	}
	if includeSecret {
		item.APIKey = decryptAPIKey(item.EncryptedAPIKey)
		item.Models = append([]ChannelModel(nil), item.Models...)
		return item, nil
	}
	return sanitizeChannel(item), nil
}

func (s *PostgresStore) ListWorkspaces(ctx context.Context) ([]Workspace, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, root_path, created_at, updated_at, last_opened_at FROM workspaces ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []Workspace{}
	for rows.Next() {
		var item Workspace
		if err := rows.Scan(&item.ID, &item.Name, &item.RootPath, &item.CreatedAt, &item.UpdatedAt, &item.LastOpenedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CreateWorkspace(ctx context.Context, name, rootPath string) (Workspace, error) {
	const query = `INSERT INTO workspaces (name, root_path) VALUES ($1, $2) RETURNING id, name, root_path, created_at, updated_at, last_opened_at`
	var item Workspace
	if err := s.db.QueryRowContext(ctx, query, name, rootPath).Scan(&item.ID, &item.Name, &item.RootPath, &item.CreatedAt, &item.UpdatedAt, &item.LastOpenedAt); err != nil {
		return Workspace{}, err
	}
	return item, nil
}

func (s *PostgresStore) ListConversations(ctx context.Context) ([]Conversation, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at FROM chat_sessions ORDER BY pinned DESC, updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []Conversation{}
	for rows.Next() {
		var item Conversation
		if err := rows.Scan(&item.ID, &item.Title, &item.ModelID, &item.ChannelID, &item.Pinned, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *PostgresStore) CreateConversation(ctx context.Context, title, modelID, channelID string) (Conversation, error) {
	if strings.TrimSpace(title) == "" {
		title = "新对话"
	}
	const query = `
		INSERT INTO chat_sessions (title, model_id, channel_id)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''))
		RETURNING id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at`
	var item Conversation
	if err := s.db.QueryRowContext(ctx, query, title, modelID, channelID).Scan(&item.ID, &item.Title, &item.ModelID, &item.ChannelID, &item.Pinned, &item.CreatedAt, &item.UpdatedAt); err != nil {
		return Conversation{}, err
	}
	return item, nil
}

func (s *PostgresStore) RenameConversation(ctx context.Context, conversationID, title string) (Conversation, error) {
	const query = `
		UPDATE chat_sessions
		SET title = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at`
	var item Conversation
	if err := s.db.QueryRowContext(ctx, query, conversationID, strings.TrimSpace(title)).Scan(&item.ID, &item.Title, &item.ModelID, &item.ChannelID, &item.Pinned, &item.CreatedAt, &item.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Conversation{}, errConversationNotFound
		}
		return Conversation{}, err
	}
	return item, nil
}

func (s *PostgresStore) DeleteConversation(ctx context.Context, conversationID string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM chat_sessions WHERE id = $1`, conversationID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return errConversationNotFound
	}
	return nil
}

func (s *PostgresStore) SetConversationPinned(ctx context.Context, conversationID string, pinned bool) (Conversation, error) {
	const query = `
		UPDATE chat_sessions
		SET pinned = $2, updated_at = NOW()
		WHERE id = $1
		RETURNING id, title, COALESCE(model_id, ''), COALESCE(channel_id, ''), COALESCE(pinned, FALSE), created_at, updated_at`
	var item Conversation
	if err := s.db.QueryRowContext(ctx, query, conversationID, pinned).Scan(&item.ID, &item.Title, &item.ModelID, &item.ChannelID, &item.Pinned, &item.CreatedAt, &item.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Conversation{}, errConversationNotFound
		}
		return Conversation{}, err
	}
	return item, nil
}

func (s *PostgresStore) GetConversationMessages(ctx context.Context, conversationID string, limit int, beforeMessageID string) (ConversationMessagesResult, error) {
	if limit <= 0 {
		limit = 50
	}
	if err := s.ensureSeed(ctx); err != nil {
		return ConversationMessagesResult{}, err
	}
	args := []any{conversationID}
	countQuery := `SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1`
	filterClause := ""
	if beforeMessageID != "" {
		filterClause = ` AND created_at < (SELECT created_at FROM chat_messages WHERE id = $2 AND conversation_id = $1)`
		countQuery += filterClause
		args = append(args, beforeMessageID)
	}
	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return ConversationMessagesResult{}, err
	}
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, limit, max(total-limit, 0))
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, conversation_id, role, content, created_at, COALESCE(status, ''), COALESCE(kind, ''), attachments, tool_invocation, tool_result, context_divider
		FROM chat_messages
		WHERE conversation_id = $1`+filterClause+`
		ORDER BY created_at ASC
		LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2), queryArgs...)
	if err != nil {
		return ConversationMessagesResult{}, err
	}
	defer rows.Close()

	items := []Message{}
	for rows.Next() {
		item, err := scanMessage(rows)
		if err != nil {
			return ConversationMessagesResult{}, err
		}
		items = append(items, item)
	}
	return ConversationMessagesResult{Messages: items, HasMore: total > limit, Total: total}, rows.Err()
}

func (s *PostgresStore) AppendUserAndAssistantMessage(ctx context.Context, conversationID, userContent, assistantContent string) ([]Message, error) {
	return s.AppendMessagePair(ctx, conversationID,
		MessageCreateInput{Role: "user", Content: userContent, Status: "done"},
		MessageCreateInput{Role: "assistant", Content: assistantContent, Status: "done"},
	)
}

func (s *PostgresStore) AppendMessagePair(ctx context.Context, conversationID string, userInput MessageCreateInput, assistantInput MessageCreateInput) ([]Message, error) {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = transaction.Rollback() }()

	now := time.Now().UTC()
	created := []Message{
		makeMessage(conversationID, userInput, now),
		makeMessage(conversationID, assistantInput, now.Add(time.Millisecond)),
	}
	for _, item := range created {
		if err := insertMessage(ctx, transaction, item); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, errConversationNotFound
			}
			return nil, err
		}
	}
	if err := updateConversationMetadata(ctx, transaction, conversationID, created[0].Content, now); err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	return created, nil
}

func (s *PostgresStore) EditMessage(ctx context.Context, conversationID, messageID, content string) ([]Message, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE chat_messages SET content = $3, context_divider = CASE WHEN kind = 'context_divider' THEN jsonb_set(COALESCE(context_divider, '{}'::jsonb), '{content}', to_jsonb($3::text), true) ELSE context_divider END WHERE conversation_id = $1 AND id = $2`, conversationID, messageID, content)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, errMessageNotFound
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`, conversationID); err != nil {
		return nil, err
	}
	messages, err := s.GetConversationMessages(ctx, conversationID, 50, "")
	if err != nil {
		return nil, err
	}
	return messages.Messages, nil
}

func (s *PostgresStore) ResendMessage(ctx context.Context, conversationID, messageID string) ([]Message, error) {
	var content string
	if err := s.db.QueryRowContext(ctx, `SELECT content FROM chat_messages WHERE conversation_id = $1 AND id = $2 AND role = 'user'`, conversationID, messageID).Scan(&content); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errMessageNotFound
		}
		return nil, err
	}
	return s.AppendUserAndAssistantMessage(ctx, conversationID, content, "这是 Go server 的最小非流式重发占位回复。")
}

func (s *PostgresStore) TruncateMessages(ctx context.Context, conversationID, messageID string) (ConversationMessagesResult, error) {
	var createdAt time.Time
	if err := s.db.QueryRowContext(ctx, `SELECT created_at FROM chat_messages WHERE conversation_id = $1 AND id = $2`, conversationID, messageID).Scan(&createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ConversationMessagesResult{}, errMessageNotFound
		}
		return ConversationMessagesResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM chat_messages WHERE conversation_id = $1 AND created_at >= $2`, conversationID, createdAt); err != nil {
		return ConversationMessagesResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`, conversationID); err != nil {
		return ConversationMessagesResult{}, err
	}
	return s.GetConversationMessages(ctx, conversationID, 50, "")
}

func (s *PostgresStore) UpdateContextDivider(ctx context.Context, conversationID, messageID, title, content string) (Message, error) {
	payload, err := json.Marshal(ContextDivider{ID: messageID, Title: title, Content: content})
	if err != nil {
		return Message{}, err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE chat_messages SET content = $4, context_divider = $5, kind = 'context_divider' WHERE conversation_id = $1 AND id = $2 AND kind = 'context_divider'`, conversationID, messageID, title, content, payload)
	if err != nil {
		return Message{}, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return Message{}, err
	}
	if count == 0 {
		return Message{}, errMessageNotFound
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`, conversationID); err != nil {
		return Message{}, err
	}
	row := s.db.QueryRowContext(ctx, `SELECT id, conversation_id, role, content, created_at, COALESCE(status, ''), COALESCE(kind, ''), attachments, tool_invocation, tool_result, context_divider FROM chat_messages WHERE conversation_id = $1 AND id = $2`, conversationID, messageID)
	return scanMessage(row)
}

func (s *PostgresStore) BuildStreamingReply(ctx context.Context, conversationID, userContent string) ([]StreamChunk, error) {
	if err := s.ensureSeed(ctx); err != nil {
		return nil, err
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id = $1)`, conversationID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, errConversationNotFound
	}
	trimmed := strings.TrimSpace(userContent)
	if trimmed == "" {
		trimmed = "空消息"
	}
	chunks := []string{"正在通过 Go server streaming 返回占位回复。", "\n\n", "你发送的是：", trimmed}
	result := make([]StreamChunk, 0, len(chunks))
	for i, chunk := range chunks {
		status := "partial"
		if i == len(chunks)-1 {
			status = "done"
		}
		result = append(result, StreamChunk{Content: chunk, Status: status})
	}
	return result, nil
}

func (s *PostgresStore) SaveUploadedAttachment(_ context.Context, file UploadedFile) (Attachment, error) {
	_, _ = io.Copy(io.Discard, file.Reader)
	id := uuid.NewString()
	return Attachment{
		ID:       id,
		Name:     file.Name,
		MimeType: file.MimeType,
		Size:     file.Size,
		URL:      "/uploads/" + id + "-" + file.Name,
		Status:   "ready",
	}, nil
}

func insertMessage(ctx context.Context, tx *sql.Tx, item Message) error {
	attachmentsJSON, err := json.Marshal(item.Attachments)
	if err != nil {
		return err
	}
	toolInvocationJSON, err := nullableJSON(item.ToolInvocation)
	if err != nil {
		return err
	}
	toolResultJSON, err := nullableJSON(item.ToolResult)
	if err != nil {
		return err
	}
	contextDividerJSON, err := nullableJSON(item.ContextDivider)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO chat_messages (id, conversation_id, role, content, created_at, status, kind, attachments, tool_invocation, tool_result, context_divider) VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), $8, $9, $10, $11)`, item.ID, item.ConversationID, item.Role, item.Content, item.CreatedAt, item.Status, item.Kind, attachmentsJSON, toolInvocationJSON, toolResultJSON, contextDividerJSON)
	if err != nil {
		return err
	}
	if rows, err := result.RowsAffected(); err == nil && rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func updateConversationMetadata(ctx context.Context, tx *sql.Tx, conversationID, userContent string, now time.Time) error {
	title := ""
	if strings.TrimSpace(userContent) != "" {
		r := []rune(strings.TrimSpace(userContent))
		if len(r) > 20 {
			title = string(r[:20])
		} else {
			title = string(r)
		}
	}
	updateQuery := `UPDATE chat_sessions SET updated_at = $2 WHERE id = $1`
	args := []any{conversationID, now}
	if title != "" {
		updateQuery = `UPDATE chat_sessions SET updated_at = $2, title = CASE WHEN title = '新对话' THEN $3 ELSE title END WHERE id = $1`
		args = append(args, title)
	}
	result, err := tx.ExecContext(ctx, updateQuery, args...)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return errConversationNotFound
	}
	return nil
}

func nullableJSON(value any) ([]byte, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value)
}

type messageScanner interface {
	Scan(dest ...any) error
}

func scanMessage(scanner messageScanner) (Message, error) {
	var item Message
	var attachmentsJSON []byte
	var toolInvocationJSON []byte
	var toolResultJSON []byte
	var contextDividerJSON []byte
	if err := scanner.Scan(&item.ID, &item.ConversationID, &item.Role, &item.Content, &item.CreatedAt, &item.Status, &item.Kind, &attachmentsJSON, &toolInvocationJSON, &toolResultJSON, &contextDividerJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Message{}, errMessageNotFound
		}
		return Message{}, err
	}
	if len(attachmentsJSON) > 0 {
		_ = json.Unmarshal(attachmentsJSON, &item.Attachments)
	}
	if len(toolInvocationJSON) > 0 {
		item.ToolInvocation = &ToolInvocation{}
		_ = json.Unmarshal(toolInvocationJSON, item.ToolInvocation)
	}
	if len(toolResultJSON) > 0 {
		item.ToolResult = &ToolResult{}
		_ = json.Unmarshal(toolResultJSON, item.ToolResult)
	}
	if len(contextDividerJSON) > 0 {
		item.ContextDivider = &ContextDivider{}
		_ = json.Unmarshal(contextDividerJSON, item.ContextDivider)
	}
	return item, nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (s *PostgresStore) String() string {
	return fmt.Sprintf("PostgresStore{%p}", s.db)
}
