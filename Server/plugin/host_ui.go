// `ui` host capability: a plugin ships HTML/CSS/JS assets and tabs. Host side
// only; no route is mounted and no client bridge exists yet.

package plugin

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// RegisterUI binds inst's declared tabs into the registry; idempotent on inst.
func (r *Registry) RegisterUI(inst *Instance) error {
	if !inst.Manifest.HasCapability(CapUI) {
		return ErrCapabilityNotGranted
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.uiTabs[:0]
	for _, b := range r.uiTabs {
		if b.PluginID != inst.ID {
			kept = append(kept, b)
		}
	}
	r.uiTabs = kept
	for _, t := range inst.Manifest.UI.Tabs {
		r.uiTabs = append(r.uiTabs, UITabBinding{
			PluginID:   inst.ID,
			PluginName: inst.Manifest.Name,
			Tab:        t,
		})
	}
	return nil
}

// AssetHandler serves inst's declared tab assets from the plugin directory.
// Defense in depth: the request path is only a map key into assets resolved once
// at construction (so no on-disk path is built from user input), each checked
// with filepath.Rel for ".." and symlink escapes; and a serve-time os.Lstat
// rejects a symlink swapped in after the install-time scan (TOCTOU).
func (r *Registry) AssetHandler(inst *Instance) http.Handler {
	pluginDir, dirErr := filepath.Abs(filepath.Dir(inst.WASMPath))

	// Resolve and traversal-check each declared asset once; a failing asset is
	// absent from the map and 404s like an undeclared file.
	allowed := make(map[string]string, len(inst.Manifest.UI.Tabs))
	if dirErr == nil {
		for _, t := range inst.Manifest.UI.Tabs {
			full, absErr := filepath.Abs(filepath.Join(pluginDir, t.Asset))
			if absErr != nil {
				continue
			}
			rel, relErr := filepath.Rel(pluginDir, full)
			if relErr != nil || rel == "" || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
				continue
			}
			allowed[t.Asset] = full
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if dirErr != nil {
			httperr.Write(w, http.StatusInternalServerError, httperr.CodeInternalError, "plugin asset root unavailable")
			return
		}
		rel := strings.TrimPrefix(req.URL.Path, "/")
		full, ok := allowed[rel]
		if !ok {
			http.NotFound(w, req)
			return
		}
		// Lstat (not Stat) so a symlink is detected, not followed, on every request.
		info, lerr := os.Lstat(full) //nolint:gosec // not user input: full comes from the construction-time allowlist
		if lerr != nil {
			http.NotFound(w, req)
			return
		}
		if info.Mode()&os.ModeSymlink != 0 {
			httperr.Write(w, http.StatusForbidden, httperr.CodeForbidden, "forbidden")
			return
		}
		if !info.Mode().IsRegular() {
			httperr.Write(w, http.StatusForbidden, httperr.CodeForbidden, "forbidden")
			return
		}
		f, openErr := os.Open(full) //nolint:gosec // not user input: full comes from the construction-time allowlist
		if openErr != nil {
			http.NotFound(w, req)
			return
		}
		defer func() { _ = f.Close() }()
		http.ServeContent(w, req, rel, info.ModTime(), f)
	})
}
