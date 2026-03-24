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

	runner := s.agentService.DefaultRunner(r.Context())
	runnerCount := 0
	if s.config.AgentControlEnabled {
		runnerCount = 1
	}

	writeJSON(w, http.StatusOK, runtimeResponse{
		Service:     "sparky-server-go",
		Version:     "0.1.0",
		Environment: s.config.Environment,
		Database: map[string]any{
			"configured": s.db != nil && s.db.Status.Configured,
			"status":     status,
		},
		AgentControlPlane: agentControlPlaneRuntime{
			Enabled:             s.config.AgentControlEnabled,
			RunnerCount:         runnerCount,
			DefaultRunnerStatus: agentRunnerStatus(runner.Status),
		},
	})
}
