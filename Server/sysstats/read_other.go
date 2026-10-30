//go:build !linux && !windows

package sysstats

import (
	"runtime/metrics"
	"time"
)

// otherSamples are the Go runtime's own estimates: the CPU time it has spent
// (everything but idle) and the memory it has mapped. No machine figures.
var otherSamples = []metrics.Sample{
	{Name: "/cpu/classes/total:cpu-seconds"},
	{Name: "/cpu/classes/idle:cpu-seconds"},
	{Name: "/memory/classes/total:bytes"},
}

func readSystem() Reading {
	s := make([]metrics.Sample, len(otherSamples))
	copy(s, otherSamples)
	metrics.Read(s)
	var r Reading
	if s[0].Value.Kind() == metrics.KindFloat64 && s[1].Value.Kind() == metrics.KindFloat64 {
		if used := s[0].Value.Float64() - s[1].Value.Float64(); used >= 0 {
			r.ProcCPU = time.Duration(used * float64(time.Second))
			r.ProcCPUOK = true
		}
	}
	if s[2].Value.Kind() == metrics.KindUint64 {
		r.ProcMem, r.ProcMemOK = s[2].Value.Uint64(), true
	}
	return r
}
