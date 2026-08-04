// Phase C Step 9 — `ui` host capability.
//
// A plugin that declares the `ui` capability ships HTML/CSS/JS assets and a
// list of tabs. This file is the host-side half only: AssetHandler and
// RegisterUI are implemented and tested, but no route is mounted for them
// yet and no client bridge exists — wiring them up is part of the pending
// host-function work tracked in sandbox_wazero.go.

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
//  3. Asset paths are resolved once at construction, not per request: the
//     request path is used solely as a map key, so no on-disk path is ever
//     built from user input. Each declared asset is checked with
//     filepath.Rel and dropped if the result contains ".." or is absolute,
//     which catches symlink escapes and the prefix-without-separator bug.
//  4. A serve-time os.Lstat check rejects symlinks that were created AFTER
//     install (the install-time rejectSymlinksUnder walk only runs once).
//     This closes the TOCTOU window where a malicious or buggy process
//     swaps a regular file for a symlink post-install — http.ServeFile
//     would otherwise follow the link and leak host files.
func (r *Registry) AssetHandler(inst *Instance) http.Handler {
	pluginDir, dirErr := filepath.Abs(filepath.Dir(inst.WASMPath))

	// Resolve and traversal-check every declared asset ONCE, here at
	// construction, mapping the manifest's asset name to its absolute path.
	// At serve time the request path is only ever used as a map key, never
	// as a path component, so no filesystem path is built from user input
	// at all. An asset that fails validation is simply absent from the map
	// and 404s, exactly as an undeclared file does.
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
			http.Error(w, "plugin asset root unavailable", http.StatusInternalServerError)
			return
		}
		rel := strings.TrimPrefix(req.URL.Path, "/")
		full, ok := allowed[rel]
		if !ok {
			http.NotFound(w, req)
			return
		}
		// Lstat (not Stat) so a symlink is detected instead of followed.
		// This runs on every request — cheap relative to the file read —
		// and closes the TOCTOU gap between install-time validation and
		// runtime serving.
		info, lerr := os.Lstat(full) //nolint:gosec // not user input: full comes from the construction-time allowlist
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
		f, openErr := os.Open(full) //nolint:gosec // not user input: full comes from the construction-time allowlist
		if openErr != nil {
			http.NotFound(w, req)
			return
		}
		defer func() { _ = f.Close() }()
		http.ServeContent(w, req, rel, info.ModTime(), f)
	})
}
