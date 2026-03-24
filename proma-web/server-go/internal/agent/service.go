package agent

import (
	"context"
	"errors"
	"time"

	"github.com/sparky-proma/server/internal/config"
)

type Service struct {
	registry *MemoryRegistry
	client   *RunnerClient
	enabled  bool
}

func NewService(cfg config.Config) *Service {
	defaultRunner := RunnerInfo{
		ID:      cfg.AgentDefaultRunnerID,
		BaseURL: cfg.AgentRunnerBaseURL,
		Status:  RunnerStatusUnknown,
	}
	service := &Service{
		registry: NewMemoryRegistry(defaultRunner),
		enabled:  cfg.AgentControlEnabled,
	}
	if cfg.AgentControlEnabled {
		service.client = NewRunnerClient(cfg.AgentRunnerBaseURL, cfg.AgentRunnerTimeout)
	}
	return service
}

func (s *Service) DefaultRunner(ctx context.Context) RunnerInfo {
	runner := s.registry.DefaultRunner()
	if !s.enabled || s.client == nil {
		return runner
	}

	health, err := s.client.Health(ctx)
		now := time.Now().UTC()
		if err != nil {
			runner.Status = RunnerStatusUnreachable
			runner.LastError = err.Error()
			runner.LastHeartbeatAt = &now
			s.registry.SetDefaultRunner(runner)
			return runner
		}

	runner.Status = health.Status
	runner.Version = health.Version
	runner.LastError = health.LastError
	runner.LastHeartbeatAt = &health.CheckedAt
	s.registry.SetDefaultRunner(runner)
	return runner
}

func (s *Service) ListSessions() SessionListResult {
	return s.registry.ListSessions()
}

func (s *Service) GetSession(id string) (SessionRecord, error) {
	session, ok := s.registry.GetSession(id)
	if !ok {
		return SessionRecord{}, ErrSessionNotFound
	}
	return session, nil
}

func (s *Service) ActiveSessionForConversation(conversationID string) (SessionRecord, bool) {
	if conversationID != "" {
		if session, ok := s.registry.GetSessionForConversation(conversationID); ok {
			return session, true
		}
	}
	return s.registry.GetActiveSession()
}

func (s *Service) CreateSession(ctx context.Context, input CreateSessionInput) (SessionActionResult, error) {
	if !s.enabled || s.client == nil {
		return SessionActionResult{}, errors.New("agent control plane is disabled")
	}

	runner := s.DefaultRunner(ctx)
	if runner.Status != RunnerStatusHealthy {
		return SessionActionResult{}, &RunnerError{StatusCode: 503, Message: "agent runner is unavailable"}
	}

	result, err := s.client.CreateSession(ctx, input)
	if err != nil {
		return SessionActionResult{}, err
	}
	s.registry.SaveSession(result.Session)
	return result, nil
}

func (s *Service) ConnectSession(ctx context.Context, id string, input ConnectSessionInput) (SessionConnectionResult, error) {
	if !s.enabled || s.client == nil {
		return SessionConnectionResult{}, errors.New("agent control plane is disabled")
	}
	session, ok := s.registry.GetSession(id)
	if !ok {
		return SessionConnectionResult{}, ErrSessionNotFound
	}
	if session.Status != SessionStatusRunning {
		return SessionConnectionResult{}, ErrInvalidSessionState
	}

	result, err := s.client.ConnectSession(ctx, id, input)
	if err != nil {
		return SessionConnectionResult{}, err
	}
	s.registry.SaveSession(result.Session)
	s.registry.SetActiveSession(id, input.ConversationID)
	return result, nil
}

func (s *Service) SendMessage(ctx context.Context, sessionID string, input SendMessageInput) (MessageResult, error) {
	if !s.enabled || s.client == nil {
		return MessageResult{}, errors.New("agent control plane is disabled")
	}
	session, ok := s.registry.GetSession(sessionID)
	if !ok {
		return MessageResult{}, ErrSessionNotFound
	}
	if session.Status != SessionStatusRunning {
		return MessageResult{}, ErrInvalidSessionState
	}

	result, err := s.client.SendMessage(ctx, sessionID, input)
	if err != nil {
		return MessageResult{}, err
	}
	s.registry.SaveSession(result.Session)
	return result, nil
}

func (s *Service) StreamMessage(ctx context.Context, sessionID string, input SendMessageInput) (MessageStreamResult, error) {
	if !s.enabled || s.client == nil {
		return MessageStreamResult{}, errors.New("agent control plane is disabled")
	}
	session, ok := s.registry.GetSession(sessionID)
	if !ok {
		return MessageStreamResult{}, ErrSessionNotFound
	}
	if session.Status != SessionStatusRunning {
		return MessageStreamResult{}, ErrInvalidSessionState
	}

	result, err := s.client.StreamMessage(ctx, sessionID, input)
	if err != nil {
		return MessageStreamResult{}, err
	}
	s.registry.SaveSession(result.Session)
	return result, nil
}

func (s *Service) StreamMessageEvents(ctx context.Context, sessionID string, input SendMessageInput, onEvent func(RunnerStreamEvent) error) error {
	if !s.enabled || s.client == nil {
		return errors.New("agent control plane is disabled")
	}
	session, ok := s.registry.GetSession(sessionID)
	if !ok {
		return ErrSessionNotFound
	}
	if session.Status != SessionStatusRunning {
		return ErrInvalidSessionState
	}

	return s.client.StreamMessageEvents(ctx, sessionID, input, func(event RunnerStreamEvent) error {
		if event.UpdatedAt != "" {
			session.UpdatedAt, _ = time.Parse(time.RFC3339, event.UpdatedAt)
			s.registry.SaveSession(session)
		}
		return onEvent(event)
	})
}

func (s *Service) CloseSession(ctx context.Context, id string) (SessionActionResult, error) {
	if !s.enabled || s.client == nil {
		return SessionActionResult{}, errors.New("agent control plane is disabled")
	}
	session, ok := s.registry.GetSession(id)
	if !ok {
		return SessionActionResult{}, ErrSessionNotFound
	}
	if session.Status != SessionStatusRunning {
		return SessionActionResult{}, ErrInvalidSessionState
	}

	result, err := s.client.CloseSession(ctx, id)
	if err != nil {
		return SessionActionResult{}, err
	}
	s.registry.SaveSession(result.Session)
	s.registry.ClearActiveSession(id)
	return result, nil
}

func (s *Service) RestartSession(ctx context.Context, id string) (SessionActionResult, error) {
	if !s.enabled || s.client == nil {
		return SessionActionResult{}, errors.New("agent control plane is disabled")
	}
	session, ok := s.registry.GetSession(id)
	if !ok {
		return SessionActionResult{}, ErrSessionNotFound
	}
	if session.Status != SessionStatusStopped && session.Status != SessionStatusError {
		return SessionActionResult{}, ErrInvalidSessionState
	}

	result, err := s.client.RestartSession(ctx, id)
	if err != nil {
		return SessionActionResult{}, err
	}
	s.registry.SaveSession(result.Session)
	return result, nil
}
