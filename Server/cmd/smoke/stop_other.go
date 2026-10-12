//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"syscall"
)

// gracefulStopName names the stop this platform can actually deliver, so a
// failure message says which mechanism was tried.
const gracefulStopName = "SIGTERM"

// newProcessGroup isolates the server in its own process group so the signal
// below reaches it alone, never the harness or its siblings.
func newProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func stopGracefully(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}

// strayServers finds the processes whose working directory is one of dirs, by
// reading /proc. A self-restart replacement inherits its parent's working
// directory, and each drill install directory is a fresh temp directory, so a
// match is a process this run started, directly or through a restart. Where
// there is no /proc (macOS) it finds nothing and the caller says so.
func strayServers(dirs []string) []int {
	want := make(map[string]bool, len(dirs))
	for _, dir := range dirs {
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			want[resolved] = true
		}
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	self := os.Getpid()
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self {
			continue
		}
		cwd, err := os.Readlink("/proc/" + e.Name() + "/cwd")
		if err == nil && want[cwd] {
			pids = append(pids, pid)
		}
	}
	return pids
}

func terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

func kill(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
