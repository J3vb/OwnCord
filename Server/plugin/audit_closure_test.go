// Audit 2026-04-07 plugin CRITICAL closure invariants.
//
// Each test here pins a property the closure table in
// docs/audit-2026-04-07.md cites as the reason a CRITICAL is closed. They live
// in the default-build file set on purpose so they run on every
// `go test ./...`, not only under -tags wazero.

package plugin

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestRegisterCommandRequiresManifestDeclaration locks finding #3 (per-command
// ACL). Holding the `commands` capability is not enough: only names the
// manifest's `commands` block declares may bind, so a guest module cannot
// widen its own command surface via list_commands.
func TestRegisterCommandRequiresManifestDeclaration(t *testing.T) {
	mem := openPluginTestDB(t)
	reg, err := NewRegistry(Config{Directory: t.TempDir(), Store: mem})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	t.Cleanup(func() { _ = reg.Close(context.Background()) })

	manifest, err := ParseManifest([]byte(
		`{"name":"claimer","version":"0.1.0","entrypoint":"p.wasm","permissions":["commands"],"commands":[{"name":"declared"}]}`))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	inst := &Instance{ID: 1, Manifest: manifest}

	if err := reg.RegisterCommand("declared", inst); err != nil {
		t.Fatalf("declared command must bind: %v", err)
	}
	// "/DECLARED" normalizes to the declared name and must still bind.
	if err := reg.RegisterCommand("/DECLARED", inst); err != nil {
		t.Fatalf("normalized declared command must bind: %v", err)
	}
	for _, undeclared := range []string{"undeclared", "ban", "declared2"} {
		if err := reg.RegisterCommand(undeclared, inst); !errors.Is(err, ErrCommandNotDeclared) {
			t.Fatalf("RegisterCommand(%q) = %v, want ErrCommandNotDeclared", undeclared, err)
		}
		reg.mu.RLock()
		_, bound := reg.commands[undeclared]
		reg.mu.RUnlock()
		if bound {
			t.Fatalf("undeclared command %q must not be bound", undeclared)
		}
	}
}

func TestManifestCommandsValidation(t *testing.T) {
	bad := map[string]string{
		"no commands capability": `{"name":"x","version":"1","entrypoint":"x.wasm","commands":[{"name":"a"}]}`,
		"uppercase name":         `{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["commands"],"commands":[{"name":"Ban"}]}`,
		"leading slash":          `{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["commands"],"commands":[{"name":"/ban"}]}`,
		"empty name":             `{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["commands"],"commands":[{"name":""}]}`,
		"whitespace in name":     `{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["commands"],"commands":[{"name":"a b"}]}`,
		"duplicate name":         `{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["commands"],"commands":[{"name":"a"},{"name":"a"}]}`,
	}
	for label, body := range bad {
		t.Run(label, func(t *testing.T) {
			if _, err := ParseManifest([]byte(body)); err == nil {
				t.Fatalf("expected rejection for %s", label)
			}
		})
	}

	// Extra per-command fields from the richer schema in
	// docs/plans/slash-commands.md must still parse (forward compatibility).
	m, err := ParseManifest([]byte(
		`{"name":"x","version":"1","entrypoint":"x.wasm","permissions":["commands"],"commands":[{"name":"kick","description":"d","options":[]}]}`))
	if err != nil {
		t.Fatalf("rich command spec must parse: %v", err)
	}
	if !m.DeclaresCommand("kick") || m.DeclaresCommand("ban") {
		t.Fatalf("DeclaresCommand wrong: %+v", m.Commands)
	}
}

