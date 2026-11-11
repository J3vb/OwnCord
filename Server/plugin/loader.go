// On-disk plugin discovery: each plugin lives in its own subdirectory of
// PluginsConfig.Directory with a plugin.json and its .wasm entrypoint.

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

// loadManifestFromDir is the single manifest loader, so a zip install validates
// what the next restart loads. A missing plugin.json satisfies os.IsNotExist.
func loadManifestFromDir(dir string) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "plugin.json"))
	if err != nil {
		return nil, err
	}
	return ParseManifest(raw)
}

// scanPluginDirectory parses each immediate subdirectory. A failure skips that
// directory; `found` still holds the clean plugins alongside the joined error.
func scanPluginDirectory(dir string) ([]foundPlugin, error) {
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
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
				continue
			}
			scanErr = errors.Join(scanErr, fmt.Errorf("plugin %q: %w", e.Name(), manifestErr))
			continue
		}
		// Reject symlinks anywhere in the tree: http.ServeFile / os.Open follow them,
		// so a zip with `assets/index.html -> /etc/passwd` would serve host files. The
		// entrypoint uses os.Lstat so a symlink to a valid .wasm is still caught.
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

func (m *Manifest) serialize() (string, error) {
	b, err := json.Marshal(m)
	if err != nil {
		return "", fmt.Errorf("manifest serialize: %w", err)
	}
	return string(b), nil
}
