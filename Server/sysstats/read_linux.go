//go:build linux

package sysstats

import (
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// linuxPaths are the roots the Linux reader reads under; tests point them at a
// fixture directory.
type linuxPaths struct {
	proc   string
	cgroup string
}

var hostPaths = linuxPaths{proc: "/proc", cgroup: "/sys/fs/cgroup"}

func readSystem() Reading {
	r := readLinux(hostPaths)
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err == nil {
		r.ProcCPU = time.Duration(ru.Utime.Nano() + ru.Stime.Nano())
		r.ProcCPUOK = true
	}
	return r
}

// readLinux reads everything but this process's CPU time from the files under
// p. A file that is missing or malformed leaves its figures not ok.
func readLinux(p linuxPaths) Reading {
	var r Reading
	if text, ok := readText(filepath.Join(p.proc, "stat")); ok {
		r.MachBusy, r.MachTotal, r.MachCPUOK = parseProcStat(text)
	}
	if text, ok := readText(filepath.Join(p.proc, "self", "statm")); ok {
		if pages, ok := parseStatmResident(text); ok {
			r.ProcMem = pages * uint64(os.Getpagesize()) //nolint:gosec // page size is a small positive constant
			r.ProcMemOK = true
		}
	}
	if text, ok := readText(filepath.Join(p.proc, "meminfo")); ok {
		r.MemUsed, r.MemTotal, r.MemOK = parseMeminfo(text)
		if r.MemOK {
			r.MemScope = ScopeMachine
		}
	}
	if used, limit, ok := containerMemory(p.cgroup); ok && (!r.MemOK || limit < r.MemTotal) {
		r.MemUsed, r.MemTotal, r.MemOK, r.MemScope = used, limit, true, ScopeContainer
	}
	return r
}

// containerMemory reads this cgroup's memory limit and use, v2 first, then v1.
// It reports ok only when a limit is set, which is the case inside a container
// started with a memory limit and never on a plain host. Used leaves out the
// inactive file cache, as `docker stats` does, since the kernel reclaims it
// before the limit is hit.
func containerMemory(root string) (used, limit uint64, ok bool) {
	layouts := []struct{ limit, current, stat, inactiveKey string }{
		{"memory.max", "memory.current", "memory.stat", "inactive_file"},
		{"memory/memory.limit_in_bytes", "memory/memory.usage_in_bytes", "memory/memory.stat", "total_inactive_file"},
	}
	for _, l := range layouts {
		text, found := readText(filepath.Join(root, l.limit))
		if !found {
			continue
		}
		lim, set := parseCgroupLimit(text)
		if !set {
			return 0, 0, false
		}
		curText, found := readText(filepath.Join(root, l.current))
		if !found {
			return 0, 0, false
		}
		cur, valid := parseCgroupValue(curText)
		if !valid {
			return 0, 0, false
		}
		if statText, found := readText(filepath.Join(root, l.stat)); found {
			if inactive, ok := parseStatKey(statText, l.inactiveKey); ok && inactive <= cur {
				cur -= inactive
			}
		}
		return min(cur, lim), lim, true
	}
	return 0, 0, false
}

func readText(path string) (string, bool) {
	b, err := os.ReadFile(path) //nolint:gosec // fixed /proc and cgroup paths
	if err != nil {
		return "", false
	}
	return string(b), true
}
