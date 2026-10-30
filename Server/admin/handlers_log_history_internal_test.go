package admin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var historyBase = time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)

// writeHistoryFile writes entries as the writer would, one JSON line each.
func writeHistoryFile(t *testing.T, dir, name string, entries []LogEntry, trailing string) {
	t.Helper()
	var b strings.Builder
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	b.WriteString(trailing)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

// historyFixture saves three days of hourly entries, oldest first:
// day 0 in two parts, then day 1 and day 2.
func historyFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	mk := func(day, from, to int) []LogEntry {
		var out []LogEntry
		for h := from; h < to; h++ {
			level := "INFO"
			if h%5 == 0 {
				level = "WARN"
			}
			ts := historyBase.Add(time.Duration(day)*24*time.Hour + time.Duration(h)*time.Minute)
			out = append(out, LogEntry{Timestamp: ts.Format(time.RFC3339Nano), Level: level, Message: fmt.Sprintf("d%d m%d", day, h), Source: "http", Attrs: `{"path":"/api/v1/x<y>"}`})
		}
		return out
	}
	writeHistoryFile(t, dir, "owncord-2026-10-28.log", mk(0, 0, 30), "")
	writeHistoryFile(t, dir, "owncord-2026-10-28.1.log", mk(0, 30, 60), "")
	writeHistoryFile(t, dir, "owncord-2026-10-29.log", mk(1, 0, 60), "")
	// The writer's buffer flushed mid-line: the half line is not a result.
	writeHistoryFile(t, dir, "owncord-2026-10-30.log", mk(2, 0, 60), `{"ts":"2026-10-30T11:00:00Z","level":"ERR`)
	return dir
}

func historyQuery(t *testing.T, raw string) logHistoryQuery {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/logs/history?"+raw, nil)
	q, problem := parseLogHistoryQuery(r, historyBase.Add(30*24*time.Hour))
	if problem != "" {
		t.Fatalf("parse %q: %s", raw, problem)
	}
	return q
}

func readAll(t *testing.T, dir string, q logHistoryQuery) ([]LogEntry, int) {
	t.Helper()
	var all []LogEntry
	pages := 0
	for {
		resp, err := readLogHistory(context.Background(), dir, q)
		if err != nil {
			t.Fatalf("readLogHistory: %v", err)
		}
		pages++
		all = append(all, resp.Entries...)
		if resp.NextCursor == "" {
			return all, pages
		}
		q.cursor, _ = decodeLogCursor(resp.NextCursor)
		if pages > 100 {
			t.Fatal("paging did not end")
		}
	}
}

func TestLogHistory_PagesNewestFirstAcrossFiles(t *testing.T) {
	dir := historyFixture(t)
	q := historyQuery(t, "")
	q.limit = 25
	all, pages := readAll(t, dir, q)
	if len(all) != 180 {
		t.Fatalf("got %d entries, want 180 (the half line skipped)", len(all))
	}
	if pages != 8 {
		t.Fatalf("pages = %d, want 8", pages)
	}
	if all[0].Message != "d2 m59" || all[179].Message != "d0 m0" {
		t.Fatalf("order: first %q last %q", all[0].Message, all[179].Message)
	}
	seen := map[string]bool{}
	for i, e := range all {
		if seen[e.Message] {
			t.Fatalf("%q returned twice", e.Message)
		}
		seen[e.Message] = true
		if i > 0 && e.Timestamp > all[i-1].Timestamp {
			t.Fatalf("not newest first at %d: %s after %s", i, e.Timestamp, all[i-1].Timestamp)
		}
	}
}

func TestLogHistory_FiltersTimeLevelAndText(t *testing.T) {
	dir := historyFixture(t)
	from := historyBase.Add(24*time.Hour + 10*time.Minute).Format(time.RFC3339)
	to := historyBase.Add(24*time.Hour + 40*time.Minute).Format(time.RFC3339)
	all, _ := readAll(t, dir, historyQuery(t, "from="+url.QueryEscape(from)+"&to="+url.QueryEscape(to)))
	if len(all) != 31 || all[0].Message != "d1 m40" || all[30].Message != "d1 m10" {
		t.Fatalf("time range: %d entries, %q..%q", len(all), all[0].Message, all[len(all)-1].Message)
	}

	warn, _ := readAll(t, dir, historyQuery(t, "level=WARN"))
	if len(warn) != 36 {
		t.Fatalf("WARN only: %d, want 36", len(warn))
	}

	text, _ := readAll(t, dir, historyQuery(t, "q=D1+M5"))
	if len(text) != 11 { // m5 and m50..m59
		t.Fatalf("text search: %d, want 11", len(text))
	}
	// < and > are escaped in the saved JSON; the search still finds them.
	escaped, _ := readAll(t, dir, historyQuery(t, "q="+url.QueryEscape("x<y>")))
	if len(escaped) != 180 {
		t.Fatalf("escaped search: %d, want 180", len(escaped))
	}
}

