package db

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// B6-11 drill 9 — byte-level erasure.
//
// TestHP4_D1_ErasureLeavesNoClass proves logical absence: every inventory
// class counts zero once EraseAccount returns. This drill measures the physical
// claim docs/trust-model.md makes beside it — whether the erased bytes are
// still on disk anywhere in the set that claim names: the database file, its
// -wal and -shm sidecars, the uploads directory, the backup directory and
// data/erasure/markers.sqlite. E1 asserts that absence outright, for the shape
// the claim describes; E2, E3 and E4 measure it across the three recovery
// shapes where the truncating checkpoint the claim rests on cannot run, which
// is why the two halves of this drill are split the way they are below.
//
// One sentinel string is planted in the subject's rows and in its upload, and
// every file in that set is then scanned for it with bytes.Count — the check
// an operator holding the disk can run, and the only shape that can show a
// freed page or a stale WAL frame rather than a row. Each scenario starts from
// a fresh copy of the alpha snapshot (drillCopy) and plants with the writer's
// autocheckpoint off, so the planted rows are frames of the WAL rather than
// pages of the database file when the erasure runs: that is the state the
// claim's "freed pages or the WAL" sentence is about.
//
// E1 (idle) asserts the claim unconditionally: with no reader in the way,
// EraseAccount's own wal_checkpoint(TRUNCATE) is the whole recovery and no file
// in the set holds the sentinel afterwards.
//
// E2 (a reader holds the checkpoint off), E3 (a close that cannot checkpoint)
// and E4 (a crash between the commit and the checkpoint) measure the three
// recovery shapes the claim has never had a row for, and log the full table:
// every path with its count, PRAGMA freelist_count, and the -wal size. What
// they assert is what holds whatever the recovery did in between — that every
// path which must be on disk was read, that the uploads, backup and marker
// files hold nothing, and that no file which was clean when the erasure
// committed has gained a copy since. The per-file byte count stays a
// measurement in those three: it is the number the milestone reads, not a
// constant this suite may pin.
//
//	go test -count=1 -v -run TestB611_Erasure ./db/

// b611MarkerKey is the drill's erasure key. Any value works — this file's
// tokens are never matched against another installation's — but it must be 32
// bytes.
const b611MarkerKey = 11

// b611SentinelPrefix names the planted string: this prefix plus 16 hex
// characters, unique per scenario, so one scenario's database can never be
// scanned for another scenario's sentinel.
const b611SentinelPrefix = "OCB611-"

// b611World is one scenario's fixture: a fresh copy of the alpha snapshot, the
// directories and the marker file the scan walks, the subject the erasure is
// about, and the sentinel planted in that subject's rows and upload.
type b611World struct {
	db          *DB
	dbPath      string
	uploads     string
	backups     string
	markerPath  string
	markers     *MarkerStore
	sentinel    string
	userID      int64
	otherUserID int64
	token       string
}

func newB611World(t *testing.T) *b611World {
	t.Helper()
	ctx := context.Background()
	database, dbPath := drillCopy(t)

	root := t.TempDir()
	uploads := filepath.Join(root, "uploads")
	backups := filepath.Join(root, "backups")
	for _, dir := range []string{uploads, backups} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	markerPath := filepath.Join(root, "data", "erasure", "markers.sqlite")
	markers, err := OpenMarkerStore(markerPath, testMarkerKey(b611MarkerKey))
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	t.Cleanup(func() { _ = markers.Close() })

	// The plant's frames have to still be in the WAL when the erasure runs:
	// at the default autocheckpoint a commit that fills the log would copy its
	// pages into the database file behind the drill's back. Off for the plant;
	// E2 turns it back on when it wants the next checkpoint to happen.
	if _, err := database.ExecContext(ctx, `PRAGMA wal_autocheckpoint=0`); err != nil {
		t.Fatalf("wal_autocheckpoint=0: %v", err)
	}

	sentinel, userID := plantSentinel(t, database, uploads)
	var other int64
	if err := database.QueryRowContext(ctx, `SELECT id FROM users WHERE id != ? ORDER BY id LIMIT 1`, userID).Scan(&other); err != nil {
		t.Fatalf("pick another user: %v", err)
	}
	// The marker goes down pending before the erasure and is confirmed after
	// it, the order ErasureService.Erase uses: a crash between the two leaves a
	// marker the next open applies.
	seq, err := database.SequenceValue(ctx, SequenceFloorUsers)
	if err != nil {
		t.Fatalf("SequenceValue: %v", err)
	}
	token, _, err := markers.RecordPendingAccount(ctx, userID, seq)
	if err != nil {
		t.Fatalf("RecordPendingAccount: %v", err)
	}

	return &b611World{
		db: database, dbPath: dbPath,
		uploads: uploads, backups: backups, markerPath: markerPath, markers: markers,
		sentinel: sentinel, userID: userID, otherUserID: other, token: token,
	}
}

