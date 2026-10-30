package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// chargeCounter puts the user's counter at the sum of their rows, as a run of
// real uploads would have left it.
func (f *forwardFixture) chargeCounter(t *testing.T, user int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.database.ChargeUserStorage(ctx, user, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.database.RecountUserStorage(ctx, user); err != nil {
		t.Fatal(err)
	}
}

func (f *forwardFixture) rowBytes(t *testing.T, user int64) int64 {
	t.Helper()
	var n int64
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT COALESCE(SUM(size), 0) FROM attachments WHERE uploader_id = ?`, user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// addFile stores a second file on an existing message.
func (f *forwardFixture) addFile(t *testing.T, user, msgID int64, id, body string) {
	t.Helper()
	if err := f.database.CreateAttachment(context.Background(), id, user, id+".txt", id, "text/plain", int64(len(body)), nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.ExecContext(context.Background(), `UPDATE attachments SET message_id = ? WHERE id = ?`, msgID, id); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveOwnUpload_SecondRemovalIsNotFoundAndNothingIsReleasedTwice(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "mine", "0123456789")
	f.chargeCounter(t, fwdBob)
	f.addFile(t, fwdBob, msgID, "keep-me", "abcde") // 5 bytes bob keeps
	f.chargeCounter(t, fwdBob)
	if got := f.used(t, fwdBob); got != 15 {
		t.Fatalf("counter before = %d, want 15", got)
	}

	removed, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob)
	if err != nil {
		t.Fatalf("first removal: %v", err)
	}
	if removed.StoredAs != fileID || removed.Size != 10 || removed.MessageID == nil || *removed.MessageID != msgID {
		t.Errorf("removed = %+v, want stored %s size 10 message %d", removed, fileID, msgID)
	}
	if got := f.used(t, fwdBob); got != 5 {
		t.Errorf("counter after removal = %d, want 5", got)
	}

	if _, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second removal err = %v, want ErrNotFound", err)
	}
	if got, rows := f.used(t, fwdBob), f.rowBytes(t, fwdBob); got != 5 || rows != 5 {
		t.Errorf("counter %d rows %d after the repeat, want both 5 (released twice?)", got, rows)
	}
}

func TestRemoveOwnUpload_ConcurrentCallersOneWins(t *testing.T) {
	f := newForwardFixture(t, nil)
	_, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "mine", "0123456789")
	f.chargeCounter(t, fwdBob)

	var ok, notFound, other atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 8 {
		wg.Go(func() {
			<-start
			_, err := f.uploads.RemoveOwnUpload(context.Background(), fileID, fwdBob)
			switch {
			case err == nil:
				ok.Add(1)
			case errors.Is(err, ErrNotFound):
				notFound.Add(1)
			default:
				other.Add(1)
			}
		})
	}
	close(start)
	wg.Wait()
	if ok.Load() != 1 || notFound.Load() != 7 || other.Load() != 0 {
		t.Errorf("ok=%d notFound=%d other=%d, want 1/7/0", ok.Load(), notFound.Load(), other.Load())
	}
	if got := f.used(t, fwdBob); got != 0 {
		t.Errorf("counter = %d, want 0", got)
	}
}

func TestRemoveOwnUpload_RefusesOthersInUseAndUnknown(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	if _, err := f.uploads.RemoveOwnUpload(ctx, f.srcFile, fwdBob); !errors.Is(err, ErrNotFound) {
		t.Errorf("someone else's file err = %v, want ErrNotFound", err)
	}
	if _, err := f.uploads.RemoveOwnUpload(ctx, "no-such-file", fwdBob); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id err = %v, want ErrNotFound", err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET avatar = '/api/v1/files/' || ? WHERE id = ?`, f.srcFile, fwdAlice); err != nil {
		t.Fatal(err)
	}
	_, err := f.uploads.RemoveOwnUpload(ctx, f.srcFile, fwdAlice)
	if !errors.Is(err, ErrUploadInUse) || !errors.Is(err, ErrConflict) {
		t.Errorf("avatar err = %v, want ErrUploadInUse (a conflict)", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM attachments WHERE id = ?`, f.srcFile); n != 1 {
		t.Errorf("in-use row count = %d, want 1", n)
	}
}

func TestAfterAttachmentRemoved_MessageDeletedMeanwhileAnnouncesNothing(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "going away", "0123456789")
	if _, err := f.svc.DeleteMessage(ctx, fwdBob, msgID); err != nil {
		t.Fatal(err)
	}
	removed, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob)
	if err != nil || removed.MessageID == nil {
		t.Fatalf("removal = %+v, %v; want success on a soft-deleted message's file", removed, err)
	}
	changed, deleted, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, msgID)
	if err != nil || changed != nil || deleted != nil {
		t.Errorf("after = %v %v %v, want nothing to announce", changed, deleted, err)
	}
}

func TestAfterAttachmentRemoved_LastFileOfBlankMessageDeletesIt(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "", "0123456789")
	if _, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob); err != nil {
		t.Fatal(err)
	}
	changed, deleted, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, msgID)
	if err != nil || changed != nil || deleted == nil {
		t.Fatalf("after = %v %v %v, want a delete result", changed, deleted, err)
	}
	if deleted.MessageID != msgID || deleted.ChannelID != fwdDstChan || deleted.IsDM {
		t.Errorf("delete result = %+v", deleted)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE id = ? AND deleted = 1`, msgID); n != 1 {
		t.Errorf("message soft-deleted rows = %d, want 1", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM audit_log WHERE action = 'message_delete' AND target_id = ?`, msgID); n != 1 {
		t.Errorf("message_delete audit rows = %d, want 1 (the normal own-delete path)", n)
	}
}

func TestAfterAttachmentRemoved_LastFileWithTextAnnouncesEmptyListAndKeepsMentions(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "hi @carol", "0123456789")
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, msgID); n != 1 {
		t.Fatalf("seed mentions = %d, want 1", n)
	}
	if _, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob); err != nil {
		t.Fatal(err)
	}
	changed, deleted, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, msgID)
	if err != nil || deleted != nil || changed == nil {
		t.Fatalf("after = %v %v %v, want a changed result", changed, deleted, err)
	}
	if changed.Attachments == nil || len(changed.Attachments) != 0 {
		t.Errorf("attachments = %#v, want a non-nil empty list", changed.Attachments)
	}
	if changed.Content != "hi @carol" || changed.EditedAt != nil {
		t.Errorf("content %q edited_at %v, want unchanged text and nil edited_at", changed.Content, changed.EditedAt)
	}
	if len(changed.Mentions) != 1 || changed.Mentions[0] != fwdCarol {
		t.Errorf("mentions = %v, want [%d]", changed.Mentions, fwdCarol)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE id = ? AND deleted = 0 AND edited_at IS NULL`, msgID); n != 1 {
		t.Errorf("message must stay live and unedited, rows = %d", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, msgID); n != 1 {
		t.Errorf("stored mentions = %d, want 1", n)
	}
}

func TestAfterAttachmentRemoved_KeepsTheOtherFiles(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "", "0123456789")
	f.addFile(t, fwdBob, msgID, "second", "abc")
	if _, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob); err != nil {
		t.Fatal(err)
	}
	changed, deleted, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, msgID)
	if err != nil || deleted != nil || changed == nil {
		t.Fatalf("after = %v %v %v, want a changed result", changed, deleted, err)
	}
	if len(changed.Attachments) != 1 || changed.Attachments[0].ID != "second" {
		t.Errorf("attachments = %+v, want just second", changed.Attachments)
	}
}

