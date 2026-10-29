package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/google/uuid"
)

// Forward fixture ids. alice writes the source, bob forwards it, carol is the
// other end of the DM.
const (
	fwdAlice, fwdBob, fwdCarol = int64(1), int64(2), int64(3)

	fwdSrcChan    = int64(10) // ordinary source channel
	fwdDstChan    = int64(11) // ordinary target channel
	fwdLockedChan = int64(12) // members cannot read it
	fwdNoSendChan = int64(13) // members can read but not send
	fwdNoFilesDst = int64(14) // members can send but not attach files
	fwdNSFWSrc    = int64(15) // labelled
	fwdNSFWDst    = int64(16) // labelled
	fwdArchived   = int64(17)
	fwdDM         = int64(50) // bob and carol
)

type forwardFixture struct {
	database *db.DB
	perms    *PermissionService
	svc      *MessageService
	uploads  *UploadService
	files    *storage.Storage
	dir      string
	// srcID is alice's message in fwdSrcChan: "see @carol and @everyone" plus one file.
	srcID    int64
	srcFile  string
	fileSize int64
}

// newForwardFixture builds the channels, users and storage every forward test
// needs. limiter may be nil.
func newForwardFixture(t *testing.T, limiter *auth.RateLimiter) *forwardFixture {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member", Position: 1,
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.AttachFiles | permissions.AddReactions,
	})
	for id, name := range map[int64]string{fwdAlice: "alice", fwdBob: "bob", fwdCarol: "carol"} {
		seedUser(t, database, &db.User{ID: id, Username: name})
		seedUserRole(t, database, id, permissions.MemberRoleID)
	}
	for _, c := range []struct {
		id   int64
		name string
	}{
		{fwdSrcChan, "source"}, {fwdDstChan, "target"}, {fwdLockedChan, "locked"}, {fwdNoSendChan, "readonly"},
		{fwdNoFilesDst, "nofiles"}, {fwdNSFWSrc, "nsfw-src"}, {fwdNSFWDst, "nsfw-dst"}, {fwdArchived, "archived"},
	} {
		seedChannel(t, database, &db.Channel{ID: c.id, Name: c.name, Type: "text"})
	}
	seedChannelOverride(t, database, permissions.MemberRoleID, fwdLockedChan, 0, permissions.ReadMessages)
	seedChannelOverride(t, database, permissions.MemberRoleID, fwdNoSendChan, 0, permissions.SendMessages)
	seedChannelOverride(t, database, permissions.MemberRoleID, fwdNoFilesDst, 0, permissions.AttachFiles)
	for _, id := range []int64{fwdNSFWSrc, fwdNSFWDst} {
		labelChannel(t, database, id, true)
	}
	if _, err := database.ExecContext(context.Background(), `UPDATE channels SET archived = 1 WHERE id = ?`, fwdArchived); err != nil {
		t.Fatal(err)
	}
	seedChannel(t, database, &db.Channel{ID: fwdDM, Name: "dm-2-3", Type: "dm"})
	seedDMParticipant(t, database, fwdDM, fwdBob)
	seedDMParticipant(t, database, fwdDM, fwdCarol)

	dir := t.TempDir()
	files, err := storage.New(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	perms := NewPermissionService(database, permissions.NewChecker(database))
	uploads := NewUploadService(database, perms)
	uploads.SetStorageLimits(StorageLimits{Dir: dir, FreeBytes: func(string) (uint64, error) { return 0, errors.New("unknown") }})
	uploads.SetFileCloner(files)
	svc := NewMessageService(database, perms, limiter)
	svc.SetUploads(uploads)
	svc.RunBackgroundInlineForTest()

	f := &forwardFixture{database: database, perms: perms, svc: svc, uploads: uploads, files: files, dir: dir}
	f.srcID, f.srcFile = f.sendWithFile(t, fwdAlice, fwdSrcChan, "see @carol and @everyone", "PNGDATA-source-bytes")
	f.fileSize = int64(len("PNGDATA-source-bytes"))
	return f
}

