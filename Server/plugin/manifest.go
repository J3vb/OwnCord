// Package plugin implements the OwnCord plugin runtime.
//
// Phase C Step 9 — Wazero Plugin Runtime.
//
// The package is split into:
//
//   - manifest.go    : declarative plugin metadata + permission checks
//   - registry.go    : in-memory registry + lifecycle (install/enable/load)
//   - loader.go      : on-disk discovery and package validation
//   - sandbox.go     : Wazero runtime configuration (build tag `wazero`)
//   - host_*.go      : capability-scoped host API surfaces
//   - errors.go
//
// The default `go build ./...` ships a stub runtime that satisfies every call
// site without pulling Wazero into go.mod. To compile the real runtime:
//
//	go get github.com/tetratelabs/wazero
//	go build -tags wazero ./...
//
// This mirrors the postgres / otel build-tag approach used elsewhere in the
// repo so the default build stays self-contained.
package plugin

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Manifest is the parsed plugin metadata declared in plugin.json (or
// plugin.toml in the wazero-tagged build). The on-disk schema is intentionally
// flat so the default JSON parser handles it without a TOML dependency.
type Manifest struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Author      string   `json:"author"`
	Description string   `json:"description"`
	Entrypoint  string   `json:"entrypoint"` // relative .wasm path
	Permissions []string `json:"permissions"`
	Resources   Resources `json:"resources"`
	UI          UISpec    `json:"ui"`
}

// Resources caps the plugin's runtime budget. Zero means "use the runtime
// default from PluginsConfig".
type Resources struct {
	MaxMemoryMB int `json:"max_memory_mb"`
	CPUBudgetMs int `json:"cpu_budget_ms"`
}

// UISpec describes the optional client-side rendering surface.
type UISpec struct {
	Tabs []UITab `json:"tabs"`
}

// UITab is a single iframe-rendered plugin tab.
type UITab struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Asset string `json:"asset"` // relative html path
}

// Capability is a permission name a plugin may request.
type Capability string

const (
	CapCommands Capability = "commands"
	CapEvents   Capability = "events"
	CapStorage  Capability = "storage"
	CapHTTP     Capability = "http"
	CapUI       Capability = "ui"
)

// validCapabilities is the closed set of capability names a manifest may
// declare. Anything else is rejected at load time.
var validCapabilities = map[Capability]bool{
	CapCommands: true,
	CapEvents:   true,
	CapStorage:  true,
	CapHTTP:     true,
	CapUI:       true,
}

// ParseManifest decodes a plugin.json byte slice and validates required fields.
func ParseManifest(raw []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("plugin manifest: invalid JSON: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate enforces the manifest schema.
func (m *Manifest) Validate() error {
	if strings.TrimSpace(m.Name) == "" {
		return fmt.Errorf("plugin manifest: name is required")
	}
	if strings.TrimSpace(m.Version) == "" {
		return fmt.Errorf("plugin manifest: version is required")
	}
	if strings.TrimSpace(m.Entrypoint) == "" {
		return fmt.Errorf("plugin manifest: entrypoint is required")
	}
	if !strings.HasSuffix(m.Entrypoint, ".wasm") {
		return fmt.Errorf("plugin manifest: entrypoint %q must end in .wasm", m.Entrypoint)
	}
	for _, p := range m.Permissions {
		if !validCapabilities[Capability(p)] {
			return fmt.Errorf("plugin manifest: unknown permission %q", p)
		}
	}
	if m.Resources.MaxMemoryMB < 0 || m.Resources.CPUBudgetMs < 0 {
		return fmt.Errorf("plugin manifest: resources must be non-negative")
	}
	return nil
}

// HasCapability reports whether the manifest declared cap.
func (m *Manifest) HasCapability(cap Capability) bool {
	for _, p := range m.Permissions {
		if Capability(p) == cap {
			return true
		}
	}
	return false
}
