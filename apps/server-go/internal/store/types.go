package store

import (
	"context"
	"errors"
	"time"
)

var ErrConversationNotFound = errors.New("conversation not found")
var ErrMessageNotFound = errors.New("message not found")

type Settings struct {
	ThemeMode               string `json:"themeMode"`
	OnboardingCompleted     bool   `json:"onboardingCompleted"`
	EnvironmentCheckSkipped bool   `json:"environmentCheckSkipped"`
	NotificationsEnabled    bool   `json:"notificationsEnabled"`
	AgentChannelID          string `json:"agentChannelId,omitempty"`
	AgentModelID            string `json:"agentModelId,omitempty"`
}

type Workspace struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	RootPath     string     `json:"rootPath"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	LastOpenedAt *time.Time `json:"lastOpenedAt,omitempty"`
}

type Conversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	ModelID   string    `json:"modelId,omitempty"`
	ChannelID string    `json:"channelId,omitempty"`
	Pinned    bool      `json:"pinned,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Message struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversationId"`
	Role           string    `json:"role"`
	Content        string    `json:"content"`
	CreatedAt      time.Time `json:"createdAt"`
}

type ConversationMessagesResult struct {
	Messages []Message `json:"messages"`
	HasMore  bool      `json:"hasMore"`
	Total    int       `json:"total"`
}

type Store interface {
	GetSettings(ctx context.Context) (Settings, error)
	UpdateSettings(ctx context.Context, updates Settings) (Settings, error)
	ListWorkspaces(ctx context.Context) ([]Workspace, error)
	CreateWorkspace(ctx context.Context, name, rootPath string) (Workspace, error)
	ListConversations(ctx context.Context) ([]Conversation, error)
	CreateConversation(ctx context.Context, title, modelID, channelID string) (Conversation, error)
	RenameConversation(ctx context.Context, conversationID, title string) (Conversation, error)
	DeleteConversation(ctx context.Context, conversationID string) error
	SetConversationPinned(ctx context.Context, conversationID string, pinned bool) (Conversation, error)
	GetConversationMessages(ctx context.Context, conversationID string, limit int, beforeMessageID string) (ConversationMessagesResult, error)
	AppendUserAndAssistantMessage(ctx context.Context, conversationID, userContent, assistantContent string) ([]Message, error)
	EditMessage(ctx context.Context, conversationID, messageID, content string) ([]Message, error)
	ResendMessage(ctx context.Context, conversationID, messageID string) ([]Message, error)
	TruncateMessages(ctx context.Context, conversationID, messageID string) (ConversationMessagesResult, error)
}