// paths is the scan set: the database and its two sidecars, the uploads and
// backup directories, and the marker file with its own sidecars. The marker
// file lives outside the database's directory on purpose (B4-10): a restore
// overwrites one and not the other.
func (w *b611World) paths() []string {
	return b611ScanPaths(w.dbPath, w.uploads, w.backups, w.markerPath)
}

func b611ScanPaths(dbPath, uploads, backups, markerPath string) []string {
	return []string{
		dbPath, dbPath + "-wal", dbPath + "-shm",
		uploads, backups,
		markerPath, markerPath + "-wal", markerPath + "-shm",
	}
}

// scan counts the sentinel in every file of the world's scan set.
func (w *b611World) scan(t *testing.T) map[string]int {
	t.Helper()
	return scanForSentinel(t, w.sentinel, w.paths()...)
}

// erase runs db.EraseAccount with the pending marker confirmed behind it, as
// ErasureService.Erase orders the two, and returns the job. The logs the
// erasure writes on a path that cannot checkpoint are captured and returned
// rather than printed — they are part of the measurement, and a warning line
// in the middle of the drill's table is noise — for the caller to log beside
// the scan it belongs to.
func (w *b611World) erase(t *testing.T) (*ErasureJob, string) {
	t.Helper()
	var job *ErasureJob
	logs := b611SilenceLogs(func() {
		var err error
		job, err = w.db.EraseAccount(context.Background(), w.userID, w.token)
		if err != nil {
			t.Fatalf("EraseAccount: %v", err)
		}
	})
	if err := w.markers.ConfirmAccount(context.Background(), w.token); err != nil {
		t.Fatalf("ConfirmAccount: %v", err)
	}
	return job, logs
}

