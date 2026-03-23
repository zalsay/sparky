package api

import "net/http"

type createWorkspaceRequest struct {
	Name     string `json:"name"`
	RootPath string `json:"rootPath"`
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListWorkspaces(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var req createWorkspaceRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	item, err := s.store.CreateWorkspace(r.Context(), req.Name, req.RootPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, item)
}
