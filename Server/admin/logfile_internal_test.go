package admin

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testClock is a settable clock the writer goroutine can read under -race.
type testClock struct{ ns atomic.Int64 }

func newTestClock(t time.Time) *testClock {
	c := &testClock{}
	c.set(t)
	return c
}
func (c *testClock) set(t time.Time)     { c.ns.Store(t.UnixNano()) }
func (c *testClock) now() time.Time      { return time.Unix(0, c.ns.Load()).UTC() }
func (c *testClock) add(d time.Duration) { c.set(c.now().Add(d)) }

func logFileNames(t *testing.T, dir string) []string {
	t.Helper()
	files, err := listLogFiles(dir)
	if err != nil {
		t.Fatalf("listLogFiles: %v", err)
	}
	names := make([]string, 0, len(files))
	for _, f := range files {
		names = append(names, f.key.name())
	}
	return names
}

func readLogLines(t *testing.T, path string) []LogEntry {
	t.Helper()
	f, err := os.Open(path) //nolint:gosec // test file
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()
	var out []LogEntry
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var e LogEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			t.Fatalf("line %q: %v", sc.Text(), err)
		}
		out = append(out, e)
	}
	return out
}

func entryAt(ts time.Time, level, msg string) LogEntry {
	return LogEntry{Timestamp: ts.Format(time.RFC3339Nano), Level: level, Message: msg, Source: "server"}
}

func TestLogFile_NewFileEachDayAndAtSizeCap(t *testing.T) {
	dir := t.TempDir()
	clock := newTestClock(time.Date(2026, 10, 30, 23, 59, 0, 0, time.UTC))
	lf := newLogFile(LogFileOptions{Dir: dir, MaxAge: 7 * 24 * time.Hour, MaxBytes: 1 << 30, now: clock.now, fileCap: 150}, func() {})
	defer lf.closeFile()

	for i := range 3 {
		lf.write(entryAt(clock.now(), "INFO", "first day "+strings.Repeat("x", i)))
	}
	clock.add(2 * time.Minute)
	lf.write(entryAt(clock.now(), "INFO", "second day"))
	lf.closeFile()

	got := logFileNames(t, dir)
	want := []string{"owncord-2026-10-30.log", "owncord-2026-10-30.1.log", "owncord-2026-10-31.log"}
	if !slices.Equal(got, want) {
		t.Fatalf("files = %v, want %v", got, want)
	}
	if e := readLogLines(t, filepath.Join(dir, "owncord-2026-10-31.log")); len(e) != 1 || e[0].Message != "second day" {
		t.Fatalf("second day file = %+v", e)
	}
}

func TestLogFile_RestartAppendsToTodaysFile(t *testing.T) {
	dir := t.TempDir()
	clock := newTestClock(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
	opts := LogFileOptions{Dir: dir, MaxAge: 7 * 24 * time.Hour, MaxBytes: 1 << 30, now: clock.now}
	for _, msg := range []string{"before restart", "after restart"} {
		lf := newLogFile(opts, func() {})
		lf.write(entryAt(clock.now(), "INFO", msg))
		lf.closeFile()
	}
	got := readLogLines(t, filepath.Join(dir, "owncord-2026-10-30.log"))
	if len(got) != 2 || got[0].Message != "before restart" || got[1].Message != "after restart" {
		t.Fatalf("entries = %+v", got)
	}
}

// A crash mid-flush leaves half a line at the end of today's file. After a
// restart the first new entry still gets a line of its own.
func TestLogFile_RestartAfterHalfWrittenLineStartsANewLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "owncord-2026-10-30.log")
	if err := os.WriteFile(path, []byte(`{"ts":"2026-10-30T11:00:00Z","level":"INFO","msg":"whole"}`+"\n"+`{"ts":"2026-10-30T11:00:01Z","lev`), 0o600); err != nil {
		t.Fatal(err)
	}
	clock := newTestClock(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
	lf := newLogFile(LogFileOptions{Dir: dir, MaxAge: 7 * 24 * time.Hour, MaxBytes: 1 << 30, now: clock.now}, func() {})
	lf.write(entryAt(clock.now(), "INFO", "after restart"))
	lf.closeFile()

	q := historyQuery(t, "")
	resp, err := readLogHistory(context.Background(), dir, q)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Entries) != 2 || resp.Entries[0].Message != "after restart" || resp.Entries[1].Message != "whole" {
		t.Fatalf("entries = %+v", resp.Entries)
	}
}

