//go:build linux

package sysstats

import (
	"os"
	"testing"
	"time"
)

const pidStat = "4242 (live kit) (x) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 987654 1000000 500 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n"

func TestReadProcessAt(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"4242/stat":  pidStat,
		"4242/statm": "9999 300 100 10 0 50 0\n",
	})
	got, ok := readProcessAt(linuxPaths{proc: root}, 4242)
	if !ok {
		t.Fatal("not ok")
	}
	want := ProcessReading{CPU: 3 * time.Second, RSS: 300 * uint64(os.Getpagesize()), Start: 987654}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestReadProcessAt_Missing(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"1/stat":  pidStat,
		"2/stat":  "2 (x) S 1\n",
		"2/statm": "1 1 1\n",
		"3/stat":  pidStat,
		"3/statm": "garbage\n",
	})
	for _, pid := range []int{1, 2, 3, 99} {
		if got, ok := readProcessAt(linuxPaths{proc: root}, pid); ok {
			t.Errorf("pid %d: ok with %+v", pid, got)
		}
	}
}

func TestParsePidStat_CommWithParens(t *testing.T) {
	cpu, start, ok := parsePidStat(pidStat)
	if !ok || cpu != 300 || start != 987654 {
		t.Errorf("got %d %d %v", cpu, start, ok)
	}
	if _, _, ok := parsePidStat("no parens here"); ok {
		t.Error("text without ')' parsed")
	}
}

func TestReadProcess_Self(t *testing.T) {
	r, ok := ReadProcess(os.Getpid())
	if !ok || r.RSS == 0 || r.Start == 0 {
		t.Errorf("self: %+v ok=%v", r, ok)
	}
}
