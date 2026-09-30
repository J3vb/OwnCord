//go:build windows

package updater

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	getConsoleProcessList = kernel32.NewProc("GetConsoleProcessList")
)

// Re-executed as the "replacement": record whether stdout is a console, or,
// when told the spawner's pid, whether the spawner is on this same console,
// then exit with the requested code.
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
	if parent := os.Getenv("OWNCORD_SPAWN_TEST_PARENT"); parent != "" {
		result = "separate"
		pids := make([]uint32, 64)
		n, _, _ := getConsoleProcessList.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)))
		for _, pid := range pids[:min(int(n), len(pids))] {
			if strconv.FormatUint(uint64(pid), 10) == parent {
				result = "shared"
			}
		}
	}
	_ = os.WriteFile(out+".tmp", []byte(result), 0o600)
	_ = os.Rename(out+".tmp", out)
	code, _ := strconv.Atoi(os.Getenv("OWNCORD_SPAWN_TEST_EXIT"))
	os.Exit(code)
}

// isolateCoverage keeps the re-executed replacement's coverage counters out of
// this run's profile (see Server/admin's isolateSpawnedTestBinary). The
// directory is not t.TempDir: the replacement may still be writing it when the
// test ends, and a failed removal would fail the test.
func isolateCoverage(t *testing.T) {
	t.Helper()
	dir, err := os.MkdirTemp("", "owncord-spawn-cover")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOCOVERDIR", dir)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
}

// awaitReport waits for the re-executed replacement to write its report.
func awaitReport(t *testing.T, report string) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		if data, err := os.ReadFile(report); err == nil {
			return string(data)
		}
		if time.Now().After(deadline) {
			t.Fatal("replacement never reported")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// attachConsole gives the test process a console when it runs without one.
func attachConsole(t *testing.T) {
	t.Helper()
	if hasConsole() {
		return
	}
	if r, _, err := kernel32.NewProc("AllocConsole").Call(); r == 0 {
		t.Fatalf("AllocConsole: %v", err)
	}
	t.Cleanup(func() { _, _, _ = kernel32.NewProc("FreeConsole").Call() })
}

// A server started from a console window must restart into that same window:
// a replacement in a console of its own leaves the operator's window at a
// prompt (or closed) with the running server somewhere they cannot see.
func TestSpawnReplacement_ReplacementSharesTheSpawnersConsole(t *testing.T) {
	attachConsole(t)
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(t.TempDir(), "report")
	t.Setenv("OWNCORD_SPAWN_TEST_REPORT", report)
	isolateCoverage(t)
	t.Setenv("OWNCORD_SPAWN_TEST_PARENT", strconv.Itoa(os.Getpid()))
	wait, err := SpawnReplacement(bin, []string{"-test.run=^$"})
	if err != nil {
		t.Fatal(err)
	}
	if got := awaitReport(t, report); got != "shared" {
		t.Fatalf("replacement console = %s, want the spawner's own console", got)
	}
	if wait != nil {
		wait()
	}
}

// The spawner stays behind on the shared console so its host keeps the window
// open (Windows Terminal closes a tab whose process exits) and a shell keeps
// waiting; it exits with whatever the replacement exited with.
func TestSpawnReplacement_WaiterReturnsTheReplacementsExitCode(t *testing.T) {
	attachConsole(t)
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OWNCORD_SPAWN_TEST_REPORT", filepath.Join(t.TempDir(), "report"))
	t.Setenv("OWNCORD_SPAWN_TEST_EXIT", "7")
	isolateCoverage(t)
	wait, err := SpawnReplacement(bin, []string{"-test.run=^$"})
	if err != nil {
		t.Fatal(err)
	}
	if wait == nil {
		t.Fatal("SpawnReplacement on a console returned no waiter; the spawner would exit and take the window with it")
	}
	if got := wait(); got != 7 {
		t.Fatalf("waiter exit code = %d, want the replacement's 7", got)
	}
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
	isolateCoverage(t)
	if err := startInNewConsole(bin, []string{"-test.run=^$"}); err != nil {
		t.Fatal(err)
	}
	if got := awaitReport(t, report); got != "console" {
		t.Fatalf("replacement stdout = %s, want its own console", got)
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
