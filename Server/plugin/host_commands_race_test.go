// OC-0088: DispatchCommand read r.runtimePlatform without the registry lock
// that Close() writes it under, unlike the sibling reader activate() which
// takes r.mu.RLock() first specifically to avoid observing a concurrent
// Close mid-use. This file pins the fix with a concurrent -race test that
// runs under every build variant (no wazero dependency: the default build's
// runtimePlatform is always nil, but Close() still writes it under lock,
// which is enough for the race detector to flag the unguarded read).
package plugin

import (
	"context"
	"sync"
	"testing"
)

func TestDispatchCommandRuntimePlatformRace(t *testing.T) {
	mem := openPluginTestDB(t)
	reg, err := NewRegistry(Config{Directory: t.TempDir(), Store: mem})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	ctx := context.Background()
	manifest, err := ParseManifest([]byte(`{"name":"racer","version":"0.1.0","entrypoint":"p.wasm","permissions":["commands"],"commands":[{"name":"roll"}]}`))
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if err := reg.installFromDisk(ctx, foundPlugin{Manifest: manifest, WASMPath: "p.wasm"}); err != nil {
		t.Fatalf("installFromDisk: %v", err)
	}
	reg.mu.RLock()
	inst := reg.byName["racer"]
	reg.mu.RUnlock()
	if err := reg.RegisterCommand("roll", inst); err != nil {
		t.Fatalf("RegisterCommand: %v", err)
	}

	// Race DispatchCommand's unsynchronised read of r.runtimePlatform (line
	// 71 in host_commands.go) against Close's r.mu.Lock()-guarded write of
	// the same field. Before the fix, `go test -race` reports:
	//   DATA RACE ... Registry.Close() ... Registry.DispatchCommand()
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				reg.DispatchCommand(ctx, 1, 2, "roll", nil)
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = reg.Close(ctx)
	}()
	wg.Wait()
}
