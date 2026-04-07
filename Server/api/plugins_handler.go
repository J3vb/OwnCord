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
	"strings"

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
		http.Error(w, "invalid multipart upload", http.StatusBadRequest)
		return
	}
	file, header, err := r.FormFile("plugin")
	if err != nil {
		http.Error(w, "missing 'plugin' file part", http.StatusBadRequest)
		return
	}
	defer file.Close() //nolint:errcheck

	// Reject obviously-wrong uploads early. The real defence is the zip
	// reader inside InstallFromZip (content-type is client-supplied and must
	// never be trusted for authorisation), but rejecting non-zip MIME types
	// here returns a cleaner 400 than a "not a valid zip" error from deep
	// inside the registry.
	if header != nil {
		if ct := header.Header.Get("Content-Type"); ct != "" && !isZipContentType(ct) {
			http.Error(w, "plugin upload must be a .zip archive", http.StatusUnsupportedMediaType)
			return
		}
	}

	// Read the entire zip into memory — InstallFromZip needs an io.ReaderAt
	// for archive/zip and the cap is small enough to be safe.
	body, err := io.ReadAll(io.LimitReader(file, maxPluginUploadBytes+1))
	if err != nil {
		http.Error(w, "failed to read upload", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > maxPluginUploadBytes {
		http.Error(w, "plugin upload too large", http.StatusRequestEntityTooLarge)
		return
	}
	// Magic-byte check: a real .zip starts with "PK\x03\x04" (local file
	// header) or "PK\x05\x06" (empty archive). Anything else is definitively
	// not a zip regardless of what the client labelled it.
	if !hasZipMagic(body) {
		http.Error(w, "plugin upload is not a valid zip archive", http.StatusBadRequest)
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
		slog.Error("plugin list failed", "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
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
		slog.Error("plugin enable failed", "id", id, "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
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
		slog.Error("plugin disable failed", "id", id, "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
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
		slog.Error("plugin uninstall failed", "id", id, "error", err)
		http.Error(w, "internal server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// isZipContentType reports whether ct looks like a zip MIME type. Both the
// IANA-registered application/zip and the legacy application/x-zip-compressed
// (used by some Windows clients) are accepted. The comparison is case-
// insensitive and strips any parameters after a semicolon.
func isZipContentType(ct string) bool {
	for i := 0; i < len(ct); i++ {
		if ct[i] == ';' {
			ct = ct[:i]
			break
		}
	}
	switch strings.ToLower(strings.TrimSpace(ct)) {
	case "application/zip", "application/x-zip-compressed", "application/octet-stream":
		return true
	}
	return false
}

// hasZipMagic reports whether b begins with the PK signature used by every
// .zip archive. Empty archives use 0x50,0x4b,0x05,0x06; non-empty archives
// start with a local file header 0x50,0x4b,0x03,0x04. Both are accepted.
func hasZipMagic(b []byte) bool {
	if len(b) < 4 {
		return false
	}
	if b[0] != 'P' || b[1] != 'K' {
		return false
	}
	return (b[2] == 0x03 && b[3] == 0x04) || (b[2] == 0x05 && b[3] == 0x06)
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
