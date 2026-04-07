// Phase C Step 9 — `ui` host capability.
//
// A plugin that declares the `ui` capability ships HTML/CSS/JS assets and a
// list of tabs. The host serves those assets at /api/v1/plugins/<name>/ui/...
// and the Solid.js client bridge renders each tab inside a sandboxed iframe.
package plugin

import (
	"net/http"
	"os"
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
// inst, rooted at the plugin's directory. Defense in depth:
//  1. Manifest validation rejects absolute paths and "..".
//  2. The handler only serves files explicitly declared by a manifest tab.
//  3. After resolving the on-disk path we use filepath.Rel and reject any
//     result containing ".." or that is absolute, which catches symlink
//     escapes and the prefix-without-separator class of bug.
//  4. A serve-time os.Lstat check rejects symlinks that were created AFTER
//     install (the install-time rejectSymlinksUnder walk only runs once).
//     This closes the TOCTOU window where a malicious or buggy process
//     swaps a regular file for a symlink post-install — http.ServeFile
//     would otherwise follow the link and leak host files.
func (r *Registry) AssetHandler(inst *Instance) http.Handler {
	allowed := make(map[string]bool, len(inst.Manifest.UI.Tabs))
	for _, t := range inst.Manifest.UI.Tabs {
		allowed[t.Asset] = true
	}
	pluginDir, dirErr := filepath.Abs(filepath.Dir(inst.WASMPath))
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if dirErr != nil {
			http.Error(w, "plugin asset root unavailable", http.StatusInternalServerError)
			return
		}
		rel := strings.TrimPrefix(req.URL.Path, "/")
		if !allowed[rel] {
			http.NotFound(w, req)
			return
		}
		full, absErr := filepath.Abs(filepath.Join(pluginDir, rel))
		if absErr != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		relCheck, relErr := filepath.Rel(pluginDir, full)
		if relErr != nil || relCheck == "" || relCheck == "." || strings.HasPrefix(relCheck, "..") || filepath.IsAbs(relCheck) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		// Lstat (not Stat) so a symlink is detected instead of followed.
		// This runs on every request — cheap relative to the file read —
		// and closes the TOCTOU gap between install-time validation and
		// runtime serving.
		info, lerr := os.Lstat(full) //nolint:gosec // path traversal blocked above: rel validated and cleaned
		if lerr != nil {
			http.NotFound(w, req)
			return
		}
		if info.Mode()&os.ModeSymlink != 0 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if !info.Mode().IsRegular() {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		f, openErr := os.Open(full) //nolint:gosec // path traversal blocked above: rel validated and cleaned
		if openErr != nil {
			http.NotFound(w, req)
			return
		}
		defer func() { _ = f.Close() }()
		http.ServeContent(w, req, rel, info.ModTime(), f)
	})
}
