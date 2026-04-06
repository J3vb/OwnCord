//go:build wazero

// TOML manifest support — compiled only with -tags wazero.
// Plugins may ship either plugin.json or plugin.toml; this file provides
// tryLoadPluginTOML which the loader calls before falling back to JSON.
package plugin

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// tryLoadPluginTOML attempts to parse a plugin.toml from pluginDir.
// Returns the parsed Manifest and true on success.
// Returns nil, false if no plugin.toml exists (caller should try plugin.json).
// Returns nil, false plus logs if plugin.toml exists but is malformed — the
// caller will skip the plugin and log the error.
func tryLoadPluginTOML(pluginDir string) (*Manifest, bool, error) {
	tomlPath := filepath.Join(pluginDir, "plugin.toml")
	raw, err := os.ReadFile(tomlPath)
	if os.IsNotExist(err) {
		return nil, false, nil // not present; try JSON
	}
	if err != nil {
		return nil, false, fmt.Errorf("read plugin.toml: %w", err)
	}

	var m Manifest
	if _, err := toml.Decode(string(raw), &m); err != nil {
		return nil, false, fmt.Errorf("parse plugin.toml: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, false, fmt.Errorf("invalid plugin.toml: %w", err)
	}
	return &m, true, nil
}
