package sysstats

import (
	"testing"
	"time"
)

const procStatFixture = `cpu  4705 356 584 3699 23 0 39 7 11 0
cpu0 1393 280 262 1777 12 0 25 3 5 0
intr 114930548 113199788 3 0 5 263 0 4 [... lots more numbers ...]
ctxt 1990473
`

func TestParseProcStat(t *testing.T) {
	busy, total, ok := parseProcStat(procStatFixture)
	if !ok {
		t.Fatal("parseProcStat: not ok")
	}
	// user..steal = 4705+356+584+3699+23+0+39+7; guest (11) is inside user.
	if wantTotal := uint64(9413); total != wantTotal {
		t.Errorf("total = %d, want %d", total, wantTotal)
	}
	if wantBusy := uint64(9413 - 3699 - 23); busy != wantBusy {
		t.Errorf("busy = %d, want %d", busy, wantBusy)
	}
	for _, bad := range []string{"", "intr 1 2 3\n", "cpu  a b c d e\n"} {
		if _, _, ok := parseProcStat(bad); ok {
			t.Errorf("parseProcStat(%q) ok, want not ok", bad)
		}
	}
}

func TestParseMeminfo(t *testing.T) {
	used, total, ok := parseMeminfo("MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6000000 kB\nBuffers:  100 kB\n")
	if !ok || total != 16000000*1024 || used != 10000000*1024 {
		t.Errorf("parseMeminfo = %d, %d, %v; want used 10000000 KiB of 16000000 KiB", used, total, ok)
	}
	// Kernels before 3.14 have no MemAvailable.
	used, total, ok = parseMeminfo("MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 300 kB\n")
	if !ok || total != 1000*1024 || used != 400*1024 {
		t.Errorf("old kernel parseMeminfo = %d, %d, %v; want used 400 KiB of 1000 KiB", used, total, ok)
	}
	if _, _, ok := parseMeminfo("MemFree: 1 kB\n"); ok {
		t.Error("parseMeminfo without MemTotal: ok, want not ok")
	}
}

func TestParseStatmResident(t *testing.T) {
	if pages, ok := parseStatmResident("120000 45210 3000 400 0 60000 0\n"); !ok || pages != 45210 {
		t.Errorf("parseStatmResident = %d, %v; want 45210", pages, ok)
	}
	if _, ok := parseStatmResident("1"); ok {
		t.Error("parseStatmResident(one field) ok, want not ok")
	}
}

func TestParseCgroupLimit(t *testing.T) {
	cases := []struct {
		in    string
		limit uint64
		set   bool
	}{
		{"max\n", 0, false},
		{"9223372036854771712\n", 0, false}, // v1 unlimited
		{"536870912\n", 536870912, true},
		{"", 0, false},
		{"garbage", 0, false},
	}
	for _, c := range cases {
		if limit, set := parseCgroupLimit(c.in); limit != c.limit || set != c.set {
			t.Errorf("parseCgroupLimit(%q) = %d, %v; want %d, %v", c.in, limit, set, c.limit, c.set)
		}
	}
}

func TestParseCgroupValue(t *testing.T) {
	if v, ok := parseCgroupValue("600000000\n"); !ok || v != 600000000 {
		t.Errorf("parseCgroupValue = %d, %v; want 600000000", v, ok)
	}
	if _, ok := parseCgroupValue("max"); ok {
		t.Error("parseCgroupValue(max) ok, want not ok")
	}
}

func TestParseStatKey(t *testing.T) {
	stat := "anon 100\nfile 900\ninactive_file 400\nactive_file 500\n"
	if v, ok := parseStatKey(stat, "inactive_file"); !ok || v != 400 {
		t.Errorf("parseStatKey = %d, %v; want 400", v, ok)
	}
	if _, ok := parseStatKey(stat, "total_inactive_file"); ok {
		t.Error("parseStatKey(absent key) ok, want not ok")
	}
}

func TestUsage(t *testing.T) {
	prev := Reading{ProcCPU: time.Second, ProcCPUOK: true, MachBusy: 100, MachTotal: 1000, MachCPUOK: true}
	cur := Reading{ProcCPU: 3 * time.Second, ProcCPUOK: true, MachBusy: 400, MachTotal: 2000, MachCPUOK: true}
	// 2 s of CPU over 10 s on 4 cores is 5% of the machine.
	proc, procOK, mach, machOK := Usage(prev, cur, 10*time.Second, 4)
	if !procOK || proc != 5 {
		t.Errorf("process = %v, %v; want 5", proc, procOK)
	}
	if !machOK || mach != 30 {
		t.Errorf("machine = %v, %v; want 30", mach, machOK)
	}
	// A counter that went backwards (a restarted counter) is not a reading.
	if _, procOK, _, machOK := Usage(cur, prev, 10*time.Second, 4); procOK || machOK {
		t.Error("Usage with counters going backwards reported ok")
	}
	if _, procOK, _, machOK := Usage(Reading{}, cur, 10*time.Second, 4); procOK || machOK {
		t.Error("Usage with a missing previous reading reported ok")
	}
}