func TestAfterAttachmentRemoved_ArchivedChannelFallsBackToChanged(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "", "0123456789")
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = ?`, fwdDstChan); err != nil {
		t.Fatal(err)
	}
	if _, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob); err != nil {
		t.Fatal(err)
	}
	changed, deleted, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, msgID)
	if err != nil || deleted != nil || changed == nil || len(changed.Attachments) != 0 {
		t.Fatalf("after = %+v %v %v, want a changed result with no files", changed, deleted, err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE id = ? AND deleted = 0`, msgID); n != 1 {
		t.Errorf("message must survive a refused delete, rows = %d", n)
	}
}

func TestAfterAttachmentRemoved_ForwardIsNeverDeletedNorGainsMentions(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	res := mustForward(t, f, fwdDstChan, f.srcID)
	var cloneID string
	if err := f.database.QueryRowContext(ctx, `SELECT id FROM attachments WHERE message_id = ?`, res.MessageID).Scan(&cloneID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.uploads.RemoveOwnUpload(ctx, cloneID, fwdBob); err != nil {
		t.Fatal(err)
	}
	changed, deleted, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, res.MessageID)
	if err != nil || deleted != nil || changed == nil {
		t.Fatalf("after = %v %v %v, want a changed result", changed, deleted, err)
	}
	if len(changed.Mentions) != 0 || changed.MentionsEveryone {
		t.Errorf("a forward gained mentions: %v everyone=%v", changed.Mentions, changed.MentionsEveryone)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM message_mentions WHERE message_id = ?`, res.MessageID); n != 0 {
		t.Errorf("stored mentions on the forward = %d, want 0", n)
	}
}

func TestAfterAttachmentRemoved_DMAudienceIsTheParticipants(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	msgID, fileID := f.sendWithFile(t, fwdBob, fwdDM, "private", "0123456789")
	if _, err := f.uploads.RemoveOwnUpload(ctx, fileID, fwdBob); err != nil {
		t.Fatal(err)
	}
	changed, _, err := f.svc.AfterAttachmentRemoved(ctx, fwdBob, msgID)
	if err != nil || changed == nil || !changed.IsDM {
		t.Fatalf("after = %+v %v, want a DM changed result", changed, err)
	}
	if !slices.Equal(slices.Sorted(slices.Values(changed.ParticipantIDs)), []int64{fwdBob, fwdCarol}) {
		t.Errorf("participants = %v, want bob and carol", changed.ParticipantIDs)
	}
}

func TestStorageSummary(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	got, err := f.uploads.StorageSummary(ctx, fwdCarol)
	if err != nil || got != (StorageSummary{}) {
		t.Errorf("no counter row = %+v, %v; want zeros (unlimited)", got, err)
	}
	f.uploads.SetStorageLimits(StorageLimits{UserQuotaBytes: 1000, Dir: f.dir})
	if _, err := f.database.ChargeUserStorage(ctx, fwdCarol, 42, 0); err != nil {
		t.Fatal(err)
	}
	got, err = f.uploads.StorageSummary(ctx, fwdCarol)
	if err != nil || got.UsedBytes != 42 || got.QuotaBytes != 1000 {
		t.Errorf("summary = %+v, %v; want used 42 quota 1000", got, err)
	}
}

func TestListOwnUploads_PagingCursorAndValidation(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	for i := range 3 {
		f.sendWithFile(t, fwdBob, fwdDstChan, "", fmt.Sprintf("body-%d-padding", i))
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE attachments SET uploaded_at = '2026-01-01 00:00:00' WHERE uploader_id = ?`, fwdBob); err != nil {
		t.Fatal(err)
	}
	for _, sort := range []string{"", db.UploadSortNewest, db.UploadSortLargest} {
		seen := map[string]bool{}
		cursor := ""
		for range 5 {
			page, err := f.uploads.ListOwnUploads(ctx, fwdBob, OwnUploadsRequest{Sort: sort, Limit: 2, Cursor: cursor})
			if err != nil {
				t.Fatalf("sort %q: %v", sort, err)
			}
			for _, it := range page.Items {
				if seen[it.Attachment.ID] {
					t.Fatalf("sort %q repeated %s", sort, it.Attachment.ID)
				}
				seen[it.Attachment.ID] = true
			}
			if page.NextCursor == "" {
				break
			}
			cursor = page.NextCursor
		}
		if len(seen) != 3 {
			t.Errorf("sort %q saw %d files, want 3", sort, len(seen))
		}
	}

	newest, err := f.uploads.ListOwnUploads(ctx, fwdBob, OwnUploadsRequest{Limit: 1})
	if err != nil || newest.NextCursor == "" {
		t.Fatalf("first page = %+v, %v", newest, err)
	}
	for name, in := range map[string]OwnUploadsRequest{
		"bad sort":        {Sort: "oldest"},
		"long q":          {Name: strings.Repeat("x", OwnUploadNameMaxLen+1)},
		"garbage cursor":  {Cursor: "not a cursor!"},
		"other-sort curs": {Sort: db.UploadSortLargest, Cursor: newest.NextCursor},
		"forged id":       {Cursor: "bnw6MjAyNi0wMS0wMXwnOy0t"},
	} {
		if _, err := f.uploads.ListOwnUploads(ctx, fwdBob, in); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
	// A page beyond the cap is clamped, not refused.
	if page, err := f.uploads.ListOwnUploads(ctx, fwdBob, OwnUploadsRequest{Limit: 10_000}); err != nil || len(page.Items) != 3 {
		t.Errorf("huge limit = %d items, %v; want 3, nil", len(page.Items), err)
	}
}
