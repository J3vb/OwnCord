package admin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/J3vb/OwnCord/Server/httperr"
)

const (
	logHistoryPageSize  = 200
	logHistoryMaxQuery  = 200
	logHistoryChunk     = 64 << 10
	logHistoryMaxLine   = 1 << 20
	logHistoryScanLimit = 64 << 20
	// logHistoryOrderSlack is how far a line may sit out of time order in a
	// file: a record keeps its creation time but reaches the writer after
	// any record logged at the same moment by another goroutine. The scan
	// only stops once a line is this far before "from".
	logHistoryOrderSlack = time.Minute
	// logHistoryDaySlack lets a file dated the day after "to" still be read:
	// a line logged just before midnight can land in the next day's file.
	logHistoryDaySlack  = 24 * time.Hour
	logHistoryOpenTries = 5
	logHistoryOpenRetry = 20 * time.Millisecond
)

// logHistoryResponse is GET /logs/history's answer. Entries are newest first.
// NextCursor continues to older entries; empty means the start of the saved
// history was reached. Partial means the page stopped at the scan limit before
// it filled, so fewer than a page of matches does not mean there are no more.
type logHistoryResponse struct {
	Enabled    bool       `json:"enabled"`
	Entries    []LogEntry `json:"entries"`
	NextCursor string     `json:"next_cursor,omitempty"`
	Partial    bool       `json:"partial,omitempty"`
}

// logHistoryQuery is a parsed, validated GET /logs/history request.
type logHistoryQuery struct {
	from, to time.Time
	levels   map[string]bool
	// levelTags are the `"level":"X"` texts a wanted line carries, checked
	// on the raw line before it is decoded.
	levelTags [][]byte
	text      string
	raw       []byte // lower-case search for the raw-line pre-check, nil when it cannot be used
	cursor    logHistoryCursor
	limit     int
}

// logHistoryCursor is a position to read backwards from: entries before byte
// offset in file key. The zero value starts at the newest entry.
type logHistoryCursor struct {
	set    bool
	key    logFileKey
	offset int64
}

func encodeLogCursor(key logFileKey, offset int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(key.name() + ":" + strconv.FormatInt(offset, 10)))
}

func decodeLogCursor(s string) (logHistoryCursor, bool) {
	if s == "" {
		return logHistoryCursor{}, true
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return logHistoryCursor{}, false
	}
	name, off, ok := strings.Cut(string(b), ":")
	if !ok {
		return logHistoryCursor{}, false
	}
	key, ok := parseLogFileName(name)
	if !ok {
		return logHistoryCursor{}, false
	}
	// A file never passes logFileMaxCap, so an offset always fits 32 bits.
	offset, err := strconv.ParseInt(off, 10, 32)
	if err != nil || offset < 0 {
		return logHistoryCursor{}, false
	}
	return logHistoryCursor{set: true, key: key, offset: offset}, true
}

func parseLogHistoryQuery(r *http.Request, now time.Time) (logHistoryQuery, string) {
	v := r.URL.Query()
	q := logHistoryQuery{to: now, limit: logHistoryPageSize}
	if s := v.Get("from"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return q, "from must be an RFC 3339 time"
		}
		q.from = t
	}
	if s := v.Get("to"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return q, "to must be an RFC 3339 time"
		}
		q.to = t
	}
	if !q.from.IsZero() && q.from.After(q.to) {
		return q, "from must be before to"
	}
	if s := v.Get("level"); s != "" {
		q.levels = map[string]bool{}
		for l := range strings.SplitSeq(s, ",") {
			l = strings.ToUpper(strings.TrimSpace(l))
			switch l {
			case "DEBUG", "INFO", "WARN", "ERROR":
				q.levels[l] = true
				q.levelTags = append(q.levelTags, []byte(`"level":"`+l+`"`))
			default:
				return q, "level must be DEBUG, INFO, WARN or ERROR"
			}
		}
	}
	q.text = strings.ToLower(strings.TrimSpace(v.Get("q")))
	if len(q.text) > logHistoryMaxQuery {
		return q, "search is too long"
	}
	if q.text != "" && rawSearchable(q.text) {
		q.raw = []byte(q.text)
	}
	cur, ok := decodeLogCursor(v.Get("cursor"))
	if !ok {
		return q, "invalid cursor"
	}
	q.cursor = cur
	return q, ""
}

