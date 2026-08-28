// Phase C Step 9 — On-disk plugin discovery.
//
// Each plugin lives in its own subdirectory under PluginsConfig.Directory:
//
//	plugins/
//	  hello/
//	    plugin.json
//	    hello.wasm
//	  game-detection/
//	    plugin.json
//	    detector.wasm
//	    assets/...
//
// Loader walks the directory, parses every plugin.toml (wazero build) or
// plugin.json manifest via loadManifestFromDir, and returns a slice of
// foundPlugin records. The Registry then persists each into the store.

package plugin

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type foundPlugin struct {
	Manifest *Manifest
	Dir      string
	WASMPath string
}

// loadManifestFromDir resolves the manifest that governs one plugin
// directory, preferring plugin.toml (wazero build) over plugin.json — the
// precedence scanPluginDirectory has always applied on the on-disk restart
// path. Every caller that resolves a plugin manifest from a directory must
// route through here, so the manifest a zip install validates is
// byte-for-byte the one the next restart loads (OC-0318): two callers
// disagreeing on precedence let an admin approve a narrow manifest while a
// broader one, never reviewed, silently takes over after the next restart.
//
// Returns an error satisfying os.IsNotExist when neither manifest file is
// present, so callers that treat "not a plugin directory" as non-fatal
// (scanPluginDirectory, walking arbitrary subdirectories) can tell that
// apart from a real parse failure.
func loadManifestFromDir(dir string) (*Manifest, error) {
	if m, ok, err := tryLoadPluginTOML(dir); err != nil {
		return nil, err
	} else if ok {
		return m, nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
	if err != nil {
		return nil, err
	}
	return ParseManifest(raw)
}

// scanPluginDirectory walks dir non-recursively and parses a manifest
// (plugin.toml or plugin.json, via loadManifestFromDir) from every immediate
// subdirectory. A per-plugin failure (malformed manifest, missing or
// symlinked entrypoint, a stray symlink anywhere in that plugin's tree) is
// recorded and that one subdirectory is skipped — it does not stop the
// scan. The returned error is non-nil whenever at least one subdirectory
// was skipped, joining every such failure, but `found` still holds every
// plugin that scanned cleanly. Callers that need the scan to be all-or-
// nothing should check the returned error before using `found`; LoadAll
// deliberately does not, so one bad plugin directory cannot disable every
// other plugin (OC-0165).
func scanPluginDirectory(dir string) ([]foundPlugin, error) {
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			// Directory absent is fine — operators may not have created it yet.
			return nil, nil
		}
		return nil, err
	}
	var found []foundPlugin
	var scanErr error
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pluginDir := filepath.Join(dir, e.Name())

		manifest, manifestErr := loadManifestFromDir(pluginDir)
		if manifestErr != nil {
			if os.IsNotExist(manifestErr) {
				// Neither plugin.toml nor plugin.json present — not a plugin
				// directory, skip silently.
				continue
			}
			scanErr = errors.Join(scanErr, fmt.Errorf("plugin %q: %w", e.Name(), manifestErr))
			continue
		}
		// Reject any symlinks anywhere in the plugin directory tree. The asset
		// handler enforces that resolved paths stay rooted at pluginDir, but
		// http.ServeFile / os.Open follow symlinks transparently — a malicious
		// plugin .zip containing `assets/index.html -> /etc/passwd` would
		// otherwise serve host files. os.Lstat is used for the entrypoint
		// check below so a symlink is detected instead of followed, even
		// when its target is a valid .wasm file.
		if err := rejectSymlinksUnder(pluginDir); err != nil {
			scanErr = errors.Join(scanErr, fmt.Errorf("plugin %q: %w", e.Name(), err))
			continue
		}
		wasmPath := filepath.Join(pluginDir, manifest.Entrypoint)
		if info, statErr := os.Lstat(wasmPath); statErr != nil {
			scanErr = errors.Join(scanErr, fmt.Errorf("plugin %q: missing entrypoint %s: %w", e.Name(), manifest.Entrypoint, statErr))
			continue
		} else if info.Mode()&os.ModeSymlink != 0 {
			scanErr = errors.Join(scanErr, fmt.Errorf("plugin %q: entrypoint %s is a symlink", e.Name(), manifest.Entrypoint))
			continue
		}
		found = append(found, foundPlugin{
			Manifest: manifest,
			Dir:      pluginDir,
			WASMPath: wasmPath,
		})
	}
	return found, scanErr
}

// rejectSymlinksUnder walks root and returns an error if any entry is a
// symlink. Defends against malicious plugin packages that ship symlinks to
// host filesystem paths.
func rejectSymlinksUnder(root string) error {
	return filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink not allowed: %s", path)
		}
		return nil
	})
}

// serialize returns a canonical JSON encoding of the manifest, used as the
// manifest_json column value in the plugins table.
func (m *Manifest) serialize() (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("manifest serialize: %w", err)
	}
	return string(b), nil
}
