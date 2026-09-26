package main

import (
	"strings"
	"testing"
)

// TestInfoOutput pins OP-14: `--version` and `--help` must be recognised
// before the server start path, so asking a build what it is cannot start a
// server or write config.yaml into the cwd. The dispatch is pure and returns
// true only for the informational forms; everything else (no argument, a real
// subcommand, an unknown flag) falls through to normal startup.
func TestInfoOutput(t *testing.T) {
	for _, arg := range []string{"--version"} {
		out, ok := infoOutput([]string{arg})
		if !ok {
			t.Errorf("infoOutput(%q) ok = false, want true", arg)
		}
		if strings.TrimSpace(out) != version {
			t.Errorf("infoOutput(%q) = %q, want version %q", arg, out, version)
		}
	}

	for _, arg := range []string{"--help"} {
		out, ok := infoOutput([]string{arg})
		if !ok {
			t.Errorf("infoOutput(%q) ok = false, want true", arg)
		}
		if !strings.Contains(out, "Usage:") || !strings.Contains(out, "chatserver healthcheck") {
			t.Errorf("infoOutput(%q) = %q, want the usage text", arg, out)
		}
	}

	for _, args := range [][]string{
		nil,
		{},
		{"healthcheck"},
		{"token", "list"},
		{"--unknown"},
		{"version"},
		{"help"},
		{"-h"},
	} {
		if out, ok := infoOutput(args); ok {
			t.Errorf("infoOutput(%v) = %q, ok = true; want fall-through to server startup", args, out)
		}
	}

	// Only the first argument is a subcommand: a later --help must not be
	// mistaken for the flag, or `chatserver token --help` would never reach
	// the token CLI's own usage.
	if _, ok := infoOutput([]string{"token", "--help"}); ok {
		t.Error("infoOutput(token --help) ok = true, want false (the subcommand owns its own flags)")
	}
}