// rawSearchable reports whether text appears verbatim in a saved line whenever
// it appears in a decoded field, so a raw byte search can skip lines before
// decoding them. JSON escapes quotes, backslashes, <, > and &, and may escape
// other non-ASCII or control text, so those searches always decode.
func rawSearchable(text string) bool {
	for _, c := range text {
		if c > unicode.MaxASCII || c < 0x20 || strings.ContainsRune(`"\<>&`, c) {
			return false
		}
	}
	return true
}

// lineTime reads the timestamp a saved line starts with, without decoding the
// rest. LogEntry marshals ts first.
func lineTime(line []byte) (time.Time, bool) {
	const prefix = `{"ts":"`
	if !bytes.HasPrefix(line, []byte(prefix)) {
		return time.Time{}, false
	}
	ts, _, ok := bytes.Cut(line[len(prefix):], []byte(`"`))
	if !ok {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, string(ts))
	return t, err == nil
}

func (q *logHistoryQuery) matches(e *LogEntry) bool {
	if q.levels != nil && !q.levels[e.Level] {
		return false
	}
	if q.text == "" {
		return true
	}
	return strings.Contains(strings.ToLower(e.Message), q.text) ||
		strings.Contains(strings.ToLower(e.Source), q.text) ||
		strings.Contains(strings.ToLower(e.Attrs), q.text)
}

// errLogScanStop ends a backwards scan early; it is not a failure.
var errLogScanStop = errors.New("stop")

// scanLinesBackward calls fn for each complete line in f before byte end,
// newest first, with the line's start offset. A trailing line with no newline
// (the writer's buffer flushed mid-line) is skipped, as is any line longer
// than logHistoryMaxLine. It returns fn's error, or ctx's.
func scanLinesBackward(ctx context.Context, f io.ReaderAt, end int64, fn func(line []byte, start int64) error) error {
	pos := end
	var tail []byte
	seenNewline := false
	for pos > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		n := logHistoryChunk
		if pos < int64(n) {
			n = int(pos)
		}
		pos -= int64(n)
		buf := make([]byte, n+len(tail))
		if _, err := f.ReadAt(buf[:n], pos); err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		copy(buf[n:], tail)
		lineEnd := len(buf)
		if !seenNewline {
			j := bytes.LastIndexByte(buf, '\n')
			if j < 0 {
				tail = nil
				continue
			}
			lineEnd, seenNewline = j, true
		}
		for {
			k := bytes.LastIndexByte(buf[:lineEnd], '\n')
			if k < 0 {
				break
			}
			if line := buf[k+1 : lineEnd]; len(line) > 0 {
				if err := fn(line, pos+int64(k+1)); err != nil {
					return err
				}
			}
			lineEnd = k
		}
		tail = buf[:lineEnd]
		if len(tail) > logHistoryMaxLine {
			// Too long to be one of ours; drop it and find the next newline.
			tail, seenNewline = nil, false
		}
	}
	if seenNewline && len(tail) > 0 {
		return fn(tail, 0)
	}
	return nil
}

// readLogHistory pages through the files in dir, newest first.
func readLogHistory(ctx context.Context, dir string, q logHistoryQuery) (logHistoryResponse, error) {
	resp := logHistoryResponse{Enabled: true, Entries: []LogEntry{}}
	files, err := listLogFiles(dir)
	if err != nil {
		return resp, err
	}
	fromDay := ""
	if !q.from.IsZero() {
		fromDay = q.from.UTC().Format(time.DateOnly)
	}
	toDay := q.to.UTC().Add(logHistoryDaySlack).Format(time.DateOnly)
	var scanned int64
	for _, fi := range slices.Backward(files) {
		if q.cursor.set && q.cursor.key.less(fi.key) {
			continue
		}
		if fi.key.day > toDay {
			continue
		}
		if fi.key.day < fromDay {
			break
		}
		end := fi.size
		if q.cursor.set && fi.key == q.cursor.key {
			end = min(end, q.cursor.offset)
		}
		done, err := readLogFile(ctx, dir, fi.key, end, &q, &resp, &scanned)
		if err != nil {
			return resp, err
		}
		if done {
			return resp, nil
		}
	}
	return resp, nil
}

