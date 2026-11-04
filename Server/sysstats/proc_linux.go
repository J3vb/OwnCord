//go:build linux

package sysstats

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// userHZ is the unit of /proc/<pid>/stat times. The kernel reports them in
// USER_HZ, which is 100 on every Linux architecture Go supports.
const userHZ = 100

func readProcess(pid int) (ProcessReading, bool) {
	return readProcessAt(hostPaths, pid)
}

func readProcessAt(p linuxPaths, pid int) (ProcessReading, bool) {
	dir := filepath.Join(p.proc, strconv.Itoa(pid))
	statText, ok := readText(filepath.Join(dir, "stat"))
	if !ok {
		return ProcessReading{}, false
	}
	cpuTicks, start, ok := parsePidStat(statText)
	if !ok {
		return ProcessReading{}, false
	}
	statmText, ok := readText(filepath.Join(dir, "statm"))
	if !ok {
		return ProcessReading{}, false
	}
	pages, ok := parseStatmResident(statmText)
	if !ok {
		return ProcessReading{}, false
	}
	return ProcessReading{
		CPU:   time.Duration(cpuTicks) * (time.Second / userHZ), //nolint:gosec // CPU ticks fit int64
		RSS:   pages * uint64(os.Getpagesize()),                 //nolint:gosec // page size is a small positive constant
		Start: start,
	}, true
}

// parsePidStat returns utime+stime in clock ticks and the start time (fields
// 14, 15 and 22 of /proc/<pid>/stat). comm, field 2, may hold spaces and
// parentheses, so fields are counted from after the last ')'.
func parsePidStat(text string) (cpuTicks, start uint64, ok bool) {
	_, rest, found := strings.CutLast(text, ")")
	if !found {
		return 0, 0, false
	}
	// f[0] is field 3 (state), so field n is f[n-3].
	f := strings.Fields(rest)
	if len(f) < 20 {
		return 0, 0, false
	}
	utime, err1 := strconv.ParseUint(f[11], 10, 64)
	stime, err2 := strconv.ParseUint(f[12], 10, 64)
	start, err3 := strconv.ParseUint(f[19], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, 0, false
	}
	return utime + stime, start, true
}
