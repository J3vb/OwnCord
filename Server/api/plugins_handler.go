// Phase C Step 9 — Plugin admin REST surface.
//
// All endpoints are mounted under the existing AdminIPRestrict group so they
// inherit the same network ACL as the rest of the admin panel. Authentication
// is handled by the admin handler's middleware before this handler runs.
package api

import (
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/store"
)

// maxPluginUploadBytes caps the multipart upload at 16 MiB to match the
// plugin.maxZipBytes ceiling. The handler enforces both layers because the
// outer MaxBytesReader gives a clean 413 instead of a partial extract.
const maxPluginUploadBytes = 16 * 1024 * 1024

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
	r.Post("/install", h.install)
	r.Post("/{id}/enable", h.enable)
	r.Post("/{id}/disable", h.disable)
	r.Delete("/{id}", h.uninstall)
	return r
}

// install accepts a multipart upload with a single "plugin" file part
// containing a .zip. The zip is validated (zip-slip safe, no symlinks,
// uncompressed total capped, manifest required at root) and installed via
// Registry.InstallFromZip. Returns 201 with the new plugin name on success.
func (h *PluginAdminHandler) install(w http.ResponseWriter, r *http.Request) {
	if h.registry == nil {
		http.Error(w, "plugin runtime disabled", http.StatusServiceUnavailable)
		return
	}
	// Hard cap on the request body before parsing multipart so a hostile
	// client can't tie up parsing memory.
	r.Body = http.MaxBytesReader(w, r.Body, maxPluginUploadBytes+1024)
	if err := r.ParseMultipartForm(maxPluginUploadBytes); err != nil {
		http.Error(w, "invalid multipart upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	file, _, err := r.FormFile("plugin")
	if err != nil {
		http.Error(w, "missing 'plugin' file part", http.StatusBadRequest)
		return
	}
	defer file.Close() //nolint:errcheck

	// Read the entire zip into memory — InstallFromZip needs an io.ReaderAt
	// for archive/zip and the cap is small enough to be safe.
	body, err := io.ReadAll(io.LimitReader(file, maxPluginUploadBytes+1))
	if err != nil {
		http.Error(w, "read upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	if int64(len(body)) > maxPluginUploadBytes {
		http.Error(w, "plugin upload too large", http.StatusRequestEntityTooLarge)
		return
	}
	name, err := h.registry.InstallFromZip(r.Context(), body)
	if err != nil {
		slog.Error("plugin install failed", "error", err)
		writeJSON(w, http.StatusBadRequest, errorResponse{
			Error:   "INSTALL_FAILED",
			Message: "plugin installation failed",
		})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"name": name})
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
