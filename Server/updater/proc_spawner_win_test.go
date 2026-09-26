//go:build windows

package updater

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Re-executed as the "replacement": record whether stdout is a console.
func init() {
	out := os.Getenv("OWNCORD_SPAWN_TEST_REPORT")
	if out == "" {
		return
	}
	var mode uint32
	result := "no-console"
	if windows.GetConsoleMode(windows.Handle(os.Stdout.Fd()), &mode) == nil {
		result = "console"
	}
	_ = os.WriteFile(out+".tmp", []byte(result), 0o600)
	_ = os.Rename(out+".tmp", out)
	os.Exit(0)
}

// A self-restarted server must own a console whose window shows its logs:
// with no console (DETACHED_PROCESS), closing a window cannot stop it and its
// LiveKit gets a window of its own that the supervisor keeps respawning.
func TestStartInNewConsole_ReplacementWritesToItsOwnConsole(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(t.TempDir(), "report")
	t.Setenv("OWNCORD_SPAWN_TEST_REPORT", report)
	if err := startInNewConsole(bin, []string{"-test.run=^$"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		data, err := os.ReadFile(report)
		if err == nil {
			if got := string(data); got != "console" {
				t.Fatalf("replacement stdout = %s, want its own console", got)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("replacement never reported")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A redirect such as `chatserver.exe >> server.log` must survive the restart.
func TestIsConsole_FileIsNotConsole(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "log"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if isConsole(f) {
		t.Error("isConsole(regular file) = true, want false")
	}
}
