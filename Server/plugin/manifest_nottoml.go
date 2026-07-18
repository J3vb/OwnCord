//go:build !wazero

// Default build stub — TOML manifest parsing is not compiled in without -tags wazero.

package plugin

// tryLoadPluginTOML always reports "not present" in the default build so the
// loader unconditionally falls through to plugin.json.
func tryLoadPluginTOML(_ string) (*Manifest, bool, error) {
	return nil, false, nil
}
