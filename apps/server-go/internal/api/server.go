package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/sparky-proma/server/internal/config"
	"github.com/sparky-proma/server/internal/db"
	"github.com/sparky-proma/server/internal/store"
)

type Server struct {
	config config.Config
	db     *db.DB
	store  store.Store
}

func NewServer(cfg config.Config, database *db.DB, st store.Store) *Server {
	return &Server{config: cfg, db: database, store: st}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /api/version", s.handleVersion)
	mux.HandleFunc("GET /api/runtime", s.handleRuntime)
	mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	mux.HandleFunc("PUT /api/settings", s.handleUpdateSettings)
	mux.HandleFunc("GET /api/workspaces", s.handleListWorkspaces)
	mux.HandleFunc("POST /api/workspaces", s.handleCreateWorkspace)
	mux.HandleFunc("GET /api/chat/sessions", s.handleListConversations)
	mux.HandleFunc("POST /api/chat/sessions", s.handleCreateConversation)
	mux.HandleFunc("GET /api/chat/sessions/", s.handleConversationMessages)
	mux.HandleFunc("POST /api/chat/sessions/", s.handleConversationMessages)
	return withCORS(mux)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSON(r *http.Request, target any) error {
	return json.NewDecoder(r.Body).Decode(target)
}

func conversationIDFromPath(path string) string {
	prefix := "/api/chat/sessions/"
	trimmed := strings.TrimPrefix(path, prefix)
	parts := strings.Split(trimmed, "/")
	if len(parts) < 2 || parts[1] != "messages" {
		return ""
	}
	return parts[0]
}

func limitFromRequest(r *http.Request) int {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		return 50
	}
	return limit
}
