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
// This mirrors the otel / wazero build-tag approach used elsewhere in the
// repo so the default build stays self-contained.
package plugin

import (
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
)

// pluginNameRegexp restricts plugin names to a tight ASCII charset so the
// name can flow safely into URL paths (/api/v1/plugins/<name>/...), filesystem
// paths, and log lines without escaping concerns. Mirrors the npm package
// name rules: lowercase, digits, dash and underscore, 1-64 chars, must start
// with a letter or digit.
var pluginNameRegexp = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// pluginCommandRegexp restricts declared slash-command names to the same
// lowercase charset the dispatcher normalizes to (RegisterCommand lowercases
// and strips a leading "/"), so a declaration always compares equal to the
// name a client can actually invoke.
var pluginCommandRegexp = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// maxManifestCommands caps how many commands one plugin may claim.
const maxManifestCommands = 64

// Manifest is the parsed plugin metadata declared in plugin.json (or
// plugin.toml in the wazero-tagged build). The on-disk schema is intentionally
// flat so the default JSON parser handles it without a TOML dependency.
type Manifest struct {
	Name        string        `json:"name"`
	Version     string        `json:"version"`
	Author      string        `json:"author"`
	Description string        `json:"description"`
	Entrypoint  string        `json:"entrypoint"` // relative .wasm path
	Permissions []string      `json:"permissions"`
	Commands    []CommandSpec `json:"commands"`
	Resources   Resources     `json:"resources"`
	UI          UISpec        `json:"ui"`
}

// CommandSpec is one slash command the plugin declares. The declaration is
// the per-command ACL: activation only binds names listed here, so a guest
// module cannot claim commands its manifest never advertised.
//
// Only Name is enforced today. docs/plans/slash-commands.md extends this
// object with description/options/permission fields later; unknown JSON keys
// are ignored, so manifests written against that richer schema still parse.
type CommandSpec struct {
	Name string `json:"name"`
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
	if !pluginNameRegexp.MatchString(m.Name) {
		return fmt.Errorf("plugin manifest: name %q must match %s", m.Name, pluginNameRegexp.String())
	}
	if strings.TrimSpace(m.Version) == "" {
		return fmt.Errorf("plugin manifest: version is required")
	}
	if len(m.Version) > 64 {
		return fmt.Errorf("plugin manifest: version too long (max 64)")
	}
	if strings.TrimSpace(m.Entrypoint) == "" {
		return fmt.Errorf("plugin manifest: entrypoint is required")
	}
	if !strings.HasSuffix(m.Entrypoint, ".wasm") {
		return fmt.Errorf("plugin manifest: entrypoint %q must end in .wasm", m.Entrypoint)
	}
	if err := validateRelativePath(m.Entrypoint); err != nil {
		return fmt.Errorf("plugin manifest: entrypoint: %w", err)
	}
	for _, p := range m.Permissions {
		if !validCapabilities[Capability(p)] {
			return fmt.Errorf("plugin manifest: unknown permission %q", p)
		}
	}
	if err := m.validateCommands(); err != nil {
		return err
	}
	if m.Resources.MaxMemoryMB < 0 || m.Resources.CPUBudgetMs < 0 {
		return fmt.Errorf("plugin manifest: resources must be non-negative")
	}
	for i, t := range m.UI.Tabs {
		if strings.TrimSpace(t.ID) == "" {
			return fmt.Errorf("plugin manifest: ui.tabs[%d].id is required", i)
		}
		if strings.TrimSpace(t.Asset) == "" {
			return fmt.Errorf("plugin manifest: ui.tabs[%d].asset is required", i)
		}
		if err := validateRelativePath(t.Asset); err != nil {
			return fmt.Errorf("plugin manifest: ui.tabs[%d].asset: %w", i, err)
		}
	}
	return nil
}

// validateRelativePath rejects absolute paths, paths containing "..", paths
// with NUL bytes, backslashes (Windows separators), and paths that the path
// package's Clean would alter (which catches "./foo", "foo//bar", trailing
// slashes, etc.). Asset and entrypoint paths must be plain forward-slash
// relative segments under the plugin directory.
func validateRelativePath(p string) error {
	if p == "" {
		return fmt.Errorf("path is empty")
	}
	if strings.ContainsRune(p, 0) {
		return fmt.Errorf("path contains NUL byte")
	}
	if strings.ContainsRune(p, '\\') {
		return fmt.Errorf("path contains backslash; use forward slashes only")
	}
	if strings.HasPrefix(p, "/") {
		return fmt.Errorf("path %q must be relative", p)
	}
	cleaned := path.Clean(p)
	if cleaned != p {
		return fmt.Errorf("path %q is not in canonical form (clean: %q)", p, cleaned)
	}
	if cleaned == "." {
		return fmt.Errorf("path %q refers to the current directory", p)
	}
	for _, seg := range strings.Split(cleaned, "/") {
		if seg == ".." {
			return fmt.Errorf("path %q contains parent traversal", p)
		}
	}
	return nil
}

// validateCommands enforces the per-command ACL schema: declaring commands
// requires the `commands` capability, names must be canonical (the form the
// dispatcher normalizes to), and the list is bounded and duplicate-free.
func (m *Manifest) validateCommands() error {
	if len(m.Commands) == 0 {
		return nil
	}
	if !m.HasCapability(CapCommands) {
		return fmt.Errorf("plugin manifest: commands declared without the %q permission", CapCommands)
	}
	if len(m.Commands) > maxManifestCommands {
		return fmt.Errorf("plugin manifest: too many commands (%d, max %d)", len(m.Commands), maxManifestCommands)
	}
	seen := make(map[string]bool, len(m.Commands))
	for i, c := range m.Commands {
		if !pluginCommandRegexp.MatchString(c.Name) {
			return fmt.Errorf("plugin manifest: commands[%d].name %q must match %s", i, c.Name, pluginCommandRegexp.String())
		}
		if seen[c.Name] {
			return fmt.Errorf("plugin manifest: duplicate command %q", c.Name)
		}
		seen[c.Name] = true
	}
	return nil
}

// DeclaresCommand reports whether the manifest listed cmd in its `commands`
// block. cmd is expected in normalized form (lowercase, no leading "/").
func (m *Manifest) DeclaresCommand(cmd string) bool {
	for _, c := range m.Commands {
		if c.Name == cmd {
			return true
		}
	}
	return false
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
