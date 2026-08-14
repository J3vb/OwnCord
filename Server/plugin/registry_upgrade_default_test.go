//go:build !wazero

package plugin

import (
	"context"
	"testing"
)

// On a default (non-wazero) build nothing can ever activate, so the
// reactivate-after-upgrade path must not let EnablePlugin's activation-failure
// rollback persistently flip an enabled plugin's store row to disabled: the
// admin's enabled intent has to survive the upgrade so a later restart under a
// wazero-tagged build brings the plugin back up, exactly as activateAll would
// have at startup.
func TestRegistry_InstallFromZip_RuntimeUnavailable_PreservesEnabledFlag(t *testing.T) {
	r, store, dir := newRegistryWithDir(t)
	ctx := context.Background()
	writePluginDir(t, dir, "alpha", simpleManifest("alpha"))
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	inst := r.List()[0]

	if err := store.EnablePlugin(ctx, inst.ID); err != nil {
		t.Fatalf("EnablePlugin (setup): %v", err)
	}
	r.mu.Lock()
	inst.Enabled = true
	r.mu.Unlock()

	zipBytes := buildZip(t, map[string]string{
		"plugin.json": simpleManifest("alpha"),
		"alpha.wasm":  "\x00asm\x01\x00\x00\x00",
	})
	if _, err := r.InstallFromZip(ctx, zipBytes); err != nil {
		t.Fatalf("InstallFromZip: %v", err)
	}

	newInst := r.List()[0]
	row, err := store.GetPlugin(ctx, newInst.ID)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if !row.Enabled {
		t.Error("store row flipped to disabled by an upgrade on a runtime-less build — " +
			"the enabled intent must survive until a wazero-tagged start can actually activate")
	}
	if !newInst.Enabled {
		t.Error("in-memory instance must carry the preserved enabled flag so admin listings stay truthful")
	}
}
