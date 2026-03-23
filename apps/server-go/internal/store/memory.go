package store

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
)

type MemoryStore struct {
	settings      Settings
	workspaces    []Workspace
	conversations []Conversation
	messages      map[string][]Message
}

func NewMemoryStore() *MemoryStore {
	now := time.Now().UTC()
	workspaceID := uuid.NewString()
	conversationID := uuid.NewString()

	welcomeMessages := []Message{
		{
			ID:             uuid.NewString(),
			ConversationID: conversationID,
			Role:           "assistant",
			Content:        "Sparky Web 已连接到 Go server。下一步可以逐步替换为真实 PostgreSQL 数据。",
			CreatedAt:      now,
		},
	}

	return &MemoryStore{
		settings: Settings{
			ThemeMode:               "system",
			OnboardingCompleted:     true,
			EnvironmentCheckSkipped: false,
			NotificationsEnabled:    true,
		},
		workspaces: []Workspace{
			{
				ID:        workspaceID,
				Name:      "Proma",
				RootPath:  "/Volumes/RC500/cib/Proma",
				CreatedAt: now,
				UpdatedAt: now,
			},
		},
		conversations: []Conversation{
			{
				ID:        conversationID,
				Title:     "欢迎使用 Sparky Web",
				CreatedAt: now,
				UpdatedAt: now,
			},
		},
		messages: map[string][]Message{
			conversationID: welcomeMessages,
		},
	}
}

func (s *MemoryStore) GetSettings(context.Context) (Settings, error) {
	return s.settings, nil
}

func (s *MemoryStore) UpdateSettings(_ context.Context, updates Settings) (Settings, error) {
	if updates.ThemeMode != "" {
		s.settings.ThemeMode = updates.ThemeMode
	}
	s.settings.OnboardingCompleted = updates.OnboardingCompleted
	s.settings.EnvironmentCheckSkipped = updates.EnvironmentCheckSkipped
	s.settings.NotificationsEnabled = updates.NotificationsEnabled
	s.settings.AgentChannelID = updates.AgentChannelID
	s.settings.AgentModelID = updates.AgentModelID
	return s.settings, nil
}

func (s *MemoryStore) ListWorkspaces(context.Context) ([]Workspace, error) {
	items := append([]Workspace(nil), s.workspaces...)
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	return items, nil
}

func (s *MemoryStore) CreateWorkspace(_ context.Context, name, rootPath string) (Workspace, error) {
	now := time.Now().UTC()
	item := Workspace{ID: uuid.NewString(), Name: name, RootPath: rootPath, CreatedAt: now, UpdatedAt: now}
	s.workspaces = append([]Workspace{item}, s.workspaces...)
	return item, nil
}

func (s *MemoryStore) ListConversations(context.Context) ([]Conversation, error) {
	items := append([]Conversation(nil), s.conversations...)
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt.After(items[j].UpdatedAt) })
	return items, nil
}

func (s *MemoryStore) CreateConversation(_ context.Context, title, modelID, channelID string) (Conversation, error) {
	now := time.Now().UTC()
	if title == "" {
		title = "新对话"
	}
	item := Conversation{ID: uuid.NewString(), Title: title, ModelID: modelID, ChannelID: channelID, CreatedAt: now, UpdatedAt: now}
	s.conversations = append([]Conversation{item}, s.conversations...)
	s.messages[item.ID] = []Message{}
	return item, nil
}

func (s *MemoryStore) GetConversationMessages(_ context.Context, conversationID string, limit int) (ConversationMessagesResult, error) {
	items := append([]Message(nil), s.messages[conversationID]...)
	total := len(items)
	if limit > 0 && total > limit {
		items = items[total-limit:]
		return ConversationMessagesResult{Messages: items, HasMore: true, Total: total}, nil
	}
	return ConversationMessagesResult{Messages: items, HasMore: false, Total: total}, nil
}

func (s *MemoryStore) AppendUserAndAssistantMessage(_ context.Context, conversationID, userContent, assistantContent string) ([]Message, error) {
	now := time.Now().UTC()
	created := []Message{
		{ID: uuid.NewString(), ConversationID: conversationID, Role: "user", Content: userContent, CreatedAt: now},
		{ID: uuid.NewString(), ConversationID: conversationID, Role: "assistant", Content: assistantContent, CreatedAt: now.Add(time.Millisecond)},
	}
	s.messages[conversationID] = append(s.messages[conversationID], created...)
	for i := range s.conversations {
		if s.conversations[i].ID == conversationID {
			s.conversations[i].UpdatedAt = now
			if s.conversations[i].Title == "新对话" && userContent != "" {
				r := []rune(userContent)
				if len(r) > 20 {
					s.conversations[i].Title = string(r[:20])
				} else {
					s.conversations[i].Title = userContent
				}
			}
			break
		}
	}
	return created, nil
}
