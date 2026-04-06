// Phase C Step 9 — Plugin admin REST surface.
//
// All endpoints are mounted under the existing AdminIPRestrict group so they
// inherit the same network ACL as the rest of the admin panel. Authentication
// is handled by the admin handler's middleware before this handler runs.
package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/store"
)

// PluginAdminHandler exposes plugin lifecycle operations to the admin panel.
type PluginAdminHandler struct {
	registry *plugin.Registry
	store    store.PluginStore
}

// NewPluginAdminHandler builds an http.Handler that the router can mount.
// Pass a nil registry when plugin support is disabled — the handler then
// reports an empty list and 503 on lifecycle calls.
func NewPluginAdminHandler(registry *plugin.Registry, st store.PluginStore) http.Handler {
	h := &PluginAdminHandler{registry: registry, store: st}
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Post("/{id}/enable", h.enable)
	r.Post("/{id}/disable", h.disable)
	r.Delete("/{id}", h.uninstall)
	return r
}

func (h *PluginAdminHandler) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if h.store == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	rows, err := h.store.ListPlugins(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *PluginAdminHandler) enable(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePluginID(w, r)
	if !ok {
		return
	}
	if h.registry == nil {
		http.Error(w, "plugin runtime disabled", http.StatusServiceUnavailable)
		return
	}
	if err := h.registry.EnablePlugin(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *PluginAdminHandler) disable(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePluginID(w, r)
	if !ok {
		return
	}
	if h.registry == nil {
		http.Error(w, "plugin runtime disabled", http.StatusServiceUnavailable)
		return
	}
	if err := h.registry.DisablePlugin(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *PluginAdminHandler) uninstall(w http.ResponseWriter, r *http.Request) {
	id, ok := parsePluginID(w, r)
	if !ok {
		return
	}
	if h.registry == nil {
		http.Error(w, "plugin runtime disabled", http.StatusServiceUnavailable)
		return
	}
	if err := h.registry.UninstallPlugin(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func parsePluginID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	idStr := chi.URLParam(r, "id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, "invalid plugin id", http.StatusBadRequest)
		return 0, false
	}
	return id, true
}