// sendWithFile stores a file, records its upload row and sends a message with it.
func (f *forwardFixture) sendWithFile(t *testing.T, user, channel int64, content, body string) (msgID int64, fileID string) {
	t.Helper()
	fileID = uuid.NewString()
	if _, err := f.files.Save(fileID, strings.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	if err := f.database.CreateAttachment(context.Background(), fileID, user, "pic.png", fileID, "image/png", int64(len(body)), nil, nil); err != nil {
		t.Fatal(err)
	}
	res, err := f.svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: channel, UserID: user, Username: seedUsername(user), Content: content, AttachmentIDs: []string{fileID},
	})
	if err != nil {
		t.Fatalf("seed send: %v", err)
	}
	return res.MessageID, fileID
}

func newClientMessageID() string {
	return fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString())
}

func (f *forwardFixture) forward(target, source int64) (*SendMessageResult, error) {
	return f.forwardAs(fwdBob, newClientMessageID(), target, source)
}

func (f *forwardFixture) forwardAs(user int64, cmid string, target, source int64) (*SendMessageResult, error) {
	return f.svc.ForwardMessage(context.Background(), ForwardParams{
		ClientMessageID: cmid, UserID: user, Username: seedUsername(user), TargetChannelID: target, SourceMessageID: source,
	})
}

func (f *forwardFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	return countRows(t, f.database, q, args...)
}

func (f *forwardFixture) storedFiles(t *testing.T) int {
	t.Helper()
	entries, err := os.ReadDir(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if e.Type().IsRegular() {
			n++
		}
	}
	return n
}

