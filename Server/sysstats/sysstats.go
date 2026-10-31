// Package sysstats reads how busy this process and its machine are: CPU time
// and memory, with per-OS readers behind build tags. Linux reads /proc (and the
// container's memory limit inside Docker), Windows asks kernel32, and every
// other system reports this process's own figures from the Go runtime. A
// figure a system cannot give is reported as missing, never as zero.
package sysstats

import (
	"runtime"
	"time"
)

// Memory scopes: what MemUsed and MemTotal describe.
const (
	ScopeMachine   = "machine"
	ScopeContainer = "container"
)

// Reading is one raw sample. CPU figures are cumulative counters, so a
// percentage needs two readings (Usage); memory figures are current values.
type Reading struct {
	// ProcCPU is the CPU time this process has used since it started.
	ProcCPU   time.Duration
	ProcCPUOK bool
	// MachBusy and MachTotal are the machine's busy and total CPU time since
	// boot, in a unit only their ratio gives meaning to.
	MachBusy, MachTotal uint64
	MachCPUOK           bool
	// ProcMem is this process's resident memory in bytes.
	ProcMem   uint64
	ProcMemOK bool
	// MemUsed and MemTotal are the machine's (or, inside a container with a
	// memory limit, the container's) used and total memory in bytes.
	MemUsed, MemTotal uint64
	MemOK             bool
	MemScope          string
}

// Read takes one reading of this process and its machine.
func Read() Reading {
	return readSystem()
}

// Cores is the number of logical CPUs this process may use.
func Cores() int {
	return runtime.NumCPU()
}

// Usage is the CPU use between two readings taken elapsed apart, as a
// percentage of the whole machine: ProcPct counts this process over every
// core, so it compares directly with MachPct. A figure missing from either
// reading, or a counter that went backwards, is reported as not ok.
func Usage(prev, cur Reading, elapsed time.Duration, cores int) (procPct float64, procOK bool, machPct float64, machOK bool) {
	if prev.ProcCPUOK && cur.ProcCPUOK && elapsed > 0 && cores > 0 && cur.ProcCPU >= prev.ProcCPU {
		procPct = clampPct(float64(cur.ProcCPU-prev.ProcCPU) / (float64(elapsed) * float64(cores)) * 100)
		procOK = true
	}
	if prev.MachCPUOK && cur.MachCPUOK && cur.MachTotal > prev.MachTotal && cur.MachBusy >= prev.MachBusy {
		machPct = clampPct(float64(cur.MachBusy-prev.MachBusy) / float64(cur.MachTotal-prev.MachTotal) * 100)
		machOK = true
	}
	return procPct, procOK, machPct, machOK
}

func clampPct(v float64) float64 {
	return min(max(v, 0), 100)
}