// removeJobFiles is the file half ErasureService.runJob performs once the
// database half has committed: every stored_as the erasure journaled is
// removed, and a file that is already gone counts as removed. Written out here
// because service imports db and a db test cannot import it back.
func (w *b611World) removeJobFiles(t *testing.T, job *ErasureJob) {
	t.Helper()
	for _, name := range job.Files {
		if err := os.Remove(filepath.Join(w.uploads, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("remove %s: %v", name, err)
		}
	}
	if n := countFiles(t, w.uploads); n != 0 {
		t.Fatalf("the uploads directory still holds %d files after the file half ran", n)
	}
}

// backup takes the drill's backup through the production path (BackupToSafe →
// VACUUM INTO) into the fixture's backup directory: a backup taken after an
// erasure must carry none of the erased bytes.
func (w *b611World) backup(t *testing.T, database *DB) {
	t.Helper()
	path := filepath.Join(w.backups, "b611-backup.db")
	if err := database.BackupToSafe(context.Background(), path, w.backups); err != nil {
		t.Fatalf("BackupToSafe: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("backup not written: %v", err)
	}
}

// plantSentinel seeds one subject with everything the erasure has to take: 200
// messages whose content carries the sentinel, one of them edited afterwards so
// the FTS index's update path rewrites a row that names it, one attachment row
// whose file under upload.storage_dir holds the sentinel in its bytes, and one
// DM. It returns the sentinel and the subject's id.
func plantSentinel(t *testing.T, database *DB, uploads string) (string, int64) {
	t.Helper()
	ctx := context.Background()
	sentinel := b611SentinelPrefix + b611Hex(t, 8)

	userID, err := database.CreateUser(ctx, "b611-subject", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	for i := range 200 {
		if _, err := database.ExecContext(ctx,
			`INSERT INTO messages (channel_id, user_id, content) VALUES (1, ?, ?)`,
			userID, fmt.Sprintf("b611 plant %03d %s", i, sentinel)); err != nil {
			t.Fatalf("insert message %d: %v", i, err)
		}
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE messages SET content = content || ' edited' WHERE id = (SELECT MAX(id) FROM messages WHERE user_id = ?)`,
		userID); err != nil {
		t.Fatalf("edit message: %v", err)
	}

	id := "b611-att-" + b611Hex(t, 8)
	storedAs := id + ".bin"
	body := []byte("b611 upload body " + sentinel + "\n")
	if err := os.WriteFile(filepath.Join(uploads, storedAs), body, 0o600); err != nil {
		t.Fatalf("write upload: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size)
		 VALUES (?, ?, 'b611.bin', ?, 'application/octet-stream', ?)`,
		id, userID, storedAs, len(body)); err != nil {
		t.Fatalf("insert attachment: %v", err)
	}

	var partner int64
	if err := database.QueryRowContext(ctx, `SELECT id FROM users WHERE id != ? ORDER BY id LIMIT 1`, userID).Scan(&partner); err != nil {
		t.Fatalf("pick a DM partner: %v", err)
	}
	if _, _, err := database.GetOrCreateDMChannel(ctx, userID, partner); err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	return sentinel, userID
}

// b611SilenceLogs redirects the default slog logger to a buffer for the
// duration of fn and returns what it wrote. The erasure's own report of a
// checkpoint it could not complete is part of the measurement; a warning line
// in the middle of the drill's table is noise. audit_test.go's captureLogs is
// this shape but lives in package db_test, which this file cannot reach.
func b611SilenceLogs(fn func()) string {
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)
	fn()
	return buf.String()
}

// b611Hex is n bytes of random hex, so every scenario's sentinel and planted
// file names are its own.
func b611Hex(t *testing.T, n int) string {
	t.Helper()
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(buf)
}

// scanForSentinel counts sentinel's occurrences in every file under each root
// and returns one count per path. A root is a file or a directory; a
// directory's own key is the total across the files inside it, so the uploads
// and backup directories report their whole contents on one line as well as
// per file. Every root is a key of the result — a path that is not on disk
// counts -1, visibly distinct from a file that was read and holds nothing — so
// a table of zeros can never be a table of paths nobody opened.
func scanForSentinel(t *testing.T, sentinel string, roots ...string) map[string]int {
	t.Helper()
	needle := []byte(sentinel)
	counts := make(map[string]int, len(roots))
	for _, root := range roots {
		info, err := os.Stat(root)
		if errors.Is(err, fs.ErrNotExist) {
			counts[root] = -1
			continue
		}
		if err != nil {
			t.Fatalf("scan %s: %v", root, err)
		}
		if !info.IsDir() {
			counts[root] = b611CountIn(t, root, needle)
			continue
		}
		total := 0
		err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			count := b611CountIn(t, path, needle)
			counts[path] = count
			total += count
			return nil
		})
		if err != nil {
			t.Fatalf("scan %s: %v", root, err)
		}
		counts[root] = total
	}
	return counts
}

func b611CountIn(t *testing.T, path string, needle []byte) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return bytes.Count(data, needle)
}

// b611Display names a path in the logged table: the database and its sidecars
// by their role, everything else by its own file name, so the table reads the
// same whatever temporary directory is underneath.
func b611Display(dbPath, path string) string {
	switch path {
	case dbPath:
		return "db"
	case dbPath + "-wal":
		return "db-wal"
	case dbPath + "-shm":
		return "db-shm"
	}
	return filepath.Base(path)
}

