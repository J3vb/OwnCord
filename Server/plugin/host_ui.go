// Phase C Step 9 — `ui` host capability.
//
// A plugin that declares the `ui` capability ships HTML/CSS/JS assets and a
// list of tabs. The host serves those assets at /api/v1/plugins/<name>/ui/...
// and the Solid.js client bridge renders each tab inside a sandboxed iframe.
package plugin

import (
	"net/http"
	"path/filepath"
	"strings"
)

// RegisterUI binds inst's declared tabs into the registry. Called from the
// activation path; safe to call multiple times (idempotent on inst).
func (r *Registry) RegisterUI(inst *Instance) error {
	if !inst.Manifest.HasCapability(CapUI) {
		return ErrCapabilityNotGranted
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Drop any existing bindings for this instance, then re-add.
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

// AssetHandler returns an http.Handler that serves the on-disk assets for
// inst, rooted at the plugin's directory. The handler refuses path traversal
// attempts and only serves files declared by manifest tabs.
func (r *Registry) AssetHandler(inst *Instance) http.Handler {
	allowed := make(map[string]bool, len(inst.Manifest.UI.Tabs))
	for _, t := range inst.Manifest.UI.Tabs {
		allowed[t.Asset] = true
	}
	pluginDir := filepath.Dir(inst.WASMPath)
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		rel := strings.TrimPrefix(req.URL.Path, "/")
		if !allowed[rel] {
			http.NotFound(w, req)
			return
		}
		full := filepath.Join(pluginDir, rel)
		if !strings.HasPrefix(full, pluginDir) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		http.ServeFile(w, req, full)
	})
}
