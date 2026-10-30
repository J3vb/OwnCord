package discordimport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

const pngMagic = "\x89PNG\r\n\x1a\n"

type announcer struct {
	mu  sync.Mutex
	got []*db.Channel
}

func (a *announcer) ChannelCreated(_ context.Context, ch *db.Channel) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.got = append(a.got, ch)
}

func (a *announcer) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.got)
}

// testFiles is the production write path (reserve, save, land) over a real
// storage directory.
type testFiles struct{ *storage.Storage }

func (f testFiles) SaveReserved(ctx context.Context, res *service.StorageReservation, name string, r io.Reader) (int64, error) {
	n, err := f.Save(name, r)
	if err != nil {
		res.Release(ctx)
		return 0, err
	}
	res.Landed()
	return n, nil
}

type harness struct {
	t        *testing.T
	database *db.DB
	files    *storage.Storage
	uploads  *service.UploadService
	ann      *announcer
	runner   *Runner
	member   int64
}

func newHarness(t *testing.T, chunk int) *harness {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	files, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	member, err := database.CreateUser(context.Background(), "alice", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, database: database, files: files, uploads: service.NewUploadService(database, nil), ann: &announcer{}, member: member}
	h.runner = NewRunner(Config{Store: database, Files: testFiles{files}, Uploads: h.uploads, Announcer: h.ann, ChunkSize: chunk})
	return h
}

func (h *harness) fixtureZip(media ...zipEntry) Export {
	h.t.Helper()
	body, err := os.ReadFile("testdata/channel.json")
	if err != nil {
		h.t.Fatal(err)
	}
	entries := append([]zipEntry{{name: "channel.json", body: string(body)}}, media...)
	z, err := openZipBytes(h.t, buildZip(h.t, entries...), ZipLimits{})
	if err != nil {
		h.t.Fatal(err)
	}
	return z
}

func (h *harness) run(ex Export) (*Job, Result) {
	h.t.Helper()
	job, err := h.runner.Start(context.Background(), Request{Export: ex, CreatedBy: h.member, SourceName: "export.zip"})
	if err != nil {
		h.t.Fatalf("Start: %v", err)
	}
	res := job.Wait()
	return job, res
}

func (h *harness) count(query string, args ...any) int {
	h.t.Helper()
	return h.countCtx(context.Background(), query, args...)
}

func (h *harness) countCtx(ctx context.Context, query string, args ...any) int {
	h.t.Helper()
	var n int
	if err := h.database.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		h.t.Fatal(err)
	}
	return n
}

