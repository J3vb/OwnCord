//go:build wazero

package plugin

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tetratelabs/wazero/sys"
)

// A list_commands that overruns its CPU budget fails activation, and the
// runtime's own error (here the deadline exit) must stay on the chain so the
// caller can classify it rather than read a flattened string.
func TestActivate_ListCommandsOverrunKeepsCause(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"listspin","version":"0.1.0","entrypoint":"hello.wasm","permissions":["commands"],"commands":[{"name":"x"}]}`
	writeTestPlugin(t, dir, "listspin", manifest, listSpinWASM)
	reg, mem := newWazeroTestRegistry(t, dir)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := reg.LoadAll(ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ := mem.ListPlugins(ctx)

	err := reg.EnablePlugin(ctx, rows[0].ID)
	if err == nil {
		t.Fatal("EnablePlugin must fail when list_commands overruns its budget")
	}
	var exit *sys.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("err = %v, want the runtime's *sys.ExitError on the chain", err)
	}
}

// The module can be found closed with no call error (closed from under the
// call, not trapped): the failure must still read as a sentence, not wrap a
// nil error into "%!w(<nil>)".
func TestListCommandsError_ClosedModuleWithoutCallError(t *testing.T) {
	err := listCommandsError("p", nil)
	if err == nil || strings.Contains(err.Error(), "%!") {
		t.Fatalf("err = %v, want a clean message", err)
	}
	if !strings.Contains(err.Error(), `plugin "p"`) {
		t.Fatalf("err = %q, want it to name the plugin", err)
	}

	cause := errors.New("trap")
	if err := listCommandsError("p", cause); !errors.Is(err, cause) {
		t.Fatalf("err = %v, want the call error on the chain", err)
	}
}
