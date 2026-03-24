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

type Attachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
	URL      string `json:"url,omitempty"`
	Status   string `json:"status,omitempty"`
}

type ToolInvocation struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status,omitempty"`
	Input  string `json:"input,omitempty"`
}

type ToolResult struct {
	InvocationID string `json:"invocationId,omitempty"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	Output       string `json:"output"`
}

type ContextDivider struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Content string `json:"content,omitempty"`
}

type Message struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	Role           string          `json:"role"`
	Content        string          `json:"content"`
	CreatedAt      time.Time       `json:"createdAt"`
	Status         string          `json:"status,omitempty"`
	Kind           string          `json:"kind,omitempty"`
	Attachments    []Attachment    `json:"attachments,omitempty"`
	ToolInvocation *ToolInvocation `json:"toolInvocation,omitempty"`
	ToolResult     *ToolResult     `json:"toolResult,omitempty"`
	ContextDivider *ContextDivider `json:"contextDivider,omitempty"`
}

type MessageCreateInput struct {
	Role           string
	Content        string
	Status         string
	Kind           string
	Attachments    []Attachment
	ToolInvocation *ToolInvocation
	ToolResult     *ToolResult
	ContextDivider *ContextDivider
	CreatedAt      time.Time
}

type StreamChunk struct {
	Content string `json:"content"`
	Status  string `json:"status"`
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
	AppendMessagePair(ctx context.Context, conversationID string, user MessageCreateInput, assistant MessageCreateInput) ([]Message, error)
	AppendUserAndAssistantMessage(ctx context.Context, conversationID, userContent, assistantContent string) ([]Message, error)
	EditMessage(ctx context.Context, conversationID, messageID, content string) ([]Message, error)
	ResendMessage(ctx context.Context, conversationID, messageID string) ([]Message, error)
	TruncateMessages(ctx context.Context, conversationID, messageID string) (ConversationMessagesResult, error)
	UpdateContextDivider(ctx context.Context, conversationID, messageID, title, content string) (Message, error)
	BuildStreamingReply(ctx context.Context, conversationID, userContent string) ([]StreamChunk, error)
}