func (f *forwardFixture) used(t *testing.T, user int64) int64 {
	t.Helper()
	n, err := f.uploads.StorageUsed(context.Background(), user)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func mustForward(t *testing.T, f *forwardFixture, target, source int64) *SendMessageResult {
	t.Helper()
	res, err := f.forward(target, source)
	if err != nil {
		t.Fatalf("ForwardMessage: %v", err)
	}
	return res
}

func TestForward_CopiesSnapshotAndFilesToTheForwarder(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	res := mustForward(t, f, fwdDstChan, f.srcID)

	if res.Duplicate || res.IsDM || res.Content != "see @carol and @everyone" {
		t.Fatalf("result = %+v", res)
	}
	if res.Forward == nil || res.Forward.SourceMessageID == nil || *res.Forward.SourceMessageID != f.srcID ||
		res.Forward.SourceChannelID != fwdSrcChan {
		t.Fatalf("forward block = %+v", res.Forward)
	}
	if len(res.Attachments) != 1 || res.Attachments[0].ID == f.srcFile || res.Attachments[0].Filename != "pic.png" {
		t.Fatalf("attachments = %+v, want one clone with a new id", res.Attachments)
	}
	clone := res.Attachments[0].ID
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE id = ? AND uploader_id = ? AND message_id = ? AND size = ?`,
		clone, fwdBob, res.MessageID, f.fileSize); n != 1 {
		t.Errorf("the clone row is not the forwarder's linked copy")
	}
	if got := f.used(t, fwdBob); got != f.fileSize {
		t.Errorf("forwarder's storage = %d, want %d", got, f.fileSize)
	}
	body, err := os.ReadFile(filepath.Join(f.dir, clone))
	if err != nil || string(body) != "PNGDATA-source-bytes" {
		t.Fatalf("clone bytes = %q, %v", body, err)
	}
	msg, err := f.database.GetMessage(ctx, res.MessageID)
	if err != nil || msg == nil || msg.UserID != fwdBob || msg.ChannelID != fwdDstChan || msg.Kind != db.MessageKindUser {
		t.Fatalf("stored forward = %+v, %v", msg, err)
	}

	// Later changes to the original change nothing: delete it and sweep.
	if err := f.database.DeleteMessage(ctx, f.srcID, fwdAlice, false); err != nil {
		t.Fatal(err)
	}
	swept, err := f.database.DeleteOrphanedAttachments(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(swept) != 1 || swept[0] != f.srcFile {
		t.Fatalf("sweep removed %v, want only the original's file %s", swept, f.srcFile)
	}
	for _, name := range swept {
		if err := f.files.Delete(name); err != nil {
			t.Fatal(err)
		}
	}
	if body, err := os.ReadFile(filepath.Join(f.dir, clone)); err != nil || string(body) != "PNGDATA-source-bytes" {
		t.Errorf("the forward lost its file when the original was swept: %q, %v", body, err)
	}
	hist, err := f.database.GetMessagesForAPI(ctx, fwdDstChan, 0, 10, fwdBob)
	if err != nil || len(hist) != 1 || hist[0].Forward == nil || hist[0].Forward.SourceMessageID != nil ||
		hist[0].Content != "see @carol and @everyone" || len(hist[0].Attachments) != 1 {
		t.Fatalf("history after the original was deleted = %+v, %v", hist, err)
	}
}

// A forwarded voice message keeps its length and waveform, so the copy still
// draws the voice player (WP 8.9).
func TestForward_VoiceMessageKeepsDurationAndWaveform(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	fileID := uuid.NewString()
	body := "OggS-voice-bytes"
	if _, err := f.files.Save(fileID, strings.NewReader(body)); err != nil {
		t.Fatal(err)
	}
	dur, wave := 2500, "AAH_gA"
	if err := f.database.CreateAttachmentVoice(ctx, fileID, fwdAlice, "voice-message.ogg", fileID, "application/ogg", int64(len(body)), nil, nil, &dur, &wave); err != nil {
		t.Fatal(err)
	}
	src, err := f.svc.SendMessage(ctx, SendMessageParams{
		ChannelID: fwdSrcChan, UserID: fwdAlice, Username: seedUsername(fwdAlice), AttachmentIDs: []string{fileID},
	})
	if err != nil {
		t.Fatalf("seed send: %v", err)
	}

	res := mustForward(t, f, fwdDstChan, src.MessageID)
	if len(res.Attachments) != 1 {
		t.Fatalf("attachments = %+v, want one clone", res.Attachments)
	}
	got := res.Attachments[0]
	if got.ID == fileID || got.DurationMs == nil || *got.DurationMs != dur || got.Waveform == nil || *got.Waveform != wave {
		t.Fatalf("forwarded attachment = %+v, want a clone with duration %d and waveform %q", got, dur, wave)
	}
	hist, err := f.database.GetMessagesForAPI(ctx, fwdDstChan, 0, 10, fwdBob)
	if err != nil || len(hist) != 1 || len(hist[0].Attachments) != 1 {
		t.Fatalf("history = %+v, %v", hist, err)
	}
	if a := hist[0].Attachments[0]; a.DurationMs == nil || *a.DurationMs != dur || a.Waveform == nil || *a.Waveform != wave {
		t.Fatalf("history attachment = %+v, want duration %d and waveform %q", a, dur, wave)
	}
}

// Edge case 1: the acknowledgement is lost and the client resends. The retry
// is answered from the receipt: one message, one clone, and it still works
// after the world changed (the original deleted, the forwarder locked out).
func TestForward_RetryNoSecondClone(t *testing.T) {
	f := newForwardFixture(t, nil)
	cmid := newClientMessageID()
	first, err := f.forwardAs(fwdBob, cmid, fwdDstChan, f.srcID)
	if err != nil {
		t.Fatal(err)
	}
	filesAfterFirst, usedAfterFirst := f.storedFiles(t), f.used(t, fwdBob)

	if err := f.database.DeleteMessage(context.Background(), f.srcID, fwdAlice, false); err != nil {
		t.Fatal(err)
	}
	seedChannelOverride(t, f.database, permissions.MemberRoleID, fwdDstChan, 0, permissions.SendMessages)
	f.perms.InvalidateAll()

	retry, err := f.forwardAs(fwdBob, cmid, fwdDstChan, f.srcID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if !retry.Duplicate || retry.MessageID != first.MessageID || retry.Timestamp != first.Timestamp {
		t.Fatalf("retry = %+v, first = %+v", retry, first)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, fwdDstChan); n != 1 {
		t.Errorf("messages in the target = %d, want 1", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE uploader_id = ?`, fwdBob); n != 1 {
		t.Errorf("forwarder's attachment rows = %d, want 1 (no second clone)", n)
	}
	if got := f.storedFiles(t); got != filesAfterFirst {
		t.Errorf("files on disk = %d, want %d", got, filesAfterFirst)
	}
	if got := f.used(t, fwdBob); got != usedAfterFirst {
		t.Errorf("forwarder's storage = %d, want %d", got, usedAfterFirst)
	}
	// The same id for a different source is a conflict, never a second post.
	other, _ := f.sendWithFile(t, fwdAlice, fwdSrcChan, "another", "PNGDATA-other")
	if _, err := f.forwardAs(fwdBob, cmid, fwdDstChan, other); !errors.Is(err, ErrConflict) {
		t.Errorf("same id, different source: err = %v, want ErrConflict", err)
	}
}

