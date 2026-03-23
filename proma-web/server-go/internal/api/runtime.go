package api

import (
	"net/http"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"service": "sparky-server-go",
		"version": "0.1.0",
	})
}

func (s *Server) handleRuntime(w http.ResponseWriter, r *http.Request) {
	status := "disconnected"
	if s.db != nil && s.db.Status.Connected {
		status = "connected"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"service":     "sparky-server-go",
		"version":     "0.1.0",
		"environment": s.config.Environment,
		"database": map[string]any{
			"configured": s.db != nil && s.db.Status.Configured,
			"status":     status,
		},
	})
}
