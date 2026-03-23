package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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

func (s *PostgresStore) ensureSeed(ctx context.Context) error {
	const insertSettings = `
		INSERT INTO settings (id, theme_mode, onboarding_completed, environment_check_skipped, notifications_enabled)
		VALUES (TRUE, 'system', TRUE, FALSE, TRUE)
		ON CONFLICT (id) DO NOTHING`
	if _, err := s.db.ExecContext(ctx, insertSettings); err != nil {
		return err
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
		if _, err := s.db.ExecContext(ctx, `INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1, $2, $3)`, conversationID, "assistant", "Sparky Web 已连接到 PostgreSQL-backed Go server。"); err != nil {
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
		SELECT id, conversation_id, role, content, created_at
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
		var item Message
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.Role, &item.Content, &item.CreatedAt); err != nil {
			return ConversationMessagesResult{}, err
		}
		items = append(items, item)
	}
	return ConversationMessagesResult{Messages: items, HasMore: total > limit, Total: total}, rows.Err()
}

func (s *PostgresStore) AppendUserAndAssistantMessage(ctx context.Context, conversationID, userContent, assistantContent string) ([]Message, error) {
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = transaction.Rollback() }()

	now := time.Now().UTC()
	created := []Message{
		{ID: uuid.NewString(), ConversationID: conversationID, Role: "user", Content: userContent, CreatedAt: now},
		{ID: uuid.NewString(), ConversationID: conversationID, Role: "assistant", Content: assistantContent, CreatedAt: now.Add(time.Millisecond)},
	}

	for _, item := range created {
		if _, err := transaction.ExecContext(ctx, `INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`, item.ID, item.ConversationID, item.Role, item.Content, item.CreatedAt); err != nil {
			return nil, err
		}
	}

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
	if _, err := transaction.ExecContext(ctx, updateQuery, args...); err != nil {
		return nil, err
	}

	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	return created, nil
}

func (s *PostgresStore) EditMessage(ctx context.Context, conversationID, messageID, content string) ([]Message, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE chat_messages SET content = $3 WHERE conversation_id = $1 AND id = $2`, conversationID, messageID, content)
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

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (s *PostgresStore) String() string {
	return fmt.Sprintf("PostgresStore{%p}", s.db)
}