// Edge case 2a: the source is deleted after the gates passed and the clones
// were made. The transaction re-reads it and refuses; the clones go back out
// and the quota is released.
func TestForward_SourceDeletedMidFlightIsRefusedAndReleased(t *testing.T) {
	f := newForwardFixture(t, nil)
	files := f.storedFiles(t)
	f.svc.forward.afterClone = func() {
		if err := f.database.DeleteMessage(context.Background(), f.srcID, fwdAlice, false); err != nil {
			t.Error(err)
		}
	}
	_, err := f.forward(fwdDstChan, f.srcID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	f.assertNothingForwarded(t, files)
}

// Edge case 2b: read access to the source is lost in the same window.
func TestForward_ReadLostMidFlightIsRefusedAndReleased(t *testing.T) {
	f := newForwardFixture(t, nil)
	files := f.storedFiles(t)
	f.svc.forward.afterClone = func() {
		seedChannelOverride(t, f.database, permissions.MemberRoleID, fwdSrcChan, 0, permissions.ReadMessages)
		f.perms.InvalidateAll()
	}
	_, err := f.forward(fwdDstChan, f.srcID)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	f.assertNothingForwarded(t, files)
}

// assertNothingForwarded checks a refused forward left no message, no side
// row, no clone row or file, and charged the forwarder nothing.
func (f *forwardFixture) assertNothingForwarded(t *testing.T, filesBefore int) {
	t.Helper()
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, fwdDstChan); n != 0 {
		t.Errorf("a refused forward left %d messages", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_forwards`); n != 0 {
		t.Errorf("a refused forward left %d side rows", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE uploader_id = ?`, fwdBob); n != 0 {
		t.Errorf("a refused forward left %d clone rows", n)
	}
	if got := f.storedFiles(t); got != filesBefore {
		t.Errorf("files on disk = %d, want %d (the clones must be removed)", got, filesBefore)
	}
	if got := f.used(t, fwdBob); got != 0 {
		t.Errorf("forwarder's storage = %d, want the reservation released", got)
	}
}

func TestForward_GateTable(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name   string
		setup  func(t *testing.T, f *forwardFixture) (target, source int64)
		wantIs error
	}{
		{"no such message", func(*testing.T, *forwardFixture) (int64, int64) { return fwdDstChan, 9999 }, ErrNotFound},
		{"unreadable source channel", func(t *testing.T, f *forwardFixture) (int64, int64) {
			id, err := f.database.CreateMessage(ctx, fwdLockedChan, fwdAlice, "secret", nil)
			if err != nil {
				t.Fatal(err)
			}
			return fwdDstChan, id
		}, ErrNotFound},
		{"deleted source", func(t *testing.T, f *forwardFixture) (int64, int64) {
			if err := f.database.DeleteMessage(ctx, f.srcID, fwdAlice, false); err != nil {
				t.Fatal(err)
			}
			return fwdDstChan, f.srcID
		}, ErrNotFound},
		{"source is not an ordinary message", func(t *testing.T, f *forwardFixture) (int64, int64) {
			if _, err := f.database.ExecContext(ctx, `UPDATE messages SET kind = 1 WHERE id = ?`, f.srcID); err != nil {
				t.Fatal(err)
			}
			return fwdDstChan, f.srcID
		}, ErrNotFound},
		{"source in a DM the forwarder is not in", func(t *testing.T, f *forwardFixture) (int64, int64) {
			id, err := f.svc.SendMessage(ctx, SendMessageParams{ChannelID: fwdDM, UserID: fwdCarol, Username: "carol", Content: "private"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.database.ExecContext(ctx, `DELETE FROM dm_participants WHERE user_id = ?`, fwdBob); err != nil {
				t.Fatal(err)
			}
			return fwdDstChan, id.MessageID
		}, ErrNotFound},
		{"target without SEND_MESSAGES", func(*testing.T, *forwardFixture) (int64, int64) { return fwdNoSendChan, 0 }, ErrForbidden},
		{"target without READ_MESSAGES", func(*testing.T, *forwardFixture) (int64, int64) { return fwdLockedChan, 0 }, ErrForbidden},
		{"target archived", func(*testing.T, *forwardFixture) (int64, int64) { return fwdArchived, 0 }, ErrForbidden},
		{"target without ATTACH_FILES and the source has files", func(*testing.T, *forwardFixture) (int64, int64) { return fwdNoFilesDst, 0 }, ErrForbidden},
		{"no such target", func(*testing.T, *forwardFixture) (int64, int64) { return 9999, 0 }, ErrNotFound},
		{"labelled source to an unlabelled channel", func(t *testing.T, f *forwardFixture) (int64, int64) {
			return fwdDstChan, f.nsfwSource(t)
		}, ErrForbidden},
		{"labelled source to a DM", func(t *testing.T, f *forwardFixture) (int64, int64) {
			return fwdDM, f.nsfwSource(t)
		}, ErrForbidden},
		{"labelled source the forwarder never acknowledged", func(t *testing.T, f *forwardFixture) (int64, int64) {
			id, _ := f.sendWithFile(t, fwdAlice, fwdNSFWSrc, "spicy", "PNGDATA-nsfw")
			return fwdNSFWDst, id
		}, ErrNotFound},
		{"DM with a blocking recipient", func(t *testing.T, f *forwardFixture) (int64, int64) {
			seedBlock(t, f.database, fwdCarol, fwdBob)
			return fwdDM, 0
		}, ErrBlocked},
		{"forwarder timed out", func(t *testing.T, f *forwardFixture) (int64, int64) {
			if _, err := f.database.ExecContext(ctx,
				`INSERT INTO moderation_actions (kind, target_id, expires_at) VALUES ('timeout', ?, '2999-01-01 00:00:00')`, fwdBob); err != nil {
				t.Fatal(err)
			}
			if err := f.perms.RefreshTimeouts(ctx); err != nil {
				t.Fatal(err)
			}
			return fwdDstChan, 0
		}, ErrTimedOut},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newForwardFixture(t, nil)
			target, source := tc.setup(t, f)
			if source == 0 {
				source = f.srcID
			}
			files := f.storedFiles(t)
			_, err := f.forward(target, source)
			if !errors.Is(err, tc.wantIs) {
				t.Fatalf("err = %v, want %v", err, tc.wantIs)
			}
			if n := f.count(t, `SELECT COUNT(*) FROM message_forwards`); n != 0 {
				t.Errorf("a refused forward left %d side rows", n)
			}
			if got := f.storedFiles(t); got != files {
				t.Errorf("a refused forward left files: %d, want %d", got, files)
			}
			if got := f.used(t, fwdBob); got != 0 {
				t.Errorf("a refused forward charged the forwarder %d", got)
			}
		})
	}
}

