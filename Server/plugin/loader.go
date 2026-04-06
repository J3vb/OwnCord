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
// Loader walks the directory, parses every plugin.json, and returns a slice
// of foundPlugin records. The Registry then persists each into the store.
package plugin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type foundPlugin struct {
	Manifest *Manifest
	Dir      string
	WASMPath string
}

// scanPluginDirectory walks dir non-recursively and parses plugin.json from
// every immediate subdirectory. Errors on individual plugins are wrapped and
// returned alongside the successful entries.
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
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pluginDir := filepath.Join(dir, e.Name())
		manifestPath := filepath.Join(pluginDir, "plugin.json")
		raw, rdErr := os.ReadFile(manifestPath)
		if rdErr != nil {
			if os.IsNotExist(rdErr) {
				continue
			}
			return nil, fmt.Errorf("plugin %q: read plugin.json: %w", e.Name(), rdErr)
		}
		manifest, parseErr := ParseManifest(raw)
		if parseErr != nil {
			return nil, fmt.Errorf("plugin %q: %w", e.Name(), parseErr)
		}
		wasmPath := filepath.Join(pluginDir, manifest.Entrypoint)
		if _, statErr := os.Stat(wasmPath); statErr != nil {
			return nil, fmt.Errorf("plugin %q: missing entrypoint %s: %w", e.Name(), manifest.Entrypoint, statErr)
		}
		found = append(found, foundPlugin{
			Manifest: manifest,
			Dir:      pluginDir,
			WASMPath: wasmPath,
		})
	}
	return found, nil
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