func TestLogFile_SweepDeletesOldFilesThenOldestPastSizeCap(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, size int) {
		if err := os.WriteFile(filepath.Join(dir, name), make([]byte, size), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("owncord-2026-10-20.log", 10) // older than 7 days
	write("owncord-2026-10-25.log", 400)
	write("owncord-2026-10-26.log", 400)
	write("owncord-2026-10-26.1.log", 400)
	write("owncord-2026-10-29.log", 400)
	write("notes.txt", 10) // not ours, never touched
	clock := newTestClock(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
	lf := newLogFile(LogFileOptions{Dir: dir, MaxAge: 7 * 24 * time.Hour, MaxBytes: 1000, now: clock.now}, func() {})
	lf.sweep()

	got := logFileNames(t, dir)
	want := []string{"owncord-2026-10-26.1.log", "owncord-2026-10-29.log"}
	if !slices.Equal(got, want) {
		t.Fatalf("files = %v, want %v", got, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.txt")); err != nil {
		t.Fatalf("a file the writer did not create was touched: %v", err)
	}
}

// Edge case: the folder cannot be written. The writer warns, drops lines for
// the rest of the day without retrying per line, and tries again the next day.
func TestLogFile_UnwritableFolderPausesUntilTheNextDay(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "logs")
	// A regular file where the folder should be: MkdirAll fails, as root too.
	if err := os.WriteFile(dir, []byte("in the way"), 0o600); err != nil {
		t.Fatal(err)
	}
	clock := newTestClock(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
	lf := newLogFile(LogFileOptions{Dir: dir, MaxAge: 7 * 24 * time.Hour, MaxBytes: 1 << 30, now: clock.now}, func() {})
	defer lf.closeFile()

	lf.write(entryAt(clock.now(), "INFO", "lost"))
	if lf.failedDay != "2026-10-30" {
		t.Fatalf("failedDay = %q, want the day of the failure", lf.failedDay)
	}
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	lf.write(entryAt(clock.now(), "INFO", "same day, still paused"))
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("writer retried on the day it failed: %v", err)
	}

	clock.add(24 * time.Hour)
	lf.write(entryAt(clock.now(), "INFO", "next day"))
	lf.closeFile()
	got := readLogLines(t, filepath.Join(dir, "owncord-2026-10-31.log"))
	if len(got) != 1 || got[0].Message != "next day" {
		t.Fatalf("entries = %+v", got)
	}
}

func TestLogFile_StopWritesWhatIsQueued(t *testing.T) {
	dir := t.TempDir()
	clock := newTestClock(time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC))
	lf := StartLogFile(context.Background(), LogFileOptions{Dir: dir, MaxAge: 7 * 24 * time.Hour, MaxBytes: 1 << 30, now: clock.now})
	for i := range 500 {
		lf.Enqueue(entryAt(clock.now(), "INFO", "line "+strings.Repeat("y", i%7)))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	lf.Stop(ctx)
	if ctx.Err() != nil {
		t.Fatal("Stop did not return before its deadline")
	}
	if got := readLogLines(t, filepath.Join(dir, "owncord-2026-10-30.log")); len(got) != 500 {
		t.Fatalf("saved %d lines, want 500", len(got))
	}
}

func TestRingBuffer_SetHistoryFeedsTheWriter(t *testing.T) {
	rb := NewRingBuffer(10)
	lf := newLogFile(LogFileOptions{Dir: t.TempDir(), MaxBytes: 1 << 30}, func() {})
	rb.SetHistory(lf)
	rb.Write(LogEntry{Message: "saved"})
	rb.SetHistory(nil)
	rb.Write(LogEntry{Message: "not saved"})
	if n := len(lf.queue); n != 1 {
		t.Fatalf("queued %d entries, want 1", n)
	}
	if e := <-lf.queue; e.Message != "saved" {
		t.Fatalf("queued %q", e.Message)
	}
}
