package agent

import (
	"errors"
	"sort"
	"sync"
)

var ErrSessionNotFound = errors.New("agent session not found")
var ErrInvalidSessionState = errors.New("agent session action is not allowed in current status")

type MemoryRegistry struct {
	mu                     sync.RWMutex
	defaultRunner          RunnerInfo
	sessions               map[string]SessionRecord
	activeSessionID        string
	conversationToSession  map[string]string
}

func NewMemoryRegistry(defaultRunner RunnerInfo) *MemoryRegistry {
	return &MemoryRegistry{
		defaultRunner:         defaultRunner,
		sessions:              make(map[string]SessionRecord),
		conversationToSession: make(map[string]string),
	}
}

func (r *MemoryRegistry) DefaultRunner() RunnerInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.defaultRunner
}

func (r *MemoryRegistry) SetDefaultRunner(runner RunnerInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.defaultRunner = runner
}

func (r *MemoryRegistry) SaveSession(session SessionRecord) SessionRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sessions[session.ID] = session
	return session
}

func (r *MemoryRegistry) ListSessions() SessionListResult {
	r.mu.RLock()
	defer r.mu.RUnlock()

	sessions := make([]SessionRecord, 0, len(r.sessions))
	for _, session := range r.sessions {
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].CreatedAt.Before(sessions[j].CreatedAt)
	})

	return SessionListResult{Sessions: sessions, ActiveSessionID: r.activeSessionID}
}

func (r *MemoryRegistry) GetSession(id string) (SessionRecord, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	session, ok := r.sessions[id]
	return session, ok
}

func (r *MemoryRegistry) GetActiveSession() (SessionRecord, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.activeSessionID == "" {
		return SessionRecord{}, false
	}
	session, ok := r.sessions[r.activeSessionID]
	return session, ok
}

func (r *MemoryRegistry) GetSessionForConversation(conversationID string) (SessionRecord, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	sessionID, ok := r.conversationToSession[conversationID]
	if !ok || sessionID == "" {
		return SessionRecord{}, false
	}
	session, ok := r.sessions[sessionID]
	return session, ok
}

func (r *MemoryRegistry) SetActiveSession(sessionID string, conversationID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.activeSessionID = sessionID
	if conversationID != "" {
		r.conversationToSession[conversationID] = sessionID
	}
}

func (r *MemoryRegistry) ClearActiveSession(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.activeSessionID == sessionID {
		r.activeSessionID = ""
	}
	for conversationID, mappedSessionID := range r.conversationToSession {
		if mappedSessionID == sessionID {
			delete(r.conversationToSession, conversationID)
		}
	}
}