// b611Size is a file's size in bytes, 0 when it is not on disk: a WAL that was
// truncated or deleted holds nothing, and the table says that with a zero
// rather than a missing row.
func b611Size(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

// b611LogScan writes one scan point as the table this drill exists to produce:
// every path the scan read with its sentinel count, then the two numbers the
// claim is read against — PRAGMA freelist_count and the -wal size. database may
// be nil where the handle is closed at the point being measured, in which case
// the freelist is reported as unread rather than guessed at.
func b611LogScan(t *testing.T, label string, database *DB, dbPath string, counts map[string]int) {
	t.Helper()
	paths := make([]string, 0, len(counts))
	for path := range counts {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	var b strings.Builder
	fmt.Fprintf(&b, "%s\n| Path | Sentinel bytes |\n| --- | ---: |\n", label)
	for _, path := range paths {
		name := b611Display(dbPath, path)
		if counts[path] < 0 {
			fmt.Fprintf(&b, "| %s | absent |\n", name)
			continue
		}
		fmt.Fprintf(&b, "| %s | %d |\n", name, counts[path])
	}
	freelist := "not read (no handle on these bytes)"
	wal := "not read"
	if database != nil {
		var n int
		if err := database.QueryRowContext(context.Background(), `PRAGMA freelist_count`).Scan(&n); err != nil {
			freelist = "unreadable: " + err.Error()
		} else {
			freelist = strconv.Itoa(n)
		}
		wal = b611WalState(database)
	}
	fmt.Fprintf(&b, "freelist_count %s; -wal %d bytes; %s\n", freelist, b611Size(dbPath+"-wal"), wal)
	t.Log(b.String())
}

// b611WalState reads the WAL's checkpoint state without running one
// (wal_checkpoint(NOOP)): log is the number of frames in the WAL and
// checkpointed how many of them are already in the database file, so a scan
// can show whether "the next checkpoint" ran and still left the bytes on disk.
func b611WalState(database *DB) string {
	var busy, log, checkpointed int
	if err := database.QueryRowContext(context.Background(), `PRAGMA wal_checkpoint(NOOP)`).Scan(&busy, &log, &checkpointed); err != nil {
		return "wal state unreadable: " + err.Error()
	}
	return fmt.Sprintf("wal busy=%d log=%d checkpointed=%d", busy, log, checkpointed)
}

// b611LogEraseLogs prints the erasure's own log lines for a scan point, when
// that path wrote any: on E2/E3 the erasure says its checkpoint was incomplete,
// on E4 it reports the checkpoint that could not run at all. That record is
// part of the measurement.
func b611LogEraseLogs(t *testing.T, label, logs string) {
	t.Helper()
	if logs != "" {
		t.Logf("%s — erasure logs:\n%s", label, logs)
	}
}

// assertB611Planted is the drill's positive control: the sentinel has to be
// readable in the WAL and in the upload before the erasure, or a table of zeros
// afterwards proves nothing — the scan would be finding no trace because there
// was none to find.
func assertB611Planted(t *testing.T, w *b611World, counts map[string]int) {
	t.Helper()
	if n := counts[w.dbPath+"-wal"]; n <= 0 {
		t.Fatalf("the planted rows left %d sentinel bytes in the WAL: the drill has nothing to erase", n)
	}
	if n := counts[w.uploads]; n <= 0 {
		t.Fatalf("the planted upload holds %d sentinel bytes: the drill has nothing to remove", n)
	}
}

// assertB611Clean fails when any path the scan read still holds the sentinel. A
// path that is not on disk holds nothing and is not a failure.
func assertB611Clean(t *testing.T, what, dbPath string, counts map[string]int) {
	t.Helper()
	for path, n := range counts {
		if n > 0 {
			t.Errorf("%s: %s still holds the sentinel %d times", what, b611Display(dbPath, path), n)
		}
	}
}

// assertB611Readable fails when a path that must exist at this point was not on
// disk to read at all: either the scan never read it, or it counted -1 because
// the file was not there. It is the completeness guard that can fail — a key's
// mere presence proves nothing, since scanForSentinel writes one for every root
// it was handed whether or not the file exists — so a zero can never be a file
// the drill never opened.
func assertB611Readable(t *testing.T, dbPath string, counts map[string]int, must ...string) {
	t.Helper()
	for _, path := range must {
		n, ok := counts[path]
		if !ok {
			t.Errorf("the scan never read %s: it is not one of the paths the scan was given", b611Display(dbPath, path))
			continue
		}
		if n < 0 {
			t.Errorf("%s is not on disk, so the scan read nothing there", b611Display(dbPath, path))
		}
	}
}

// assertB611NoNewCopy fails when a file that held no sentinel at reference now
// holds one: neither the erasure nor the recovery behind it may move the erased
// bytes into a file that was clean. The two tables are compared by role —
// "db-wal" against "db-wal" — because E4's restart reads the same bytes under a
// different path.
func assertB611NoNewCopy(t *testing.T, refPath, countsPath string, reference, counts map[string]int) {
	t.Helper()
	was := make(map[string]int, len(reference))
	for path, n := range reference {
		was[b611Display(refPath, path)] = n
	}
	for path, n := range counts {
		if name := b611Display(countsPath, path); n > 0 && was[name] <= 0 {
			t.Errorf("%s held no sentinel when the erasure committed and now holds %d", name, n)
		}
	}
}

// assertB611Settled is what every scenario's last scan must hold whatever the
// recovery did in between: the uploads directory, the backup directory and the
// marker file hold no sentinel bytes (the file half has run, the backup was
// taken after the erasure, and the marker file names its subject by an HMAC);
// and no file that was clean when the erasure committed has gained a copy
// since, which is what makes the erasure stick rather than move.
func assertB611Settled(t *testing.T, w *b611World, refPath, dbPath string, reference, counts map[string]int) {
	t.Helper()
	for _, path := range []string{w.uploads, w.backups, w.markerPath, w.markerPath + "-wal", w.markerPath + "-shm"} {
		if n := counts[path]; n > 0 {
			t.Errorf("%s still holds the sentinel %d times", b611Display(dbPath, path), n)
		}
	}
	assertB611NoNewCopy(t, refPath, dbPath, reference, counts)
}

// b611Reader is a read transaction held open on the reader pool: the reader
// whose presence makes the erasure's wal_checkpoint(TRUNCATE) return busy. It
// is opened with raw BEGIN/SELECT rather than BeginTx so the test can hold it
// across the erasure and end it with whichever statement the scenario needs.
type b611Reader struct {
	conn *sql.Conn
}

func b611HoldReader(t *testing.T, database *DB) *b611Reader {
	t.Helper()
	ctx := context.Background()
	conn, err := database.reader.Conn(ctx)
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		t.Fatalf("reader BEGIN: %v", err)
	}
	var n int
	if err := conn.QueryRowContext(ctx, `SELECT count(*) FROM messages`).Scan(&n); err != nil {
		t.Fatalf("reader SELECT count(*) FROM messages: %v", err)
	}
	if n == 0 {
		t.Fatal("the reader read no rows: its read transaction holds no snapshot")
	}
	return &b611Reader{conn: conn}
}

// end finishes the read transaction with statement and hands the connection
// back. When the database was closed first the pool closes the connection
// underneath it here, which is where SQLite runs the last-close checkpoint.
func (r *b611Reader) end(t *testing.T, statement string) {
	t.Helper()
	if _, err := r.conn.ExecContext(context.Background(), statement); err != nil {
		t.Fatalf("reader %s: %v", statement, err)
	}
	if err := r.conn.Close(); err != nil {
		t.Fatalf("reader conn close: %v", err)
	}
}

// b611CopyFile copies one file of the crash image, tolerating its absence: a
// clean close removes the -wal and -shm, and a crash may leave either.
func b611CopyFile(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatalf("read %s: %v", src, err)
	}
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", dst, err)
	}
}

