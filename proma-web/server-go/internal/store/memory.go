package store

import (
	"context"
	"encoding/base64"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

var errConversationNotFound = ErrConversationNotFound
var errMessageNotFound = ErrMessageNotFound

type MemoryStore struct {
	settings      Settings
	channels      []Channel
	workspaces    []Workspace
	conversations []Conversation
	messages      map[string][]Message
}

func NewMemoryStore() *MemoryStore {
	now := time.Now().UTC()
	workspaceID := uuid.NewString()
	conversationID := uuid.NewString()
	dividerID := uuid.NewString()
	toolMessageID := uuid.NewString()

	welcomeMessages := []Message{
		{
			ID:             dividerID,
			ConversationID: conversationID,
			Role:           "system",
			Content:        "欢迎进入 Proma Web 对话上下文。",
			CreatedAt:      now,
			Kind:           "context_divider",
			ContextDivider: &ContextDivider{ID: dividerID, Title: "会话开始", Content: "欢迎进入 Proma Web 对话上下文。"},
		},
		{
			ID:             toolMessageID,
			ConversationID: conversationID,
			Role:           "system",
			Content:        "已完成初始化检查。",
			CreatedAt:      now.Add(time.Millisecond),
			Kind:           "tool_result",
			ToolInvocation: &ToolInvocation{ID: uuid.NewString(), Name: "bootstrap-check", Status: "success", Input: "runtime"},
			ToolResult:     &ToolResult{InvocationID: "", Name: "bootstrap-check", Status: "success", Output: "已完成初始化检查。"},
		},
		{
			ID:             uuid.NewString(),
			ConversationID: conversationID,
			Role:           "assistant",
			Content:        "Sparky Web 已连接到 Go server。下一步可以逐步替换为真实 PostgreSQL 数据。",
			CreatedAt:      now.Add(2 * time.Millisecond),
			Status:         "done",
		},
	}

	defaultChannelID := uuid.NewString()
	defaultModelID := "claude-opus-4-6"

	return &MemoryStore{
		settings: Settings{
			ThemeMode:               "system",
			OnboardingCompleted:     true,
			EnvironmentCheckSkipped: false,
			NotificationsEnabled:    true,
			AgentChannelID:          defaultChannelID,
			AgentModelID:            defaultModelID,
		},
		channels: []Channel{{
			ID:              defaultChannelID,
			Name:            "Default Anthropic",
			Provider:        "anthropic",
			BaseURL:         "https://api.anthropic.com",
			EncryptedAPIKey: encryptAPIKey("test-anthropic-key"),
			Models: []ChannelModel{{ID: defaultModelID, Name: "Claude Opus 4.6", Enabled: true}},
			Enabled:         true,
			CreatedAt:       now,
			UpdatedAt:       now,
		}},
		workspaces: []Workspace{{
			ID:        workspaceID,
			Name:      "Proma",
			RootPath:  "/Volumes/RC500/cib/Proma",
			CreatedAt: now,
			UpdatedAt: now,
		}},
		conversations: []Conversation{{
			ID:        conversationID,
			Title:     "欢迎使用 Sparky Web",
			CreatedAt: now,
			UpdatedAt: now,
		}},
		messages: map[string][]Message{conversationID: welcomeMessages},
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

func (s *MemoryStore) ListChannels(context.Context) ([]Channel, error) {
	items := make([]Channel, 0, len(s.channels))
	for _, item := range s.channels {
		items = append(items, sanitizeChannel(item))
	}
	return items, nil
}

func (s *MemoryStore) CreateChannel(_ context.Context, input ChannelCreateInput) (Channel, error) {
	now := time.Now().UTC()
	item := Channel{
		ID:              uuid.NewString(),
		Name:            strings.TrimSpace(input.Name),
		Provider:        strings.TrimSpace(input.Provider),
		BaseURL:         strings.TrimSpace(input.BaseURL),
		EncryptedAPIKey: encryptAPIKey(input.APIKey),
		Models:          append([]ChannelModel(nil), input.Models...),
		Enabled:         input.Enabled,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	s.channels = append([]Channel{item}, s.channels...)
	return sanitizeChannel(item), nil
}

func (s *MemoryStore) UpdateChannel(_ context.Context, channelID string, input ChannelUpdateInput) (Channel, error) {
	for i := range s.channels {
		if s.channels[i].ID != channelID {
			continue
		}
		if input.Name != nil {
			s.channels[i].Name = strings.TrimSpace(*input.Name)
		}
		if input.Provider != nil {
			s.channels[i].Provider = strings.TrimSpace(*input.Provider)
		}
		if input.BaseURL != nil {
			s.channels[i].BaseURL = strings.TrimSpace(*input.BaseURL)
		}
		if input.APIKey != nil && strings.TrimSpace(*input.APIKey) != "" {
			s.channels[i].EncryptedAPIKey = encryptAPIKey(*input.APIKey)
		}
		if input.Models != nil {
			s.channels[i].Models = append([]ChannelModel(nil), input.Models...)
		}
		if input.Enabled != nil {
			s.channels[i].Enabled = *input.Enabled
		}
		s.channels[i].UpdatedAt = time.Now().UTC()
		return sanitizeChannel(s.channels[i]), nil
	}
	return Channel{}, ErrChannelNotFound
}

func (s *MemoryStore) DeleteChannel(_ context.Context, channelID string) error {
	for i := range s.channels {
		if s.channels[i].ID == channelID {
			s.channels = append(s.channels[:i], s.channels[i+1:]...)
			return nil
		}
	}
	return ErrChannelNotFound
}

func (s *MemoryStore) GetChannelRuntime(_ context.Context, channelID string) (Channel, error) {
	for _, item := range s.channels {
		if item.ID == channelID {
			resolved := item
			resolved.APIKey = decryptAPIKey(item.EncryptedAPIKey)
			return resolved, nil
		}
	}
	return Channel{}, ErrChannelNotFound
}

func sanitizeChannel(item Channel) Channel {
	copy := item
	copy.APIKey = ""
	copy.EncryptedAPIKey = ""
	copy.Models = append([]ChannelModel(nil), item.Models...)
	return copy
}

func encryptAPIKey(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func decryptAPIKey(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return ""
	}
	return string(decoded)
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

func (s *MemoryStore) AppendUserAndAssistantMessage(ctx context.Context, conversationID, userContent, assistantContent string) ([]Message, error) {
	return s.AppendMessagePair(ctx, conversationID,
		MessageCreateInput{Role: "user", Content: userContent, Status: "done"},
		MessageCreateInput{Role: "assistant", Content: assistantContent, Status: "done"},
	)
}

func (s *MemoryStore) AppendMessagePair(_ context.Context, conversationID string, userInput MessageCreateInput, assistantInput MessageCreateInput) ([]Message, error) {
	if _, ok := s.messages[conversationID]; !ok {
		return nil, errConversationNotFound
	}
	now := time.Now().UTC()
	user := makeMessage(conversationID, userInput, now)
	assistant := makeMessage(conversationID, assistantInput, now.Add(time.Millisecond))
	created := []Message{user, assistant}
	s.messages[conversationID] = append(s.messages[conversationID], created...)
	s.bumpConversationTitle(conversationID, user.Content, now)
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
			if items[i].Kind == "context_divider" && items[i].ContextDivider != nil {
				items[i].ContextDivider.Content = content
			}
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

func (s *MemoryStore) UpdateContextDivider(_ context.Context, conversationID, messageID, title, content string) (Message, error) {
	items, ok := s.messages[conversationID]
	if !ok {
		return Message{}, errConversationNotFound
	}
	for i := range items {
		if items[i].ID == messageID && items[i].Kind == "context_divider" {
			items[i].Content = content
			if items[i].ContextDivider == nil {
				items[i].ContextDivider = &ContextDivider{ID: messageID}
			}
			items[i].ContextDivider.Title = title
			items[i].ContextDivider.Content = content
			s.messages[conversationID] = items
			s.bumpConversation(conversationID)
			return items[i], nil
		}
	}
	return Message{}, errMessageNotFound
}

func (s *MemoryStore) BuildStreamingReply(_ context.Context, conversationID, userContent string) ([]StreamChunk, error) {
	if _, ok := s.messages[conversationID]; !ok {
		return nil, errConversationNotFound
	}
	trimmed := strings.TrimSpace(userContent)
	if trimmed == "" {
		trimmed = "空消息"
	}
	chunks := []string{
		"正在通过 Go server streaming 返回占位回复。",
		"\n\n",
		"你发送的是：",
		trimmed,
	}
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

func (s *MemoryStore) SaveUploadedAttachment(_ context.Context, file UploadedFile) (Attachment, error) {
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

func makeMessage(conversationID string, input MessageCreateInput, createdAt time.Time) Message {
	status := input.Status
	if status == "" {
		status = "done"
	}
	return Message{
		ID:             uuid.NewString(),
		ConversationID: conversationID,
		Role:           input.Role,
		Content:        input.Content,
		CreatedAt:      createdAt,
		Status:         status,
		Kind:           input.Kind,
		Attachments:    cloneAttachments(input.Attachments),
		ToolInvocation: cloneToolInvocation(input.ToolInvocation),
		ToolResult:     cloneToolResult(input.ToolResult),
		ContextDivider: cloneContextDivider(input.ContextDivider),
	}
}

func cloneAttachments(items []Attachment) []Attachment {
	if len(items) == 0 {
		return nil
	}
	out := make([]Attachment, len(items))
	copy(out, items)
	return out
}

func cloneToolInvocation(item *ToolInvocation) *ToolInvocation {
	if item == nil {
		return nil
	}
	clone := *item
	return &clone
}

func cloneToolResult(item *ToolResult) *ToolResult {
	if item == nil {
		return nil
	}
	clone := *item
	return &clone
}

func cloneContextDivider(item *ContextDivider) *ContextDivider {
	if item == nil {
		return nil
	}
	clone := *item
	return &clone
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

func (s *MemoryStore) bumpConversationTitle(conversationID, userContent string, now time.Time) {
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
			return
		}
	}
}