func TestLogHistory_RejectsBadParams(t *testing.T) {
	for _, raw := range []string{"from=yesterday", "to=1", "level=TRACE", "cursor=!!", "cursor=" + encodeLogCursorRaw("../../etc/passwd:0"),
		"from=2026-10-30T00:00:00Z&to=2026-10-29T00:00:00Z", "q=" + strings.Repeat("a", 201)} {
		w := httptest.NewRecorder()
		handleLogHistory(t.TempDir())(w, httptest.NewRequest(http.MethodGet, "/logs/history?"+raw, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", raw, w.Code)
		}
	}
}

func encodeLogCursorRaw(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func TestLogHistory_OffAnswersDisabled(t *testing.T) {
	w := httptest.NewRecorder()
	handleLogHistory("")(w, httptest.NewRequest(http.MethodGet, "/logs/history", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
}

// Edge case: the file a cursor points into was deleted by the cleanup between
// pages. The next page reads as if that file were empty and goes on to older
// ones instead of failing.
func TestLogHistory_CursorIntoDeletedFileContinuesWithOlder(t *testing.T) {
	dir := historyFixture(t)
	q := historyQuery(t, "")
	q.limit = 10
	resp, err := readLogHistory(context.Background(), dir, q)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "owncord-2026-10-30.log")); err != nil {
		t.Fatal(err)
	}
	q.cursor, _ = decodeLogCursor(resp.NextCursor)
	next, err := readLogHistory(context.Background(), dir, q)
	if err != nil {
		t.Fatalf("read after delete: %v", err)
	}
	if len(next.Entries) != 10 || next.Entries[0].Message != "d1 m59" {
		t.Fatalf("next page starts at %+v", next.Entries)
	}
}

// Edge case: history reads run while the writer rotates and the cleanup
// deletes files. Run under -race: no read fails and no data race.
func TestLogHistory_ReadsDuringRotationAndCleanup(t *testing.T) {
	dir := t.TempDir()
	clock := newTestClock(historyBase)
	ctx, cancel := context.WithCancel(context.Background())
	lf := StartLogFile(ctx, LogFileOptions{Dir: dir, MaxAge: 2 * 24 * time.Hour, MaxBytes: 4000, now: clock.now, fileCap: 500})

	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			q := historyQuery(t, "q=line")
			q.limit = 20
			if _, err := readLogHistory(context.Background(), dir, q); err != nil {
				t.Errorf("read during rotation: %v", err)
				return
			}
		}
	})
	for i := range 2000 {
		lf.Enqueue(entryAt(clock.now(), "INFO", fmt.Sprintf("line %d", i)))
		if i%200 == 0 {
			clock.add(12 * time.Hour)
		}
		if i%50 == 0 {
			time.Sleep(time.Millisecond)
		}
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	lf.Stop(stopCtx)
	cancel()
	close(stop)
	wg.Wait()

	var total int64
	files, _ := listLogFiles(dir)
	for _, f := range files {
		total += f.size
	}
	if total > 4000+600 {
		t.Fatalf("saved %d bytes, cap is 4000 plus one open file", total)
	}
}

func TestScanLinesBackward_LongLinesAcrossChunks(t *testing.T) {
	long := strings.Repeat("a", logHistoryChunk+10)
	data := "first\n" + long + "\nlast\n"
	var got []string
	err := scanLinesBackward(context.Background(), strings.NewReader(data), int64(len(data)), func(line []byte, start int64) error {
		if data[start:start+int64(len(line))] != string(line) {
			t.Fatalf("start %d does not match line", start)
		}
		got = append(got, string(line))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0] != "last" || got[1] != long || got[2] != "first" {
		t.Fatalf("lines = %d, first %q", len(got), got[0])
	}
}