func TestB611_ErasureBytes(t *testing.T) {
	t.Run("E1_idle", b611E1Idle)
	t.Run("E2_active_reader", b611E2ActiveReader)
	t.Run("E3_checkpoint_failed", b611E3CheckpointFailed)
	t.Run("E4_crash_restart", b611E4CrashRestart)
}

// E1 — Idle: no reader, nothing in the way. EraseAccount's own
// wal_checkpoint(TRUNCATE) is the whole recovery, and the claim is
// unconditional for this shape: every file in the set is clean afterwards.
func b611E1Idle(t *testing.T) {
	w := newB611World(t)
	before := w.scan(t)
	b611LogScan(t, "E1 before the erasure (planted)", w.db, w.dbPath, before)
	assertB611Planted(t, w, before)

	job, logs := w.erase(t)
	w.removeJobFiles(t, job)
	w.backup(t, w.db)

	after := w.scan(t)
	b611LogEraseLogs(t, "E1 (idle)", logs)
	b611LogScan(t, "E1 after the erasure (idle)", w.db, w.dbPath, after)
	assertB611Readable(t, w.dbPath, after, w.dbPath, w.dbPath+"-wal", w.uploads, w.backups, w.markerPath)
	assertB611Settled(t, w, w.dbPath, w.dbPath, before, after)
	assertB611Clean(t, "E1 (idle)", w.dbPath, after)
}