// nsfwSource sends a message with a file into the labelled source channel and
// makes bob acknowledge it, so only the destination rule can refuse.
func (f *forwardFixture) nsfwSource(t *testing.T) int64 {
	t.Helper()
	id, _ := f.sendWithFile(t, fwdAlice, fwdNSFWSrc, "spicy", "PNGDATA-nsfw")
	if _, err := f.database.AcknowledgeNSFW(context.Background(), fwdBob, fwdNSFWSrc); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestForward_LabelledSourceGoesToAnotherLabelledChannel(t *testing.T) {
	f := newForwardFixture(t, nil)
	src := f.nsfwSource(t)
	res, err := f.forward(fwdNSFWDst, src)
	if err != nil {
		t.Fatalf("labelled to labelled: %v", err)
	}
	if res.Forward == nil || res.Forward.SourceChannelID != fwdNSFWSrc {
		t.Errorf("forward block = %+v", res.Forward)
	}
}

func TestForward_TextOnlySourceNeedsNoAttachPermission(t *testing.T) {
	f := newForwardFixture(t, nil)
	res, err := f.svc.SendMessage(context.Background(), SendMessageParams{
		ChannelID: fwdSrcChan, UserID: fwdAlice, Username: "alice", Content: "just text",
	})
	if err != nil {
		t.Fatal(err)
	}
	fw, err := f.forward(fwdNoFilesDst, res.MessageID)
	if err != nil {
		t.Fatalf("text-only forward into a no-files channel: %v", err)
	}
	if len(fw.Attachments) != 0 || fw.Content != "just text" {
		t.Errorf("result = %+v", fw)
	}
}

type countingPush struct {
	mu    sync.Mutex
	calls [][]int64
}

func (p *countingPush) Notify(_ context.Context, _, _ int64, candidates []int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, candidates)
}

