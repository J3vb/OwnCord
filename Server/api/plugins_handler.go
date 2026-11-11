// Plugin admin REST surface, mounted under AdminIPRestrict so it inherits the admin network ACL.

package api

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/go-chi/chi/v5"
)

// maxPluginUploadBytes caps the upload at 16 MiB to match plugin.maxZipBytes; the outer MaxBytesReader
// gives a clean 413 instead of a partial extract.
const maxPluginUploadBytes = 16 * 1024 * 1024

// PluginAdminHandler exposes plugin lifecycle operations to the admin panel.
type PluginAdminHandler struct {
	registry *plugin.Registry
	store    plugin.PluginStore
	audit    db.Auditor // nil disables audit writes (unit tests)
}

// NewPluginAdminHandler builds the handler; a nil registry means plugin support is off (empty list, 503 on
// lifecycle calls).
func NewPluginAdminHandler(registry *plugin.Registry, st plugin.PluginStore, audit db.Auditor) http.Handler {
	h := &PluginAdminHandler{registry: registry, store: st, audit: audit}
	r := chi.NewRouter()
	r.Get("/", h.list)
	r.Post("/install", h.install)
	r.Post("/{id}/enable", h.enable)
	r.Post("/{id}/disable", h.disable)
	r.Delete("/{id}", h.uninstall)
	return r
}

// install accepts a multipart upload with one "plugin" .zip part, installed via Registry.InstallFromZip,
// which validates it (zip-slip safe, no symlinks, capped size, manifest at root). Returns 201 with the
// name.
func (h *PluginAdminHandler) install(w http.ResponseWriter, r *http.Request) {
	if h.registry == nil {
		writeErr(w, http.StatusServiceUnavailable, httperr.CodePluginsDisabled, "plugin runtime disabled")
		return
	}
	// Hard cap before parsing multipart so a hostile client cannot tie up parsing memory.
	r.Body = http.MaxBytesReader(w, r.Body, maxPluginUploadBytes+1024)
	if err := r.ParseMultipartForm(maxPluginUploadBytes); err != nil {
		if _, tooLarge := errors.AsType[*http.MaxBytesError](err); tooLarge {
			writeErr(w, http.StatusRequestEntityTooLarge, httperr.CodePayloadTooLarge, "plugin upload too large")
			return
		}
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "invalid multipart upload")
		return
	}
	file, header, err := r.FormFile("plugin")
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "missing 'plugin' file part")
		return
	}
	defer file.Close() //nolint:errcheck

	// Reject obviously-wrong uploads early for a cleaner 400. The real defence is the zip reader in
	// InstallFromZip; content-type is client-supplied and must never be trusted for authorisation.
	if header != nil {
		if ct := header.Header.Get("Content-Type"); ct != "" && !isZipContentType(ct) {
			writeErr(w, http.StatusUnsupportedMediaType, httperr.CodeUnsupportedMediaType, "plugin upload must be a .zip archive")
			return
		}
	}

	body, err := io.ReadAll(io.LimitReader(file, maxPluginUploadBytes+1))
	if err != nil {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "failed to read upload")
		return
	}
	if int64(len(body)) > maxPluginUploadBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, httperr.CodePayloadTooLarge, "plugin upload too large")
		return
	}
	// A real .zip starts with "PK\x03\x04" or "PK\x05\x06" (empty archive), whatever the client labelled it.
	if !hasZipMagic(body) {
		writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "plugin upload is not a valid zip archive")
		return
	}
	name, err := h.registry.InstallFromZip(r.Context(), body)
	if err != nil {
		slog.Error("plugin install failed", "error", err)
		writeErr(w, http.StatusBadRequest, httperr.CodeInstallFailed, "plugin installation failed")
		return
	}
	h.writeAudit(r, "plugin_install", h.installedID(r.Context(), name), name)
	writeJSON(w, http.StatusCreated, map[string]any{"name": name})
}

func (h *PluginAdminHandler) list(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// An empty list means "nothing installed" with the runtime on and "cannot install" with it off; say
	// which, so the panel need not guess.
	w.Header().Set("X-Plugin-Runtime", pluginRuntimeState(h.registry))
	if h.store == nil {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	rows, err := h.store.ListPlugins(ctx)
	if err != nil {
		slog.Error("plugin list failed", "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
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
		writeErr(w, http.StatusServiceUnavailable, httperr.CodePluginsDisabled, "plugin runtime disabled")
		return
	}
	if err := h.registry.EnablePlugin(r.Context(), id); err != nil {
		slog.Error("plugin enable failed", "id", id, "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
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
		writeErr(w, http.StatusServiceUnavailable, httperr.CodePluginsDisabled, "plugin runtime disabled")
		return
	}
	if err := h.registry.DisablePlugin(r.Context(), id); err != nil {
		slog.Error("plugin disable failed", "id", id, "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
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
		writeErr(w, http.StatusServiceUnavailable, httperr.CodePluginsDisabled, "plugin runtime disabled")
		return
	}
	// Registry.UninstallPlugin is idempotent on an unknown id, so check the row: a stale delete must answer
	// 404 and not record a plugin_uninstall that never happened.
	if h.store != nil {
		if _, err := h.store.GetPlugin(r.Context(), id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "plugin not found")
				return
			}
			slog.Error("plugin lookup failed", "id", id, "error", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
			return
		}
	}
	if err := h.registry.UninstallPlugin(r.Context(), id); err != nil {
		slog.Error("plugin uninstall failed", "id", id, "error", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "internal server error")
		return
	}
	h.writeAudit(r, "plugin_uninstall", id, "")
	w.WriteHeader(http.StatusNoContent)
}

// writeAudit records a plugin lifecycle mutation against the admin principal; a nil auditor (unit tests)
// records nothing.
func (h *PluginAdminHandler) writeAudit(r *http.Request, action string, pluginID int64, detail string) {
	if h.audit == nil {
		return
	}
	db.WriteAudit(context.WithoutCancel(r.Context()), h.audit, admin.ActorIDFromContext(r.Context()),
		action, "plugin", pluginID, detail)
}

// installedID resolves a freshly installed plugin's row id for its audit entry; 0 when the store cannot
// answer.
func (h *PluginAdminHandler) installedID(ctx context.Context, name string) int64 {
	if h.store == nil {
		return 0
	}
	row, err := h.store.GetPluginByName(ctx, name)
	if err != nil || row == nil {
		return 0
	}
	return row.ID
}

// pluginRuntimeState reports whether lifecycle calls will work, for the X-Plugin-Runtime header; a nil
// registry means off and every lifecycle endpoint answers 503.
func pluginRuntimeState(registry *plugin.Registry) string {
	if registry == nil {
		return "disabled"
	}
	return "enabled"
}

// isZipContentType reports whether ct is a zip MIME type (including legacy application/x-zip-compressed),
// ignoring case and parameters.
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

// hasZipMagic reports whether b starts with the PK signature (03 04, or the empty-archive 05 06).
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
	id, ok := pathID(r, "id")
	if !ok {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid plugin id")
		return 0, false
	}
	return id, true
}