func TestRun_ImportsTheFixtureExport(t *testing.T) {
	h := newHarness(t, 2)
	job, res := h.run(h.fixtureZip(zipEntry{name: "channel.json_Files/pic one.png", body: pngMagic + "data"}))
	if res.Err != nil || res.Status != db.ImportDone {
		t.Fatalf("result = %+v", res)
	}
	// 1001, 1002, 1004 and 1005 import. 1003 is a system message, 1006 holds only
	// an embed and 1007 has no usable time.
	if res.Imported != 4 || res.Skipped != 3 || res.SkippedAttachments != 1 {
		t.Errorf("imported/skipped/skipped attachments = %d/%d/%d, want 4/3/1", res.Imported, res.Skipped, res.SkippedAttachments)
	}
	ctx := context.Background()
	jr, err := h.database.GetImportJob(ctx, job.ID)
	if err != nil || jr.Status != db.ImportDone || jr.Imported != 4 || jr.Skipped != 3 || jr.Total != 7 || jr.SourceName != "export.zip" || jr.DiscordChannelID != "111" {
		t.Errorf("job row = %+v, %v", jr, err)
	}

	ch, err := h.database.GetChannel(ctx, job.ChannelID)
	if err != nil || ch == nil || ch.Name != "general" || ch.Topic != "Where we talk" || ch.Type != "text" {
		t.Fatalf("channel = %+v, %v", ch, err)
	}
	msgs, err := h.database.GetMessages(ctx, job.ChannelID, 0, 50)
	if err != nil || len(msgs) != 4 {
		t.Fatalf("messages = %d, %v", len(msgs), err)
	}
	byContent := map[string]db.MessageWithUser{}
	for _, m := range msgs {
		byContent[m.Content] = m
	}
	first := byContent["Hello world"]
	if first.Content == "" || !first.Pinned || first.Timestamp != "2020-03-01 10:00:00" {
		t.Errorf("first message = %+v (HTML must be stripped, pin and time kept)", first)
	}
	reply := byContent["Hi back"]
	if reply.ReplyTo == nil || *reply.ReplyTo != first.ID {
		t.Errorf("reply link = %v, want %d", reply.ReplyTo, first.ID)
	}
	if reply.EditedAt == nil {
		t.Error("edited time lost")
	}
	if loose := byContent["Replying to something not exported"]; loose.ReplyTo != nil {
		t.Errorf("a reply to a missing message kept link %v", *loose.ReplyTo)
	}
	if first.Username != "[imported]" {
		t.Errorf("author account = %q", first.Username)
	}

	var name, color string
	if err := h.database.QueryRowContext(ctx, `SELECT name, COALESCE(color,'') FROM message_import_authors WHERE message_id = ?`, first.ID).Scan(&name, &color); err != nil || name != "Ann N." || color != "#FF0000" {
		t.Errorf("author row = %q %q (%v)", name, color, err)
	}
	if err := h.database.QueryRowContext(ctx, `SELECT name FROM message_import_authors WHERE message_id = ?`, reply.ID).Scan(&name); err != nil || name != "bob" {
		t.Errorf("empty nickname should fall back to the name, got %q (%v)", name, err)
	}

	atts, err := h.database.GetAttachmentsByMessageIDs(ctx, []int64{byContent["Two pictures and a link"].ID})
	if err != nil {
		t.Fatal(err)
	}
	got := atts[byContent["Two pictures and a link"].ID]
	if len(got) != 1 || got[0].Filename != "pic one.png" || got[0].Mime != "image/png" {
		t.Fatalf("attachments = %+v", got)
	}
	if f, err := h.files.Open(got[0].ID); err != nil {
		t.Errorf("stored file missing: %v", err)
	} else {
		_ = f.Close()
	}
	if n := h.count(`SELECT COUNT(*) FROM message_mentions`); n != 0 {
		t.Errorf("message_mentions rows = %d", n)
	}
	if n := h.count(`SELECT COUNT(*) FROM messages WHERE mentions_everyone <> 0 OR kind <> 0`); n != 0 {
		t.Errorf("%d messages carry a mention or kind flag", n)
	}
}

// Online members during an import: the channel does not exist for anyone until
// the end, no message event can go out (the runner has no way to send one), and
// afterwards one channel event goes out and nothing is unread.
func TestRun_OnlineMembersSeeNothingUntilTheEnd(t *testing.T) {
	h := newHarness(t, 2)
	ctx := context.Background()
	other, _ := h.database.CreateUser(ctx, "bob", "hash", 4)
	general, _ := h.database.CreateChannel(ctx, "general-2", "text", "", "", 0)

	var checked int
	h.runner.afterChunk = func(c context.Context, chunk int) {
		checked++
		for _, uid := range []int64{h.member, other} {
			list, err := h.database.ListChannels(c)
			if err != nil || len(list) != 1 || list[0].ID != general {
				t.Errorf("chunk %d: ListChannels = %+v, %v", chunk, list, err)
			}
			unread, err := h.database.GetChannelUnreadCounts(c, uid)
			if err != nil || len(unread) != 1 {
				t.Errorf("chunk %d: unread map has %d channels, %v", chunk, len(unread), err)
			}
		}
		jobs := h.countCtx(c, `SELECT COUNT(*) FROM channels WHERE import_pending = 1`)
		if jobs != 1 {
			t.Errorf("chunk %d: pending channels = %d", chunk, jobs)
		}
		var pending int64
		_ = h.database.QueryRowContext(c, `SELECT id FROM channels WHERE import_pending = 1`).Scan(&pending)
		if ch, err := h.database.GetChannel(c, pending); ch != nil || err != nil {
			t.Errorf("chunk %d: GetChannel(pending) = %v, %v", chunk, ch, err)
		}
		if n := h.ann.count(); n != 0 {
			t.Errorf("chunk %d: %d channel events before the end", chunk, n)
		}
	}
	job, res := h.run(h.fixtureZip())
	if res.Err != nil {
		t.Fatal(res.Err)
	}
	if checked < 2 {
		t.Fatalf("only %d chunks checked", checked)
	}
	if n := h.ann.count(); n != 1 {
		t.Fatalf("channel events = %d, want exactly 1", n)
	}
	if h.ann.got[0].ID != job.ChannelID {
		t.Errorf("event names channel %d, want %d", h.ann.got[0].ID, job.ChannelID)
	}
	for _, uid := range []int64{h.member, other} {
		unread, err := h.database.GetChannelUnreadCounts(ctx, uid)
		if err != nil {
			t.Fatal(err)
		}
		if u, ok := unread[job.ChannelID]; !ok || u.UnreadCount != 0 || u.MentionCount != 0 {
			t.Errorf("user %d unread after import = %+v (present %v), want 0", uid, u, ok)
		}
	}
}

