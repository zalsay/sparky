package store

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

var errConversationNotFound = ErrConversationNotFound
var errMessageNotFound = ErrMessageNotFound

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
	sort.Slice(items, func(i, j int) bool {
		if items[i].Pinned != items[j].Pinned {
			return items[i].Pinned
		}
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
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

func (s *MemoryStore) RenameConversation(_ context.Context, conversationID, title string) (Conversation, error) {
	for i := range s.conversations {
		if s.conversations[i].ID == conversationID {
			s.conversations[i].Title = strings.TrimSpace(title)
			s.conversations[i].UpdatedAt = time.Now().UTC()
			return s.conversations[i], nil
		}
	}
	return Conversation{}, errConversationNotFound
}

func (s *MemoryStore) DeleteConversation(_ context.Context, conversationID string) error {
	for i := range s.conversations {
		if s.conversations[i].ID == conversationID {
			s.conversations = append(s.conversations[:i], s.conversations[i+1:]...)
			delete(s.messages, conversationID)
			return nil
		}
	}
	return errConversationNotFound
}

func (s *MemoryStore) SetConversationPinned(_ context.Context, conversationID string, pinned bool) (Conversation, error) {
	for i := range s.conversations {
		if s.conversations[i].ID == conversationID {
			s.conversations[i].Pinned = pinned
			s.conversations[i].UpdatedAt = time.Now().UTC()
			return s.conversations[i], nil
		}
	}
	return Conversation{}, errConversationNotFound
}

func (s *MemoryStore) GetConversationMessages(_ context.Context, conversationID string, limit int, beforeMessageID string) (ConversationMessagesResult, error) {
	items, ok := s.messages[conversationID]
	if !ok {
		return ConversationMessagesResult{}, errConversationNotFound
	}
	filtered := append([]Message(nil), items...)
	if beforeMessageID != "" {
		index := -1
		for i := range filtered {
			if filtered[i].ID == beforeMessageID {
				index = i
				break
			}
		}
		if index == -1 {
			return ConversationMessagesResult{}, errMessageNotFound
		}
		filtered = filtered[:index]
	}
	total := len(filtered)
	if limit > 0 && total > limit {
		filtered = filtered[total-limit:]
		return ConversationMessagesResult{Messages: filtered, HasMore: true, Total: total}, nil
	}
	return ConversationMessagesResult{Messages: filtered, HasMore: false, Total: total}, nil
}

func (s *MemoryStore) AppendUserAndAssistantMessage(_ context.Context, conversationID, userContent, assistantContent string) ([]Message, error) {
	if _, ok := s.messages[conversationID]; !ok {
		return nil, errConversationNotFound
	}
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

func (s *MemoryStore) EditMessage(_ context.Context, conversationID, messageID, content string) ([]Message, error) {
	items, ok := s.messages[conversationID]
	if !ok {
		return nil, errConversationNotFound
	}
	for i := range items {
		if items[i].ID == messageID {
			items[i].Content = content
			items[i].CreatedAt = time.Now().UTC()
			s.messages[conversationID] = items
			s.bumpConversation(conversationID)
			return append([]Message(nil), items...), nil
		}
	}
	return nil, errMessageNotFound
}

func (s *MemoryStore) ResendMessage(ctx context.Context, conversationID, messageID string) ([]Message, error) {
	items, ok := s.messages[conversationID]
	if !ok {
		return nil, errConversationNotFound
	}
	for _, item := range items {
		if item.ID == messageID {
			if item.Role != "user" {
				return nil, errMessageNotFound
			}
			return s.AppendUserAndAssistantMessage(ctx, conversationID, item.Content, "这是 Go server 的最小非流式重发占位回复。")
		}
	}
	return nil, errMessageNotFound
}

func (s *MemoryStore) TruncateMessages(_ context.Context, conversationID, messageID string) (ConversationMessagesResult, error) {
	items, ok := s.messages[conversationID]
	if !ok {
		return ConversationMessagesResult{}, errConversationNotFound
	}
	index := -1
	for i := range items {
		if items[i].ID == messageID {
			index = i
			break
		}
	}
	if index == -1 {
		return ConversationMessagesResult{}, errMessageNotFound
	}
	items = items[:index]
	s.messages[conversationID] = items
	s.bumpConversation(conversationID)
	return ConversationMessagesResult{Messages: append([]Message(nil), items...), HasMore: false, Total: len(items)}, nil
}

func (s *MemoryStore) bumpConversation(conversationID string) {
	now := time.Now().UTC()
	for i := range s.conversations {
		if s.conversations[i].ID == conversationID {
			s.conversations[i].UpdatedAt = now
			return
		}
	}
}
