package admin

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync/atomic"
	"time"
)

// Saved log history: every entry the live viewer gets is also written, as one
// JSON line, to data/logs/owncord-YYYY-MM-DD[.N].log. A day starts a new file,
// and so does a file reaching its size cap (".1", ".2", ...). Files older than
// the configured age, then the oldest files past the total-size cap, are
// deleted. The history route reads these files and nothing else does.

const (
	logFileQueue    = 4096
	logFileBuffer   = 64 << 10
	logFileMaxCap   = 50 << 20
	logFileMinCap   = 1 << 20
	logFileFlushGap = time.Second
	logFileSweepGap = time.Hour
)

// logFileName matches the files the writer creates; the history route accepts
// only these names, so a cursor cannot point anywhere else.
var logFileName = regexp.MustCompile(`^owncord-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$`)

// logFileKey orders history files: by day, then by part within a day.
type logFileKey struct {
	day  string
	part int
}

func (k logFileKey) less(o logFileKey) bool {
	if k.day != o.day {
		return k.day < o.day
	}
	return k.part < o.part
}

func (k logFileKey) name() string {
	if k.part == 0 {
		return "owncord-" + k.day + ".log"
	}
	return "owncord-" + k.day + "." + strconv.Itoa(k.part) + ".log"
}

func parseLogFileName(name string) (logFileKey, bool) {
	m := logFileName.FindStringSubmatch(name)
	if m == nil {
		return logFileKey{}, false
	}
	if _, err := time.Parse(time.DateOnly, m[1]); err != nil {
		return logFileKey{}, false
	}
	part := 0
	if m[2] != "" {
		n, err := strconv.Atoi(m[2])
		if err != nil || n <= 0 {
			return logFileKey{}, false
		}
		part = n
	}
	return logFileKey{day: m[1], part: part}, true
}

// logFileInfo is one history file on disk.
type logFileInfo struct {
	key  logFileKey
	size int64
}

// listLogFiles returns the history files in dir, oldest first. A missing
// directory is an empty history.
func listLogFiles(dir string) ([]logFileInfo, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading log history directory: %w", err)
	}
	out := make([]logFileInfo, 0, len(ents))
	for _, e := range ents {
		if !e.Type().IsRegular() {
			continue
		}
		key, ok := parseLogFileName(e.Name())
		if !ok {
			continue
		}
		info, err := e.Info()
		if err != nil {
			// Deleted between ReadDir and Info: it is gone, skip it.
			continue
		}
		out = append(out, logFileInfo{key: key, size: info.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key.less(out[j].key) })
	return out, nil
}

// LogFileOptions configures StartLogFile.
type LogFileOptions struct {
	Dir      string
	MaxAge   time.Duration
	MaxBytes int64
	// now and fileCap replace the clock and the per-file size cap in tests.
	now     func() time.Time
	fileCap int64
}

// LogFile is the history writer. Enqueue never blocks: a full queue drops the
// line and counts it, so logging never waits on the disk.
type LogFile struct {
	opts    LogFileOptions
	fileCap int64
	queue   chan LogEntry
	dropped atomic.Int64
	cancel  context.CancelFunc
	done    chan struct{}

	// Owned by the writer goroutine.
	f         *os.File
	bw        *bufio.Writer
	cur       logFileKey
	size      int64
	failedDay string
}

// StartLogFile starts the writer goroutine on ctx. It runs until ctx ends or
// Stop is called, and writes whatever is still queued before it exits.
func StartLogFile(ctx context.Context, opts LogFileOptions) *LogFile {
	ctx, cancel := context.WithCancel(ctx)
	lf := newLogFile(opts, cancel)
	go lf.run(ctx)
	return lf
}

func newLogFile(opts LogFileOptions, cancel context.CancelFunc) *LogFile {
	if opts.now == nil {
		opts.now = time.Now
	}
	fileCap := min(int64(logFileMaxCap), opts.MaxBytes/4)
	fileCap = max(fileCap, logFileMinCap)
	if opts.fileCap > 0 {
		fileCap = opts.fileCap
	}
	return &LogFile{
		opts:    opts,
		fileCap: fileCap,
		queue:   make(chan LogEntry, logFileQueue),
		cancel:  cancel,
		done:    make(chan struct{}),
	}
}

// Enqueue hands an entry to the writer without blocking.
func (lf *LogFile) Enqueue(entry LogEntry) {
	select {
	case lf.queue <- entry:
	default:
		lf.dropped.Add(1)
	}
}

