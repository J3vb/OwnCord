package sysstats

import "time"

// ProcessReading is one sample of another process: the CPU time it has used,
// its resident memory and a token for when it started. A pid can be reused, so
// two readings belong to the same process only when Start matches.
type ProcessReading struct {
	CPU   time.Duration
	RSS   uint64
	Start uint64
}

// ReadProcess reads the process with the given pid. ok is false when the
// process is gone, cannot be read, or the system cannot report it.
func ReadProcess(pid int) (ProcessReading, bool) {
	return readProcess(pid)
}
