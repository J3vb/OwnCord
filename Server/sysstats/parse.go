package sysstats

import (
	"bufio"
	"strconv"
	"strings"
)

// The Linux text formats, parsed here without a build tag so their tests run
// on every system.

// unlimitedCgroup is the smallest value a cgroup v1 memory limit reports when
// no limit is set (the kernel prints a page-rounded max int64).
const unlimitedCgroup = 1 << 62

// parseProcStat reads the aggregate "cpu" line of /proc/stat. Total is user
// through steal; guest time is already inside user, so it is not added again.
// Busy is total minus idle and iowait.
func parseProcStat(text string) (busy, total uint64, ok bool) {
	for line := range strings.Lines(text) {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		var vals [8]uint64
		for i := range vals {
			if i+1 >= len(fields) {
				break
			}
			v, err := strconv.ParseUint(fields[i+1], 10, 64)
			if err != nil {
				return 0, 0, false
			}
			vals[i] = v
		}
		for _, v := range vals {
			total += v
		}
		idle := vals[3] + vals[4]
		if idle > total {
			return 0, 0, false
		}
		return total - idle, total, true
	}
	return 0, 0, false
}

// parseMeminfo reads MemTotal and MemAvailable from /proc/meminfo, in bytes.
// A kernel too old for MemAvailable falls back to free + buffers + cached.
func parseMeminfo(text string) (used, total uint64, ok bool) {
	kib := map[string]uint64{}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		key, rest, found := strings.Cut(sc.Text(), ":")
		if !found {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		kib[key] = v
	}
	total, hasTotal := kib["MemTotal"]
	if !hasTotal || total == 0 {
		return 0, 0, false
	}
	avail, hasAvail := kib["MemAvailable"]
	if !hasAvail {
		avail = kib["MemFree"] + kib["Buffers"] + kib["Cached"]
	}
	if avail > total {
		avail = total
	}
	return (total - avail) * 1024, total * 1024, true
}

// parseStatmResident reads the resident page count, the second field of
// /proc/self/statm.
func parseStatmResident(text string) (pages uint64, ok bool) {
	fields := strings.Fields(text)
	if len(fields) < 2 {
		return 0, false
	}
	v, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseCgroupLimit reads a cgroup memory limit file: v2's memory.max ("max"
// when unset) or v1's memory.limit_in_bytes (a huge number when unset).
func parseCgroupLimit(text string) (limit uint64, set bool) {
	s := strings.TrimSpace(text)
	if s == "" || s == "max" {
		return 0, false
	}
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil || v == 0 || v >= unlimitedCgroup {
		return 0, false
	}
	return v, true
}

// parseCgroupValue reads a single-number cgroup file such as memory.current.
func parseCgroupValue(text string) (uint64, bool) {
	v, err := strconv.ParseUint(strings.TrimSpace(text), 10, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// parseStatKey reads one "key value" line of a cgroup memory.stat file.
func parseStatKey(text, key string) (uint64, bool) {
	for line := range strings.Lines(text) {
		k, v, found := strings.Cut(strings.TrimSpace(line), " ")
		if !found || k != key {
			continue
		}
		n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}