// Stop ends the writer and waits for it to write what is queued and close its
// file, or for ctx to end first.
func (lf *LogFile) Stop(ctx context.Context) {
	lf.cancel()
	select {
	case <-lf.done:
	case <-ctx.Done():
	}
}

func (lf *LogFile) run(ctx context.Context) {
	defer close(lf.done)
	defer lf.closeFile()
	lf.sweep()
	flush := time.NewTicker(logFileFlushGap)
	defer flush.Stop()
	sweep := time.NewTicker(logFileSweepGap)
	defer sweep.Stop()
	for {
		select {
		case entry := <-lf.queue:
			lf.write(entry)
		case <-flush.C:
			lf.flush()
			if n := lf.dropped.Swap(0); n > 0 {
				slog.Warn("log history: lines dropped because the disk writer fell behind", "count", n)
			}
		case <-sweep.C:
			lf.sweep()
		case <-ctx.Done():
			for {
				select {
				case entry := <-lf.queue:
					lf.write(entry)
				default:
					return
				}
			}
		}
	}
}

func (lf *LogFile) write(entry LogEntry) {
	day := lf.opts.now().UTC().Format(time.DateOnly)
	if lf.failedDay != "" {
		if lf.failedDay == day {
			return
		}
		lf.failedDay = ""
	}
	if lf.f == nil || lf.cur.day != day || lf.size >= lf.fileCap {
		if err := lf.rotate(day); err != nil {
			lf.fail(day, err)
			return
		}
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')
	n, err := lf.bw.Write(line)
	lf.size += int64(n)
	if err != nil {
		lf.fail(day, err)
	}
}

// rotate closes the current file and opens the newest part for day, or the
// next part when that one is full.
func (lf *LogFile) rotate(day string) error {
	rotated := lf.f != nil
	lf.closeFile()
	if err := os.MkdirAll(lf.opts.Dir, 0o750); err != nil {
		return fmt.Errorf("creating log history directory: %w", err)
	}
	key := logFileKey{day: day}
	var size int64
	files, err := listLogFiles(lf.opts.Dir)
	if err != nil {
		return err
	}
	for _, fi := range files {
		if fi.key.day == day && !fi.key.less(key) {
			key, size = fi.key, fi.size
		}
	}
	if size >= lf.fileCap {
		key.part++
		size = 0
	}
	f, err := os.OpenFile(filepath.Join(lf.opts.Dir, key.name()), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640) //nolint:gosec // G304: name is built from a date and a counter, not from input
	if err != nil {
		return fmt.Errorf("opening log history file: %w", err)
	}
	lf.f, lf.bw, lf.cur, lf.size = f, bufio.NewWriterSize(f, logFileBuffer), key, size
	if rotated {
		lf.sweep()
	}
	return nil
}

// fail stops disk writes until the next day starts, and says so once.
func (lf *LogFile) fail(day string, err error) {
	lf.closeFile()
	lf.failedDay = day
	slog.Warn("log history: saving logs to disk paused until tomorrow", "dir", lf.opts.Dir, "err", err)
}

func (lf *LogFile) flush() {
	if lf.bw == nil {
		return
	}
	if err := lf.bw.Flush(); err != nil {
		lf.fail(lf.opts.now().UTC().Format(time.DateOnly), err)
	}
}

func (lf *LogFile) closeFile() {
	if lf.f == nil {
		return
	}
	_ = lf.bw.Flush()
	_ = lf.f.Close()
	lf.f, lf.bw = nil, nil
}

// sweep deletes files past the age limit, then the oldest files until the
// total fits the size cap. The open file is never deleted. A delete that fails
// (on Windows, a file a history read has open) is retried on the next sweep.
func (lf *LogFile) sweep() {
	files, err := listLogFiles(lf.opts.Dir)
	if err != nil {
		return
	}
	oldest := lf.opts.now().UTC().Add(-lf.opts.MaxAge).Format(time.DateOnly)
	var total int64
	for _, fi := range files {
		total += fi.size
	}
	for _, fi := range files {
		if lf.f != nil && fi.key == lf.cur {
			continue
		}
		if fi.key.day >= oldest && total <= lf.opts.MaxBytes {
			break
		}
		if err := os.Remove(filepath.Join(lf.opts.Dir, fi.key.name())); err == nil || os.IsNotExist(err) {
			total -= fi.size
		}
	}
}
