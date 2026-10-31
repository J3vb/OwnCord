//go:build linux

package sysstats

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFixture(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, text := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

const meminfoFixture = "MemTotal: 16000000 kB\nMemAvailable: 6000000 kB\n"

func TestReadLinux_Host(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"proc/stat":       procStatFixture,
		"proc/self/statm": "1000 500 0 0 0 0 0\n",
		"proc/meminfo":    meminfoFixture,
		// A host's root cgroup carries no memory.max.
		"cgroup/cgroup.controllers": "cpu memory\n",
	})
	r := readLinux(linuxPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")})
	if !r.MachCPUOK || r.MachTotal != 9413 {
		t.Errorf("machine CPU = %d/%d ok=%v", r.MachBusy, r.MachTotal, r.MachCPUOK)
	}
	if !r.ProcMemOK || r.ProcMem != 500*uint64(os.Getpagesize()) {
		t.Errorf("process memory = %d ok=%v, want 500 pages", r.ProcMem, r.ProcMemOK)
	}
	if !r.MemOK || r.MemScope != ScopeMachine || r.MemTotal != 16000000*1024 {
		t.Errorf("memory = %d/%d scope=%q ok=%v, want the machine's", r.MemUsed, r.MemTotal, r.MemScope, r.MemOK)
	}
}

// Inside Docker with a memory limit, the limit is the total and the inactive
// file cache is not counted as used.
func TestReadLinux_ContainerLimitV2(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"proc/meminfo":          meminfoFixture,
		"cgroup/memory.max":     "1073741824\n",
		"cgroup/memory.current": "600000000\n",
		"cgroup/memory.stat":    "anon 300000000\ninactive_file 100000000\n",
	})
	r := readLinux(linuxPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")})
	if r.MemScope != ScopeContainer || r.MemTotal != 1073741824 || r.MemUsed != 500000000 {
		t.Errorf("memory = %d/%d scope=%q, want 500000000/1073741824 container", r.MemUsed, r.MemTotal, r.MemScope)
	}
}

func TestReadLinux_ContainerLimitV1(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"proc/meminfo":                        meminfoFixture,
		"cgroup/memory/memory.limit_in_bytes": "2147483648\n",
		"cgroup/memory/memory.usage_in_bytes": "1000000000\n",
		"cgroup/memory/memory.stat":           "cache 5\ntotal_inactive_file 200000000\n",
	})
	r := readLinux(linuxPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")})
	if r.MemScope != ScopeContainer || r.MemTotal != 2147483648 || r.MemUsed != 800000000 {
		t.Errorf("memory = %d/%d scope=%q, want 800000000/2147483648 container", r.MemUsed, r.MemTotal, r.MemScope)
	}
}

// A container without a limit, or one whose limit is above the host's RAM,
// reports the machine.
func TestReadLinux_ContainerNoLimit(t *testing.T) {
	for name, limit := range map[string]string{"unset": "max\n", "above host": "99999999999999\n"} {
		root := t.TempDir()
		writeFixture(t, root, map[string]string{
			"proc/meminfo":          meminfoFixture,
			"cgroup/memory.max":     limit,
			"cgroup/memory.current": "600000000\n",
		})
		r := readLinux(linuxPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")})
		if r.MemScope != ScopeMachine || r.MemTotal != 16000000*1024 {
			t.Errorf("%s: memory = %d/%d scope=%q, want the machine's", name, r.MemUsed, r.MemTotal, r.MemScope)
		}
	}
}

// Missing files leave figures missing, never zero.
func TestReadLinux_NothingReadable(t *testing.T) {
	root := t.TempDir()
	r := readLinux(linuxPaths{proc: filepath.Join(root, "proc"), cgroup: filepath.Join(root, "cgroup")})
	if r.MachCPUOK || r.ProcMemOK || r.MemOK {
		t.Errorf("reading = %+v, want every figure missing", r)
	}
}

// The real reader works on the machine running the tests.
func TestRead_ThisMachine(t *testing.T) {
	r := Read()
	if !r.ProcCPUOK || !r.ProcMemOK || r.ProcMem == 0 || !r.MemOK || r.MemTotal == 0 {
		t.Errorf("Read() = %+v, want process CPU and memory and machine memory", r)
	}
}
