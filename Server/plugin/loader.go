// On-disk plugin discovery.
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
// The loader walks the directory, parses every plugin.json via
// loadManifestFromDir, and returns foundPlugin records the Registry persists.

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

// loadManifestFromDir resolves the manifest that governs one plugin directory.
// Every caller must route through here, so the manifest a zip install validates
// is byte-for-byte the one the next restart loads. It returns an error
// satisfying os.IsNotExist when plugin.json is absent, so callers treating "not
// a plugin directory" as non-fatal can tell that from a parse failure.
func loadManifestFromDir(dir string) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
	if err != nil {
		return nil, err
	}
	return ParseManifest(raw)
}

// scanPluginDirectory walks dir non-recursively and parses a manifest from every
// immediate subdirectory. A per-plugin failure (malformed manifest, missing or
// symlinked entrypoint, a stray symlink anywhere in the tree) skips that
// subdirectory without stopping the scan. The returned error is non-nil
// whenever one was skipped, joining every failure, but `found` still holds
// every plugin that scanned cleanly. LoadAll deliberately does not abort on it,
// so one bad directory cannot disable every other plugin.
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
				// No plugin.json: not a plugin directory, skip silently.
				continue
			}
			scanErr = errors.Join(scanErr, fmt.Errorf("plugin %q: %w", e.Name(), manifestErr))
			continue
		}
		// Reject any symlinks anywhere in the plugin tree. The asset handler
		// keeps resolved paths rooted at pluginDir, but http.ServeFile / os.Open
		// follow symlinks, so a plugin .zip containing `assets/index.html ->
		// /etc/passwd` would serve host files. os.Lstat is used for the
		// entrypoint check below so a symlink is detected even when its target is
		// a valid .wasm file.
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
// symlink, defending against plugin packages shipping symlinks to host paths.
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