// E2 — Active reader: a read transaction is open on the reader pool before the
// erasure runs, so the checkpoint behind the commit cannot complete and the
// WAL keeps every frame the transaction wrote — and every older frame of the
// pages it rewrote. The three counts are the row the claim has never had: while
// the reader is held, after it commits, and after the checkpoint SQLite runs by
// itself, which is the "next one" erasure.go's log line promises.
func b611E2ActiveReader(t *testing.T) {
	w := newB611World(t)
	ctx := context.Background()
	before := w.scan(t)
	b611LogScan(t, "E2 before the erasure (planted)", w.db, w.dbPath, before)
	assertB611Planted(t, w, before)

	reader := b611HoldReader(t, w.db)
	job, logs := w.erase(t)
	w.removeJobFiles(t, job)
	w.backup(t, w.db)

	held := w.scan(t)
	b611LogEraseLogs(t, "E2 (reader held)", logs)
	b611LogScan(t, "E2 scan 1: the reader still holds its read transaction", w.db, w.dbPath, held)
	assertB611NoNewCopy(t, w.dbPath, w.dbPath, before, held)

	reader.end(t, "COMMIT")
	released := w.scan(t)
	b611LogScan(t, "E2 scan 2: the reader committed, no checkpoint has run", w.db, w.dbPath, released)
	assertB611NoNewCopy(t, w.dbPath, w.dbPath, before, released)

	// "The next checkpoint" is, today, whatever SQLite runs by itself: the
	// writer's autocheckpoint. The plant turned it off so the planted frames
	// were still in the WAL at erasure time; put it back at one page, so the
	// next commit is an autocheckpoint-sized write, and make that write.
	if _, err := w.db.ExecContext(ctx, `PRAGMA wal_autocheckpoint=1`); err != nil {
		t.Fatalf("wal_autocheckpoint=1: %v", err)
	}
	if _, err := w.db.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content) VALUES (1, ?, 'b611 checkpoint nudge')`,
		w.otherUserID); err != nil {
		t.Fatalf("autocheckpoint nudge: %v", err)
	}
	next := w.scan(t)
	b611LogScan(t, "E2 scan 3: after the next checkpoint (the writer's autocheckpoint)", w.db, w.dbPath, next)
	assertB611Readable(t, w.dbPath, next, w.dbPath, w.dbPath+"-wal", w.uploads, w.backups, w.markerPath)
	assertB611Settled(t, w, w.dbPath, w.dbPath, before, next)
}

// E3 — Failed checkpoint: as E2, but the reader is not released. The database
// is closed with the read transaction still in flight, so SQLite never sees a
// last close and the checkpoint it runs there — the one that truncates the WAL
// and deletes it — cannot run. Reopening reads whatever the crash of a handle
// would have read; releasing everything afterwards is where the last-close
// checkpoint finally happens.
func b611E3CheckpointFailed(t *testing.T) {
	w := newB611World(t)
	before := w.scan(t)
	b611LogScan(t, "E3 before the erasure (planted)", w.db, w.dbPath, before)
	assertB611Planted(t, w, before)

	reader := b611HoldReader(t, w.db)
	job, logs := w.erase(t)
	w.removeJobFiles(t, job)

	// Close the handle with the reader still open: the writer's pooled
	// connection goes, the reader's stays because its read transaction is in
	// flight, so there is no last close for SQLite to checkpoint in.
	if err := w.db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	reopened := openDrillDB(t, w.dbPath)
	failed := scanForSentinel(t, w.sentinel, w.paths()...)
	b611LogEraseLogs(t, "E3 (checkpoint could not run)", logs)
	b611LogScan(t, "E3 scan 1: reopened with the reader still holding its transaction", reopened, w.dbPath, failed)
	assertB611NoNewCopy(t, w.dbPath, w.dbPath, before, failed)

	// Release everything: the reopened handle first, then the reader — its
	// connection close is the last one, which is where SQLite checkpoints the
	// WAL into the database file and deletes it.
	if err := reopened.Close(); err != nil {
		t.Fatalf("Close reopened: %v", err)
	}
	reader.end(t, "ROLLBACK")

	again := openDrillDB(t, w.dbPath)
	w.backup(t, again)
	after := w.scan(t)
	b611LogScan(t, "E3 scan 2: after the last close (checkpoint + WAL delete)", again, w.dbPath, after)
	assertB611Readable(t, w.dbPath, after, w.dbPath, w.dbPath+"-wal", w.uploads, w.backups, w.markerPath)
	assertB611Settled(t, w, w.dbPath, w.dbPath, before, after)
}

// E4 — Crash and restart: the erasure commits and the process is gone before
// the checkpoint. The crash is taken through the test seam just after
// eraseAccountTx — the three files are copied there, which is the state a
// process that died in that window leaves on disk — and the copy is then
// opened the way the server opens a database: Open, migrations, the
// deletion-marker replay. The file half the next maintenance tick runs follows,
// because the crash landed between the database half and the files.
//
// The live handle finishes its own checkpoint behind the hook; that is what a
// restarted process does too, and it touches nothing in the copy the drill
// measures.
func b611E4CrashRestart(t *testing.T) {
	w := newB611World(t)
	ctx := context.Background()
	before := w.scan(t)
	b611LogScan(t, "E4 before the erasure (planted)", w.db, w.dbPath, before)
	assertB611Planted(t, w, before)

	restore := t.TempDir()
	copyPath := filepath.Join(restore, "chatserver.db")
	w.db.testEraseCommitHook = func() {
		b611CopyFile(t, w.dbPath, copyPath)
		b611CopyFile(t, w.dbPath+"-wal", copyPath+"-wal")
		b611CopyFile(t, w.dbPath+"-shm", copyPath+"-shm")
	}
	defer func() { w.db.testEraseCommitHook = nil }()
	job, logs := w.erase(t)

	copyPaths := b611ScanPaths(copyPath, w.uploads, w.backups, w.markerPath)
	crashed := scanForSentinel(t, w.sentinel, copyPaths...)
	b611LogEraseLogs(t, "E4 (crash: no checkpoint ran on the copy)", logs)
	b611LogScan(t, "E4 scan 1: the crash image, read as the dead process left it", nil, copyPath, crashed)
	assertB611NoNewCopy(t, w.dbPath, copyPath, before, crashed)

	// Restart on the crash image. The erased account is only in the WAL, so
	// recovery has to apply it before anything serves. This copy must be the
	// already-durable case rather than the restore case the markers exist for:
	// the subject is gone from the recovered database and the marker file has
	// nothing pending, so the replay has no work — and it says so, rather than
	// leaving "which of the two it is" to the reader.
	restored := openDrillDB(t, copyPath)
	if err := Migrate(restored); err != nil {
		t.Fatalf("Migrate the crash image: %v", err)
	}
	if n := countQ(t, restored, `SELECT COUNT(*) FROM users WHERE id = ?`, w.userID); n != 0 {
		t.Errorf("the subject is still in the database the crash image recovered to (%d rows): the erasure was not durable", n)
	}
	if n := countQ(t, restored, `SELECT COUNT(*) FROM attachments WHERE uploader_id = ?`, w.userID); n != 0 {
		t.Errorf("%d attachment rows survived the recovery of the crash image", n)
	}
	report, err := w.markers.ReplayAccounts(ctx, restored, func(ctx context.Context, userID int64, token string) error {
		_, err := restored.ReplayEraseAccount(ctx, userID, token)
		return err
	})
	if err != nil {
		t.Fatalf("ReplayAccounts: %v", err)
	}
	t.Logf("E4 marker replay after the crash: %+v", report)
	if report.Erased != 0 {
		t.Errorf("the marker replay erased %d account(s) after the crash: the crash image had resurrected the subject, so this is the restore case and the erasure was not durable before it", report.Erased)
	}

	// The file half the next maintenance tick runs (ErasureService.Resume):
	// the journal's files are still on disk, because the crash landed between
	// the two halves.
	w.removeJobFiles(t, job)
	w.backup(t, restored)

	after := scanForSentinel(t, w.sentinel, copyPaths...)
	b611LogScan(t, "E4 scan 2: restarted (Open → migrations → marker replay → resume)", restored, copyPath, after)
	assertB611Readable(t, copyPath, after, copyPath, copyPath+"-wal", w.uploads, w.backups, w.markerPath)
	assertB611Settled(t, w, copyPath, copyPath, crashed, after)
}
