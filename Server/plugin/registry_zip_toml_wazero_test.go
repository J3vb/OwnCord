//go:build wazero

// OC-0318 (wazero build): installZipStagedManifest used to read only
// plugin.json, so a zip containing solely a plugin.toml failed to install
// at all — even though the on-disk loader (scanPluginDirectory) happily
// parses plugin.toml on every restart. The two paths must resolve the
// identical manifest for the same directory contents: this pins that a
// TOML-only zip now installs, and that scanning the resulting on-disk
// directory finds the same manifest fields InstallFromZip itself
// registered — the precedence parity OC-0318 requires.
package plugin

import (
	"archive/zip"
	"bytes"
	"context"
	"testing"
)

// buildTomlOnlyZip builds a zip containing only a plugin.toml (no
// plugin.json) plus a placeholder entrypoint file.
func buildTomlOnlyZip(t *testing.T, name string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files := map[string]string{
		"plugin.toml": "name = \"" + name + "\"\n" +
			"version = \"1.0.0\"\n" +
			"entrypoint = \"" + name + ".wasm\"\n" +
			"permissions = [\"commands\"]\n\n" +
			"[[commands]]\n" +
			"name = \"hello\"\n",
		name + ".wasm": "\x00asm\x01\x00\x00\x00",
	}
	for fname, content := range files {
		w, err := zw.Create(fname)
		if err != nil {
			t.Fatalf("zip create %s: %v", fname, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", fname, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestRegistry_InstallFromZip_TomlOnlyMatchesScan(t *testing.T) {
	dir := t.TempDir()
	r, _ := newWazeroTestRegistry(t, dir)
	ctx := context.Background()

	zipBytes := buildTomlOnlyZip(t, "tomlplug")
	name, err := r.InstallFromZip(ctx, zipBytes)
	if err != nil {
		t.Fatalf("InstallFromZip with a TOML-only plugin: %v", err)
	}
	if name != "tomlplug" {
		t.Fatalf("name = %q, want %q", name, "tomlplug")
	}

	installed := r.List()
	if len(installed) != 1 {
		t.Fatalf("List() = %d instances, want 1", len(installed))
	}
	installedManifest := installed[0].Manifest

	// scanPluginDirectory must resolve the identical manifest from the same
	// on-disk directory InstallFromZip just promoted into — this is the
	// precedence-parity OC-0318 requires: whatever the admin validated at
	// install time must be exactly what the next restart loads.
	found, scanErr := scanPluginDirectory(dir)
	if scanErr != nil {
		t.Fatalf("scanPluginDirectory: %v", scanErr)
	}
	if len(found) != 1 {
		t.Fatalf("scanPluginDirectory found %d plugins, want 1", len(found))
	}
	scanned := found[0].Manifest

	if scanned.Name != installedManifest.Name {
		t.Errorf("scanned.Name = %q, installed.Name = %q", scanned.Name, installedManifest.Name)
	}
	if scanned.Entrypoint != installedManifest.Entrypoint {
		t.Errorf("scanned.Entrypoint = %q, installed.Entrypoint = %q", scanned.Entrypoint, installedManifest.Entrypoint)
	}
	if len(scanned.Permissions) != len(installedManifest.Permissions) {
		t.Errorf("scanned.Permissions = %v, installed.Permissions = %v", scanned.Permissions, installedManifest.Permissions)
	}
	if len(scanned.Commands) != len(installedManifest.Commands) {
		t.Errorf("scanned.Commands = %v, installed.Commands = %v", scanned.Commands, installedManifest.Commands)
	}
}