func (p *countingPush) n() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls)
}

func TestForward_NoMentionsNoChannelPush(t *testing.T) {
	f := newForwardFixture(t, nil)
	push := &countingPush{}
	f.svc.SetPushNotifier(push)
	// The source holds @carol and @everyone, and alice may mention everyone.
	if _, err := f.database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE id = ?`, permissions.MentionEveryone, permissions.MemberRoleID); err != nil {
		t.Fatal(err)
	}
	f.perms.InvalidateAll()

	res := mustForward(t, f, fwdDstChan, f.srcID)
	if len(res.Mentions) != 0 || res.MentionsEveryone || res.MentionsHere {
		t.Errorf("a forward carries mentions: %+v", res)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, res.MessageID); n != 0 {
		t.Errorf("message_mentions rows = %d, want 0", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE id = ? AND mentions_everyone = 0`, res.MessageID); n != 1 {
		t.Error("the forward is stored with mentions_everyone set")
	}
	if _, count, _, err := f.database.GetReadState(context.Background(), fwdCarol, fwdDstChan); err != nil || count != 0 {
		t.Errorf("carol's mention badge = %d, %v", count, err)
	}
	if push.n() != 0 {
		t.Errorf("a channel forward sent %d push dispatches", push.n())
	}

	// A DM target is pushed to its participants, as any DM message is.
	dmRes := mustForward(t, f, fwdDM, f.srcID)
	if !dmRes.IsDM || push.n() != 1 {
		t.Fatalf("DM forward: IsDM=%v pushes=%d", dmRes.IsDM, push.n())
	}
	if len(dmRes.Mentions) != 0 {
		t.Errorf("DM forward mentions = %v", dmRes.Mentions)
	}
}

func TestForward_OfForwardKeepsOrigin(t *testing.T) {
	f := newForwardFixture(t, nil)
	src, _ := f.database.GetMessage(context.Background(), f.srcID)
	first := mustForward(t, f, fwdDstChan, f.srcID)
	second := mustForward(t, f, fwdSrcChan, first.MessageID)

	if second.Forward == nil || second.Forward.SourceMessageID == nil || *second.Forward.SourceMessageID != f.srcID ||
		second.Forward.SourceChannelID != fwdSrcChan || second.Forward.SourceTimestamp != src.Timestamp {
		t.Fatalf("forward of a forward = %+v, want the original's fields", second.Forward)
	}
	row, err := f.database.GetMessageForward(context.Background(), second.MessageID)
	if err != nil || row == nil || row.SourceMessageID == nil || *row.SourceMessageID != f.srcID {
		t.Fatalf("stored side row = %+v, %v", row, err)
	}
	if second.Content != src.Content || len(second.Attachments) != 1 {
		t.Errorf("snapshot not carried through: %+v", second)
	}
}

func TestForward_OfForwardWithDeletedOriginalHasNoJumpLink(t *testing.T) {
	f := newForwardFixture(t, nil)
	first := mustForward(t, f, fwdDstChan, f.srcID)
	if err := f.database.DeleteMessage(context.Background(), f.srcID, fwdAlice, false); err != nil {
		t.Fatal(err)
	}
	second := mustForward(t, f, fwdSrcChan, first.MessageID)
	if second.Forward == nil || second.Forward.SourceMessageID != nil {
		t.Fatalf("forward of a forward of a deleted original = %+v, want no jump link", second.Forward)
	}
}

func TestForward_EditOfForwardRefused(t *testing.T) {
	f := newForwardFixture(t, nil)
	res := mustForward(t, f, fwdDstChan, f.srcID)
	if _, err := f.svc.EditMessage(context.Background(), fwdBob, res.MessageID, "rewritten"); err == nil {
		t.Fatal("editing a forward succeeded")
	}
	msg, _ := f.database.GetMessage(context.Background(), res.MessageID)
	if msg.Content != "see @carol and @everyone" || msg.EditedAt != nil {
		t.Errorf("forward after the refused edit = %+v", msg)
	}
}

