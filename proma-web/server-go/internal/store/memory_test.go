package store

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func createTestConversation(t *testing.T, s *MemoryStore, title string) Conversation {
	t.Helper()
	conversation, err := s.CreateConversation(context.Background(), title, "model-test", "channel-test")
	if err != nil {
		t.Fatalf("CreateConversation failed: %v", err)
	}
	return conversation
}

func TestMemoryStoreConversationLifecycle(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	conversation := createTestConversation(t, s, "Lifecycle")

	renamed, err := s.RenameConversation(ctx, conversation.ID, "Renamed")
	if err != nil {
		t.Fatalf("RenameConversation failed: %v", err)
	}
	if renamed.Title != "Renamed" {
		t.Fatalf("expected renamed title, got %q", renamed.Title)
	}

	pinned, err := s.SetConversationPinned(ctx, conversation.ID, true)
	if err != nil {
		t.Fatalf("SetConversationPinned failed: %v", err)
	}
	if !pinned.Pinned {
		t.Fatal("expected conversation to be pinned")
	}

	items, err := s.ListConversations(ctx)
	if err != nil {
		t.Fatalf("ListConversations failed: %v", err)
	}
	found := false
	for _, item := range items {
		if item.ID == conversation.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected conversation in list")
	}

	if err := s.DeleteConversation(ctx, conversation.ID); err != nil {
		t.Fatalf("DeleteConversation failed: %v", err)
	}
	if _, err := s.GetConversationMessages(ctx, conversation.ID, 50, ""); err != ErrConversationNotFound {
		t.Fatalf("expected ErrConversationNotFound after delete, got %v", err)
	}
}

func TestMemoryStoreMessageOperations(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	conversation := createTestConversation(t, s, "Messages")

	attachments := []Attachment{{ID: "att-1", Name: "spec.txt", MimeType: "text/plain", Size: 12, URL: "https://example.invalid/spec.txt", Status: "ready"}}
	created, err := s.AppendMessagePair(ctx, conversation.ID,
		MessageCreateInput{Role: "user", Content: "hello", Status: "done", Attachments: attachments},
		MessageCreateInput{Role: "assistant", Content: "world", Status: "done"},
	)
	if err != nil {
		t.Fatalf("AppendMessagePair failed: %v", err)
	}
	if len(created) != 2 {
		t.Fatalf("expected 2 created messages, got %d", len(created))
	}
	if got := created[0].Attachments; len(got) != 1 || got[0].Name != "spec.txt" {
		t.Fatalf("expected attachments to persist, got %+v", got)
	}

	messages, err := s.GetConversationMessages(ctx, conversation.ID, 50, "")
	if err != nil {
		t.Fatalf("GetConversationMessages failed: %v", err)
	}
	if messages.Total != 2 {
		t.Fatalf("expected total 2, got %d", messages.Total)
	}

	edited, err := s.EditMessage(ctx, conversation.ID, created[0].ID, "edited")
	if err != nil {
		t.Fatalf("EditMessage failed: %v", err)
	}
	if edited[0].Content != "edited" {
		t.Fatalf("expected edited content, got %q", edited[0].Content)
	}

	resent, err := s.ResendMessage(ctx, conversation.ID, created[0].ID)
	if err != nil {
		t.Fatalf("ResendMessage failed: %v", err)
	}
	if len(resent) != 2 || resent[0].Role != "user" || resent[1].Role != "assistant" {
		t.Fatalf("unexpected resend result: %+v", resent)
	}

	result, err := s.GetConversationMessages(ctx, conversation.ID, 2, created[1].ID)
	if err != nil {
		t.Fatalf("GetConversationMessages before failed: %v", err)
	}
	if result.HasMore || result.Total != 1 || len(result.Messages) != 1 {
		t.Fatalf("unexpected paginated result: %+v", result)
	}

	truncated, err := s.TruncateMessages(ctx, conversation.ID, resent[0].ID)
	if err != nil {
		t.Fatalf("TruncateMessages failed: %v", err)
	}
	if truncated.Total != 2 {
		t.Fatalf("expected remaining total 2 after truncate, got %d", truncated.Total)
	}
	if truncated.Messages[len(truncated.Messages)-1].ID != created[1].ID {
		t.Fatalf("unexpected last message after truncate: %+v", truncated.Messages)
	}
}

func TestMemoryStoreStreamingAttachmentToolAndDivider(t *testing.T) {
	s := NewMemoryStore()
	ctx := context.Background()
	conversation := createTestConversation(t, s, "Advanced")

	uploaded, err := s.SaveUploadedAttachment(ctx, UploadedFile{
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

	toolMessage := MessageCreateInput{
		Role:    "system",
		Content: "tool output",
		Status:  "done",
		Kind:    "tool_result",
		ToolInvocation: &ToolInvocation{ID: "tool-1", Name: "grep", Status: "success", Input: "foo"},
		ToolResult:     &ToolResult{InvocationID: "tool-1", Name: "grep", Status: "success", Output: "bar"},
	}
	dividerTime := time.Now().UTC().Add(10 * time.Millisecond)
	divider := MessageCreateInput{
		Role:    "system",
		Content: "divider body",
		Status:  "done",
		Kind:    "context_divider",
		ContextDivider: &ContextDivider{ID: "divider-1", Title: "Before", Content: "divider body"},
		CreatedAt:      dividerTime,
	}
	_, err = s.AppendMessagePair(ctx, conversation.ID,
		MessageCreateInput{Role: "user", Content: "ask", Status: "done"},
		toolMessage,
	)
	if err != nil {
		t.Fatalf("AppendMessagePair tool failed: %v", err)
	}
	s.messages[conversation.ID] = append(s.messages[conversation.ID], makeMessage(conversation.ID, divider, dividerTime))

	updated, err := s.UpdateContextDivider(ctx, conversation.ID, s.messages[conversation.ID][2].ID, "After", "updated body")
	if err != nil {
		t.Fatalf("UpdateContextDivider failed: %v", err)
	}
	if updated.ContextDivider == nil || updated.ContextDivider.Title != "After" || updated.Content != "updated body" {
		t.Fatalf("unexpected updated divider: %+v", updated)
	}

	messages, err := s.GetConversationMessages(ctx, conversation.ID, 50, "")
	if err != nil {
		t.Fatalf("GetConversationMessages failed: %v", err)
	}
	foundTool := false
	foundDivider := false
	for _, item := range messages.Messages {
		if item.Kind == "tool_result" && item.ToolResult != nil && item.ToolResult.Output == "bar" {
			foundTool = true
		}
		if item.Kind == "context_divider" && item.ContextDivider != nil && item.ContextDivider.Title == "After" {
			foundDivider = true
		}
	}
	if !foundTool || !foundDivider {
		t.Fatalf("expected tool and divider messages, got %+v", messages.Messages)
	}

	chunks, err := s.BuildStreamingReply(ctx, conversation.ID, "ping")
	if err != nil {
		t.Fatalf("BuildStreamingReply failed: %v", err)
	}
	if len(chunks) == 0 || chunks[len(chunks)-1].Status != "done" {
		t.Fatalf("unexpected streaming chunks: %+v", chunks)
	}
}