// TestStorageKeysIsolatedPerPlugin locks finding #2 (per-plugin key
// isolation). The namespace is the caller's Instance.ID, which no plugin-
// supplied input can influence, and plugin_kv's PRIMARY KEY (plugin_id, key)
// keeps identical keys from two plugins in separate rows.
func TestStorageKeysIsolatedPerPlugin(t *testing.T) {
	ctx := context.Background()
	mem := openPluginTestDB(t)
	reg, err := NewRegistry(Config{Store: mem})
	if err != nil {
		t.Fatal(err)
	}
	newInst := func(name string) *Instance {
		id, instErr := mem.InstallPlugin(ctx, name, "0.1", "{}")
		if instErr != nil {
			t.Fatalf("InstallPlugin(%s): %v", name, instErr)
		}
		return &Instance{
			ID:       id,
			Manifest: &Manifest{Name: name, Permissions: []string{string(CapStorage)}},
		}
	}
	alice, mallory := newInst("alice"), newInst("mallory")

	if err := reg.StoragePut(ctx, alice, "secret", []byte("alice-value")); err != nil {
		t.Fatalf("StoragePut alice: %v", err)
	}
	// Same key, different plugin: the writes must not collide.
	if err := reg.StoragePut(ctx, mallory, "secret", []byte("mallory-value")); err != nil {
		t.Fatalf("StoragePut mallory: %v", err)
	}
	got, err := reg.StorageGet(ctx, alice, "secret")
	if err != nil || string(got) != "alice-value" {
		t.Fatalf("alice's value was clobbered: got %q err %v", got, err)
	}

	// Scan is namespaced too: an empty prefix returns only the caller's keys.
	all, err := reg.StorageScan(ctx, mallory, "", 0)
	if err != nil {
		t.Fatalf("StorageScan: %v", err)
	}
	if len(all) != 1 || string(all["secret"]) != "mallory-value" {
		t.Fatalf("scan leaked across plugin namespaces: %v", all)
	}

	// Deleting from one namespace leaves the other intact.
	if err := reg.StorageDelete(ctx, mallory, "secret"); err != nil {
		t.Fatalf("StorageDelete: %v", err)
	}
	if got, err := reg.StorageGet(ctx, alice, "secret"); err != nil || string(got) != "alice-value" {
		t.Fatalf("alice's key was deleted by mallory: got %q err %v", got, err)
	}
}

func TestStorageRejectsOversizedKeyAndValue(t *testing.T) {
	ctx := context.Background()
	mem := openPluginTestDB(t)
	reg, err := NewRegistry(Config{Store: mem})
	if err != nil {
		t.Fatal(err)
	}
	id, err := mem.InstallPlugin(ctx, "bloat", "0.1", "{}")
	if err != nil {
		t.Fatal(err)
	}
	inst := &Instance{ID: id, Manifest: &Manifest{Name: "bloat", Permissions: []string{string(CapStorage)}}}

	if err := reg.StoragePut(ctx, inst, "", []byte("v")); err == nil {
		t.Fatal("empty key must be rejected")
	}
	if err := reg.StoragePut(ctx, inst, strings.Repeat("k", maxPluginKeyBytes+1), []byte("v")); err == nil {
		t.Fatal("oversized key must be rejected")
	}
	if err := reg.StoragePut(ctx, inst, "k", make([]byte, maxPluginValueBytes+1)); err == nil {
		t.Fatal("oversized value must be rejected")
	}
	if err := reg.StoragePut(ctx, inst, strings.Repeat("k", maxPluginKeyBytes), make([]byte, maxPluginValueBytes)); err != nil {
		t.Fatalf("at-limit key/value must be accepted: %v", err)
	}
}

// TestEventDeliveryHasNoGuestPath locks finding #4. The finding (a plugin
// slowing the server by handling events slowly) is not reachable today:
// Subscribe requires the capability and Dispatch invokes no guest code in
// either build. If this test has to change because Dispatch grew a real
// delivery path, that change must also bring the per-plugin rate limit — see
// the SECURITY GATE comment on EventSink.Dispatch.
func TestEventDeliveryHasNoGuestPath(t *testing.T) {
	sink := NewEventSink()
	noCap := &Instance{ID: 1, Manifest: &Manifest{Name: "nocap"}}
	if err := sink.Subscribe("message_send", noCap); !errors.Is(err, ErrCapabilityNotGranted) {
		t.Fatalf("Subscribe without the events capability = %v, want ErrCapabilityNotGranted", err)
	}

	sub := &Instance{ID: 2, Manifest: &Manifest{Name: "sub", Permissions: []string{string(CapEvents)}}}
	if err := sink.Subscribe("message_send", sub); err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	// inst.module is nil here, so a real guest call would panic or error.
	sink.Dispatch(context.Background(), "message_send", []byte(`{}`))

	sink.UnsubscribeAll(sub)
	sink.mu.Lock()
	remaining := len(sink.subs)
	sink.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("UnsubscribeAll left %d topics behind", remaining)
	}
}

// TestEmptyAllowlistDeniesEveryHost locks the standing mitigation for finding
// #5 (HTTP exfiltration to allowlisted hosts): the shipped default
// `plugins.http_allowlist` is empty (config.DefaultConfig), and an empty
// allowlist must deny every destination rather than fall open.
func TestEmptyAllowlistDeniesEveryHost(t *testing.T) {
	for _, allowlist := range [][]string{nil, {}, {"", "  "}} {
		reg := newTestRegistry(allowlist)
		for _, host := range []string{"example.com", "api.github.com", "attacker.test", "localhost"} {
			if reg.hostAllowed(host) {
				t.Fatalf("allowlist %v must not permit %q", allowlist, host)
			}
		}
	}
}