func TestForward_RateLimit(t *testing.T) {
	f := newForwardFixture(t, auth.NewRateLimiter())
	cmid := newClientMessageID()
	if _, err := f.forwardAs(fwdBob, cmid, fwdDstChan, f.srcID); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < forwardLimit; i++ {
		if _, err := f.forward(fwdDstChan, f.srcID); err != nil {
			t.Fatalf("forward %d: %v", i+1, err)
		}
	}
	if _, err := f.forward(fwdDstChan, f.srcID); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("forward past the limit: err = %v, want ErrRateLimited", err)
	}
	// A retry of an accepted forward is free: it never reaches the limiter.
	if res, err := f.forwardAs(fwdBob, cmid, fwdDstChan, f.srcID); err != nil || !res.Duplicate {
		t.Errorf("retry while limited = %+v, %v", res, err)
	}
	// Another user has their own budget.
	if _, err := f.forwardAs(fwdAlice, newClientMessageID(), fwdDstChan, f.srcID); err != nil {
		t.Errorf("another user's forward: %v", err)
	}
}

func TestForward_QuotaRefusal(t *testing.T) {
	f := newForwardFixture(t, nil)
	f.uploads.SetStorageLimits(StorageLimits{UserQuotaBytes: f.fileSize - 1, Dir: f.dir, FreeBytes: func(string) (uint64, error) { return 0, errors.New("unknown") }})
	files := f.storedFiles(t)
	_, err := f.forward(fwdDstChan, f.srcID)
	if !errors.Is(err, ErrQuotaExceeded) || !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrQuotaExceeded wrapped in ErrForbidden", err)
	}
	f.assertNothingForwarded(t, files)
}

func TestForward_MissingFileIsSkippedLikeAnUpload(t *testing.T) {
	f := newForwardFixture(t, nil)
	if err := f.files.Delete(f.srcFile); err != nil {
		t.Fatal(err)
	}
	res := mustForward(t, f, fwdDstChan, f.srcID)
	if len(res.Attachments) != 0 || res.Content == "" {
		t.Fatalf("text should go through without the lost file: %+v", res)
	}
	// With no text, nothing is left to forward.
	id, fileID := f.sendWithFile(t, fwdAlice, fwdSrcChan, "", "PNGDATA-only-file")
	if err := f.files.Delete(fileID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.forward(fwdDstChan, id); !errors.Is(err, ErrAttachmentsUnavailable) {
		t.Errorf("file-only message whose file is gone: err = %v, want ErrAttachmentsUnavailable", err)
	}
}

func TestForward_RequiresAValidClientMessageID(t *testing.T) {
	f := newForwardFixture(t, nil)
	for _, cmid := range []string{"", "not-a-valid-id"} {
		if _, err := f.forwardAs(fwdBob, cmid, fwdDstChan, f.srcID); !errors.Is(err, ErrBadRequest) {
			t.Errorf("client_message_id %q: err = %v, want ErrBadRequest", cmid, err)
		}
	}
	if _, err := f.forward(fwdDstChan, 0); !errors.Is(err, ErrBadRequest) {
		t.Errorf("message_id 0: err = %v, want ErrBadRequest", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_forwards`); n != 0 {
		t.Errorf("rejected forwards left %d side rows", n)
	}
}

// An untrusted one-to-one DM recipient is not delivered to: the first-contact
// gate stages a message request, exactly as it does for a send.
func TestForward_UntrustedDMIsStagedAsARequest(t *testing.T) {
	f := newForwardFixture(t, nil)
	f.svc.SetMessageRequests(NewMessageRequestService(f.database, NewBlockService(f.database)))
	res := mustForward(t, f, fwdDM, f.srcID)
	if len(res.RequestCreatedFor) != 1 || res.RequestCreatedFor[0].RecipientID != fwdCarol {
		t.Fatalf("RequestCreatedFor = %+v, want one request for carol", res.RequestCreatedFor)
	}
	if slices.Contains(res.ParticipantIDs, fwdCarol) {
		t.Errorf("an untrusted recipient is in the live audience: %v", res.ParticipantIDs)
	}
	if res.RequestPreview == nil || res.RequestPreview.MessageID != res.MessageID {
		t.Errorf("request preview = %+v", res.RequestPreview)
	}
}