// diedStore behaves like a process that is killed during chunk 3: the third
// chunk never commits and nothing after it runs, not even the clean-up.
type diedStore struct {
	Store
	chunks int
	dieAt  int
}

var errProcessGone = errors.New("process gone")

func (d *diedStore) ImportChunk(ctx context.Context, p db.ImportChunkParams) (map[string]int64, error) {
	d.chunks++
	if d.chunks == d.dieAt {
		return nil, errProcessGone
	}
	return d.Store.ImportChunk(ctx, p)
}

func (d *diedStore) AbandonImport(context.Context, int64, int64, string, string, db.ImportProgress) error {
	return errProcessGone
}

func TestRestartMidImport_AfterChunkTwoOfFive(t *testing.T) {
	h := newHarness(t, 2)
	ctx := context.Background()
	var b strings.Builder
	b.WriteString(`{"channel":{"id":"7","name":"big"},"messages":[`)
	for i := range 10 {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"id":"%d","type":"Default","timestamp":"2020-01-01T10:%02d:00+00:00","content":"m%d","author":{"id":"1","name":"a"},"attachments":[{"id":"x","url":"f/%d.png","fileName":"%d.png"}]}`, 100+i, i, i, i, i)
	}
	b.WriteString(`],"messageCount":10}`)
	media := make([]zipEntry, 0, 10)
	for i := range 10 {
		media = append(media, zipEntry{name: fmt.Sprintf("f/%d.png", i), body: pngMagic + "x"})
	}
	z, err := openZipBytes(t, buildZip(t, append([]zipEntry{{name: "e.json", body: b.String()}}, media...)...), ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	h.runner.cfg.Store = &diedStore{Store: h.database, dieAt: 3}
	job, res := h.run(z)
	if !errors.Is(res.Err, errProcessGone) {
		t.Fatalf("result = %+v", res)
	}
	if n := h.count(`SELECT COUNT(*) FROM messages WHERE channel_id = ?`, job.ChannelID); n != 4 {
		t.Fatalf("messages after the crash = %d, want the 4 of chunks 1 and 2", n)
	}
	if n := h.count(`SELECT COUNT(*) FROM attachments WHERE message_id IS NOT NULL`); n != 4 {
		t.Fatalf("linked attachments = %d, want 4", n)
	}
	if list, _ := h.database.ListChannels(ctx); len(list) != 0 {
		t.Fatalf("the half-built channel is visible: %+v", list)
	}

	failed, err := h.database.FailInterruptedImports(ctx)
	if err != nil || failed != 1 {
		t.Fatalf("FailInterruptedImports = %d, %v", failed, err)
	}
	if n := h.count(`SELECT COUNT(*) FROM channels WHERE id = ?`, job.ChannelID); n != 0 {
		t.Errorf("channel rows after boot = %d", n)
	}
	if n := h.count(`SELECT COUNT(*) FROM messages WHERE channel_id = ?`, job.ChannelID); n != 0 {
		t.Errorf("message rows after boot = %d", n)
	}
	if n := h.count(`SELECT COUNT(*) FROM attachments WHERE message_id IS NOT NULL`); n != 0 {
		t.Errorf("attachment links after boot = %d", n)
	}
	jr, _ := h.database.GetImportJob(ctx, job.ID)
	if jr.Status != db.ImportFailed {
		t.Errorf("job status = %q, want failed", jr.Status)
	}
	if h.ann.count() != 0 {
		t.Error("a channel event went out for a dead import")
	}
	// The files of every chunk, the dead one included, are unlinked rows now:
	// the orphan sweep returns them all.
	files, err := h.database.DeleteOrphanedAttachments(ctx, time.Now().Add(48*time.Hour))
	if err != nil || len(files) != 6 {
		t.Errorf("orphan sweep reclaimed %d files (%v), want 6", len(files), err)
	}
}

func TestRun_CancelDeletesTheChannelAndEndsCancelled(t *testing.T) {
	h := newHarness(t, 2)
	var job *Job
	ready := make(chan struct{})
	h.runner.afterChunk = func(context.Context, int) {
		<-ready
		job.Cancel()
	}
	job, err := h.runner.Start(context.Background(), Request{Export: h.fixtureZip()})
	if err != nil {
		t.Fatal(err)
	}
	close(ready)
	res := job.Wait()
	if res.Status != db.ImportCancelled || !errors.Is(res.Err, context.Canceled) {
		t.Fatalf("result = %+v", res)
	}
	if n := h.count(`SELECT COUNT(*) FROM channels`); n != 0 {
		t.Errorf("channels left: %d", n)
	}
	if n := h.count(`SELECT COUNT(*) FROM messages`); n != 0 {
		t.Errorf("messages left: %d", n)
	}
	jr, _ := h.database.GetImportJob(context.Background(), job.ID)
	if jr.Status != db.ImportCancelled || jr.FinishedAt == nil {
		t.Errorf("job = %+v", jr)
	}
	if h.ann.count() != 0 {
		t.Error("a cancelled import announced a channel")
	}
}

func TestStart_SecondImportIsRefusedWhileOneRuns(t *testing.T) {
	h := newHarness(t, 2)
	release := make(chan struct{})
	reached := make(chan struct{})
	var once sync.Once
	h.runner.afterChunk = func(context.Context, int) {
		once.Do(func() { close(reached) })
		<-release
	}
	first, err := h.runner.Start(context.Background(), Request{Export: h.fixtureZip()})
	if err != nil {
		t.Fatal(err)
	}
	<-reached
	if _, err := h.runner.Start(context.Background(), Request{Export: h.fixtureZip()}); !errors.Is(err, ErrImportRunning) {
		t.Errorf("second Start err = %v, want ErrImportRunning", err)
	}
	// Another process-wide runner shares the database guard.
	other := NewRunner(Config{Store: h.database, Files: testFiles{h.files}, Uploads: h.uploads})
	if _, err := other.Start(context.Background(), Request{Export: h.fixtureZip()}); !errors.Is(err, ErrImportRunning) {
		t.Errorf("Start from another runner err = %v, want ErrImportRunning", err)
	}
	close(release)
	if res := first.Wait(); res.Err != nil {
		t.Fatal(res.Err)
	}
	h.runner.afterChunk = nil
	// The refused starts left no channel behind, and the next import runs.
	if n := h.count(`SELECT COUNT(*) FROM import_jobs`); n != 1 {
		t.Errorf("import_jobs rows = %d, want 1", n)
	}
	job, err := h.runner.Start(context.Background(), Request{Export: h.fixtureZip()})
	if err != nil {
		t.Fatalf("Start after the first ended: %v", err)
	}
	job.Wait()
}

func TestRun_AttachmentsFollowTheUploadRules(t *testing.T) {
	h := newHarness(t, 10)
	body := `{"channel":{"id":"7","name":"files"},"messages":[
	 {"id":"1","type":"Default","timestamp":"2020-01-01T10:00:00+00:00","content":"a","author":{"id":"1","name":"a"},"attachments":[
	   {"url":"f/ok.png","fileName":"ok.png"},
	   {"url":"f/run.exe","fileName":"run.exe"},
	   {"url":"f/fake.png","fileName":"fake.png"},
	   {"url":"f/missing.png","fileName":"missing.png"},
	   {"url":"https://cdn.discordapp.com/x.png","fileName":"x.png"}]}]}`
	z, err := openZipBytes(t, buildZip(t,
		zipEntry{name: "e.json", body: body},
		zipEntry{name: "f/ok.png", body: pngMagic + "x"},
		zipEntry{name: "f/run.exe", body: pngMagic},
		zipEntry{name: "f/fake.png", body: "MZ\x90\x00 an executable named like a picture"},
	), ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.database.SetSetting(context.Background(), service.UploadBlockedExtensionsKey, "exe"); err != nil {
		t.Fatal(err)
	}
	_, res := h.run(z)
	if res.Err != nil {
		t.Fatal(res.Err)
	}
	if res.SkippedAttachments != 4 {
		t.Errorf("skipped attachments = %d, want 4 (policy, content, missing, remote)", res.SkippedAttachments)
	}
	if n := h.count(`SELECT COUNT(*) FROM attachments`); n != 1 {
		t.Errorf("attachment rows = %d, want only ok.png", n)
	}
	entries, err := h.files.List()
	if err != nil || len(entries) != 1 {
		t.Errorf("stored files = %d (%v), want 1: a refused file must not stay on disk", len(entries), err)
	}
}

func TestRun_OverlongContentIsCutWithAnEllipsis(t *testing.T) {
	h := newHarness(t, 10)
	long := strings.Repeat("é", 4500)
	body := fmt.Sprintf(`{"channel":{"id":"7","name":"long"},"messages":[{"id":"1","type":"Default","timestamp":"2020-01-01T10:00:00+00:00","content":%q,"author":{"id":"1","name":"a"}}]}`, long)
	z, err := openZipBytes(t, buildZip(t, zipEntry{name: "e.json", body: body}), ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	job, res := h.run(z)
	if res.Err != nil {
		t.Fatal(res.Err)
	}
	msgs, _ := h.database.GetMessages(context.Background(), job.ChannelID, 0, 5)
	if len(msgs) != 1 {
		t.Fatalf("messages = %d", len(msgs))
	}
	r := []rune(msgs[0].Content)
	if len(r) != 4000 || r[len(r)-1] != '…' {
		t.Errorf("content has %d runes, last %q; want 4000 ending in an ellipsis", len(r), string(r[len(r)-1]))
	}
}

func TestRun_NothingImportableFailsAndLeavesNoChannel(t *testing.T) {
	h := newHarness(t, 10)
	body := `{"channel":{"id":"7","name":"joins"},"messages":[{"id":"1","type":"GuildMemberJoin","timestamp":"2020-01-01T10:00:00+00:00","content":"x","author":{"id":"1","name":"a"}}]}`
	z, _ := openZipBytes(t, buildZip(t, zipEntry{name: "e.json", body: body}), ZipLimits{})
	job, res := h.run(z)
	if !errors.Is(res.Err, ErrNothingToImport) || res.Status != db.ImportFailed {
		t.Fatalf("result = %+v", res)
	}
	if n := h.count(`SELECT COUNT(*) FROM channels WHERE id = ?`, job.ChannelID); n != 0 {
		t.Error("an empty import left its channel")
	}
}

func TestStart_BadExportCreatesNothing(t *testing.T) {
	h := newHarness(t, 10)
	z, _ := openZipBytes(t, buildZip(t, zipEntry{name: "e.json", body: `{"hello": 1}`}), ZipLimits{})
	if _, err := h.runner.Start(context.Background(), Request{Export: z}); !errors.Is(err, ErrBadExport) {
		t.Fatalf("err = %v, want ErrBadExport", err)
	}
	if n := h.count(`SELECT COUNT(*) FROM import_jobs`); n != 0 {
		t.Errorf("import_jobs rows = %d", n)
	}
	// The failed start released the guard.
	good, _ := openZipBytes(t, buildZip(t, zipEntry{name: "e.json", body: `{"channel":{"id":"1","name":"x"},"messages":[{"id":"1","type":"Default","timestamp":"2020-01-01T10:00:00+00:00","content":"hi","author":{"id":"1","name":"a"}}]}`}), ZipLimits{})
	if _, res := h.run(good); res.Err != nil {
		t.Fatal(res.Err)
	}
}

func TestStart_RefusedWhileShuttingDownLeavesNothingBehind(t *testing.T) {
	h := newHarness(t, 10)
	group := syncutil.NewGroup(context.Background())
	h.runner.cfg.Group = group
	group.Stop(context.Background(), time.Millisecond)

	if _, err := h.runner.Start(context.Background(), Request{Export: h.fixtureZip()}); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("err = %v, want ErrShuttingDown", err)
	}
	if n := h.count(`SELECT COUNT(*) FROM channels`); n != 0 {
		t.Errorf("channels left: %d", n)
	}
	var status string
	if err := h.database.QueryRowContext(context.Background(), `SELECT status FROM import_jobs`).Scan(&status); err != nil || status != db.ImportFailed {
		t.Errorf("job status = %q, %v; want failed (and not blocking the next start)", status, err)
	}
}

// A downloaded .json attachment lives in the media folder of the export and is
// copied like any other file.
func TestRun_ImportsAJSONAttachmentFromTheMediaFolder(t *testing.T) {
	h := newHarness(t, 10)
	body := `{"channel":{"id":"7","name":"cfg"},"messages":[
	 {"id":"1","type":"Default","timestamp":"2020-01-01T10:00:00+00:00","content":"a","author":{"id":"1","name":"a"},"attachments":[
	   {"url":"chan.json_Files/config-1A2B.json","fileName":"config.json"}]}]}`
	z, err := openZipBytes(t, buildZip(t,
		zipEntry{name: "chan.json", body: body},
		zipEntry{name: "chan.json_Files/config-1A2B.json", body: `{"a":1}`},
	), ZipLimits{})
	if err != nil {
		t.Fatalf("zip with a media .json: %v", err)
	}
	_, res := h.run(z)
	if res.Err != nil || res.Status != db.ImportDone {
		t.Fatalf("result = %+v", res)
	}
	if res.SkippedAttachments != 0 {
		t.Errorf("skipped attachments = %d, want 0", res.SkippedAttachments)
	}
	if n := h.count(`SELECT COUNT(*) FROM attachments`); n != 1 {
		t.Errorf("attachment rows = %d, want the json file", n)
	}
}

func TestRunning_FindsAJobOnlyWhileItRuns(t *testing.T) {
	h := newHarness(t, 2)
	release := make(chan struct{})
	reached := make(chan struct{})
	var once sync.Once
	h.runner.afterChunk = func(context.Context, int) {
		once.Do(func() { close(reached) })
		<-release
	}
	job, err := h.runner.Start(context.Background(), Request{Export: h.fixtureZip()})
	if err != nil {
		t.Fatal(err)
	}
	<-reached
	if h.runner.Running(job.ID) != job {
		t.Error("a running job was not found by id")
	}
	st, err := h.runner.Status(context.Background(), job.ID)
	if err != nil || st.Status != db.ImportRunning {
		t.Errorf("status = %+v, %v", st, err)
	}
	if latest, err := h.runner.Latest(context.Background()); err != nil || latest.ID != job.ID {
		t.Errorf("latest = %+v, %v", latest, err)
	}
	close(release)
	job.Wait()
	if h.runner.Running(job.ID) != nil {
		t.Error("a finished job is still registered")
	}
	if _, err := h.runner.Status(context.Background(), job.ID+99); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("unknown id err = %v, want ErrNotFound", err)
	}
}

func TestRun_RecordsPNGSizeAndLeavesUnreadableImagesUnmeasured(t *testing.T) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, 7, 3))); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, 2)
	if _, res := h.run(h.fixtureZip(zipEntry{name: "channel.json_Files/pic one.png", body: buf.String()})); res.Err != nil {
		t.Fatalf("result = %+v", res)
	}
	var w, hgt int
	if err := h.database.QueryRowContext(context.Background(), `SELECT width, height FROM attachments WHERE filename = 'pic one.png'`).Scan(&w, &hgt); err != nil || w != 7 || hgt != 3 {
		t.Errorf("png size = %dx%d (%v), want 7x3", w, hgt, err)
	}

	h = newHarness(t, 2)
	if _, res := h.run(h.fixtureZip(zipEntry{name: "channel.json_Files/pic one.png", body: pngMagic + "data"})); res.Err != nil {
		t.Fatalf("result = %+v", res)
	}
	if n := h.count(`SELECT COUNT(*) FROM attachments WHERE filename = 'pic one.png' AND width IS NULL AND height IS NULL`); n != 1 {
		t.Errorf("a broken png got a size: %d unmeasured rows, want 1", n)
	}
}

func TestCategoryExists_ZeroIsFreeAndUnknownIsNo(t *testing.T) {
	h := newHarness(t, 2)
	ctx := context.Background()
	if ok, err := h.runner.CategoryExists(ctx, 0); !ok || err != nil {
		t.Errorf("id 0 = %v, %v, want true", ok, err)
	}
	if ok, err := h.runner.CategoryExists(ctx, 4242); ok || err != nil {
		t.Errorf("unknown id = %v, %v, want false", ok, err)
	}
	cat, err := h.database.CreateChannelCategory(ctx, "Archive")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := h.runner.CategoryExists(ctx, cat.ID); !ok || err != nil {
		t.Errorf("real category = %v, %v, want true", ok, err)
	}
}
