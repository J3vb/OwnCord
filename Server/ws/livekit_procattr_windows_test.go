//go:build windows

package ws

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The companion must die with chatserver however it exits: when the job
// handle closes, KILL_ON_JOB_CLOSE kills the child and frees its ports.
func TestKillOnCloseJob_KillsCompanionWhenHandleCloses(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cmd := exec.Command(bin, "--config", filepath.Join(dir, "livekit.yaml")) //nolint:gosec // G204: the test binary itself
	cmd.Env = append(os.Environ(), "OWNCORD_LIVEKIT_TEST_PROCESS=graceful")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-exited })

	job, err := newKillOnCloseJob()
	if err != nil {
		t.Fatal(err)
	}
	if err := assignProcessToJob(job, cmd.Process); err != nil {
		_ = windows.CloseHandle(job)
		t.Fatal(err)
	}
	waitForLiveKitTestFile(t, filepath.Join(dir, "listeners.json"))
	listeners := readLiveKitTestListeners(t, dir)

	if err := windows.CloseHandle(job); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(15 * time.Second):
		t.Fatal("companion still running after its job handle closed")
	}
	assertLiveKitPortsReleased(t, listeners)
}

// runLoop must put every companion it starts into the process-wide job.
func TestLiveKitProcess_CompanionJoinsKillOnCloseJob(t *testing.T) {
	p, _ := startLiveKitTestProcess(t, "graceful")
	p.mu.Lock()
	pid := p.cmd.Process.Pid
	p.mu.Unlock()

	job, err := liveKitJob()
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid)) //nolint:gosec // G115: a Windows PID is a DWORD
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h) //nolint:errcheck // test cleanup
	var inJob int32
	r, _, callErr := windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob").
		Call(uintptr(h), uintptr(job), uintptr(unsafe.Pointer(&inJob)))
	if r == 0 {
		t.Fatalf("IsProcessInJob: %v", callErr)
	}
	if inJob == 0 {
		t.Error("companion is not in the kill-on-close job; it would outlive chatserver")
	}
}