// openLogFile opens a history file, trying again for a moment while Windows
// holds it busy, which happens while the cleanup deletes it.
func openLogFile(ctx context.Context, path string) (*os.File, error) {
	for range logHistoryOpenTries - 1 {
		f, err := os.Open(path) //nolint:gosec // G304: path is built from a name checked by parseLogFileName
		if err == nil || !logFileBusy(err) {
			return f, err
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("opening log history file: %w", ctx.Err())
		case <-time.After(logHistoryOpenRetry):
		}
	}
	f, err := os.Open(path) //nolint:gosec // G304: path is built from a name checked by parseLogFileName
	return f, err
}

// readLogFile scans one file backwards from end, adding matches to resp. It
// reports true when the page is complete, the scan limit was hit, or the scan
// went past "from", so no older file needs reading. A file deleted by cleanup
// after it was listed reads as empty.
func readLogFile(ctx context.Context, dir string, key logFileKey, end int64, q *logHistoryQuery, resp *logHistoryResponse, scanned *int64) (bool, error) {
	f, err := openLogFile(ctx, filepath.Join(dir, key.name()))
	if err != nil {
		if logFileGone(err) {
			return false, nil
		}
		return false, err
	}
	defer func() { _ = f.Close() }()
	pastFrom := false
	err = scanLinesBackward(ctx, f, end, func(line []byte, start int64) error {
		*scanned += int64(len(line)) + 1
		if *scanned > logHistoryScanLimit {
			resp.NextCursor, resp.Partial = encodeLogCursor(key, start+int64(len(line))+1), true
			return errLogScanStop
		}
		ts, ok := lineTime(line)
		if !ok || ts.After(q.to) {
			return nil
		}
		if !q.from.IsZero() && ts.Before(q.from) {
			if ts.Before(q.from.Add(-logHistoryOrderSlack)) {
				pastFrom = true
				return errLogScanStop
			}
			return nil
		}
		if q.levelTags != nil && !slices.ContainsFunc(q.levelTags, func(tag []byte) bool { return bytes.Contains(line, tag) }) {
			return nil
		}
		if q.raw != nil && !bytes.Contains(bytes.ToLower(line), q.raw) {
			return nil
		}
		var e LogEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return nil //nolint:nilerr // a damaged line is skipped, not a failed read
		}
		if !q.matches(&e) {
			return nil
		}
		resp.Entries = append(resp.Entries, e)
		if len(resp.Entries) >= q.limit {
			resp.NextCursor = encodeLogCursor(key, start)
			return errLogScanStop
		}
		return nil
	})
	if errors.Is(err, errLogScanStop) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return pastFrom, nil
}

// handleLogHistory serves GET /logs/history: saved log lines, newest first,
// filtered by time range, level and text, a page at a time. An empty dir means
// history is off, which is answered as enabled:false rather than an error so
// the page can say why.
func handleLogHistory(dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dir == "" {
			writeJSON(w, http.StatusOK, logHistoryResponse{Entries: []LogEntry{}})
			return
		}
		q, problem := parseLogHistoryQuery(r, time.Now())
		if problem != "" {
			writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, problem)
			return
		}
		resp, err := readLogHistory(r.Context(), dir, q)
		if err != nil {
			if r.Context().Err() != nil {
				return
			}
			slog.Error("log history: reading saved logs failed", "err", err)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not read saved logs")
			return
		}
		writeJSON(w, http.StatusOK, resp)
	}
}
