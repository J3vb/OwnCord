package service

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
)

// An admin and the member removing the same file at once: exactly one gets the
// row, the other reads "already gone", and the member's bytes come back once.
func TestRemoveUploadAsAdmin_RaceWithOwnRemovalOneWins(t *testing.T) {
	for range 20 {
		f := newForwardFixture(t, nil)
		msgID, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "mine", "0123456789")
		f.addFile(t, fwdBob, msgID, "keep-"+fileID, "abcde")
		f.chargeCounter(t, fwdBob)

		var ok, gone, other atomic.Int64
		var wg sync.WaitGroup
		start := make(chan struct{})
		record := func(err error) {
			switch {
			case err == nil:
				ok.Add(1)
			case errors.Is(err, ErrNotFound):
				gone.Add(1)
			default:
				other.Add(1)
			}
		}
		wg.Go(func() {
			<-start
			_, err := f.uploads.RemoveUploadAsAdmin(context.Background(), fwdAlice, fileID)
			record(err)
		})
		wg.Go(func() {
			<-start
			_, err := f.uploads.RemoveOwnUpload(context.Background(), fileID, fwdBob)
			record(err)
		})
		close(start)
		wg.Wait()
		if ok.Load() != 1 || gone.Load() != 1 || other.Load() != 0 {
			t.Fatalf("ok=%d gone=%d other=%d, want 1/1/0", ok.Load(), gone.Load(), other.Load())
		}
		if got, rows := f.used(t, fwdBob), f.rowBytes(t, fwdBob); got != 5 || rows != 5 {
			t.Fatalf("counter %d rows %d, want both 5", got, rows)
		}
	}
}

func TestRemoveUploadAsAdmin_RefusesInUseAndAudits(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	if _, err := f.uploads.RemoveUploadAsAdmin(ctx, fwdAlice, "no-such-file"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id err = %v, want ErrNotFound", err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET avatar = '/api/v1/files/' || ? WHERE id = ?`, f.srcFile, fwdAlice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.uploads.RemoveUploadAsAdmin(ctx, fwdBob, f.srcFile); !errors.Is(err, ErrUploadInUse) {
		t.Errorf("avatar err = %v, want ErrUploadInUse", err)
	}

	_, fileID := f.sendWithFile(t, fwdBob, fwdDstChan, "", "0123456789")
	f.chargeCounter(t, fwdBob)
	removed, err := f.uploads.RemoveUploadAsAdmin(ctx, fwdAlice, fileID)
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if removed.UploaderID == nil || *removed.UploaderID != fwdBob || removed.Size != 10 || removed.Filename != "pic.png" {
		t.Errorf("removed = %+v, want bob's 10-byte pic.png", removed)
	}
	if got := f.used(t, fwdBob); got != 0 {
		t.Errorf("bob's counter = %d, want 0", got)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM audit_log WHERE action = 'upload_delete' AND actor_id = ? AND target_id = ?`, fwdAlice, fwdBob); n != 1 {
		t.Errorf("upload_delete audit rows = %d, want 1", n)
	}
}

func TestSetMemberQuota_ReplacesTheServerLimit(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	f.uploads.SetStorageLimits(StorageLimits{UserQuotaBytes: 10 << 20, Dir: f.dir})
	reserve := func(n int64) error {
		res, err := f.uploads.Reserve(ctx, fwdCarol, n)
		if err == nil {
			res.Release(ctx)
		}
		return err
	}

	one := int64(1)
	if err := f.uploads.SetMemberQuota(ctx, fwdAlice, fwdCarol, &one); err != nil {
		t.Fatalf("set 1 MB: %v", err)
	}
	if err := reserve(2 << 20); !errors.Is(err, ErrQuotaExceeded) {
		t.Errorf("2 MB under a 1 MB member limit: err = %v, want ErrQuotaExceeded", err)
	}
	if sum, _ := f.uploads.StorageSummary(ctx, fwdCarol); sum.QuotaBytes != 1<<20 {
		t.Errorf("summary quota = %d, want the member's 1 MB", sum.QuotaBytes)
	}

	zero := int64(0)
	if err := f.uploads.SetMemberQuota(ctx, fwdAlice, fwdCarol, &zero); err != nil {
		t.Fatalf("set none: %v", err)
	}
	if err := reserve(20 << 20); err != nil {
		t.Errorf("20 MB with no member limit: %v", err)
	}

	if err := f.uploads.SetMemberQuota(ctx, fwdAlice, fwdCarol, nil); err != nil {
		t.Fatalf("back to default: %v", err)
	}
	if err := reserve(20 << 20); !errors.Is(err, ErrQuotaExceeded) {
		t.Errorf("20 MB under the 10 MB server limit: err = %v, want ErrQuotaExceeded", err)
	}

	tooBig := int64(MemberQuotaMaxMB + 1)
	if err := f.uploads.SetMemberQuota(ctx, fwdAlice, fwdCarol, &tooBig); !errors.Is(err, ErrBadRequest) {
		t.Errorf("over the cap: err = %v, want ErrBadRequest", err)
	}
	if err := f.uploads.SetMemberQuota(ctx, fwdAlice, 9999, &one); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown user: err = %v, want ErrNotFound", err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM audit_log WHERE action = 'upload_limit_change' AND target_id = ?`, fwdCarol); n != 3 {
		t.Errorf("upload_limit_change audit rows = %d, want 3", n)
	}
	rows, err := f.uploads.MemberStorage(ctx, []int64{fwdCarol, fwdBob})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].UserID != fwdCarol || rows[0].QuotaMB != nil {
		t.Errorf("member storage = %+v, want carol only, on the server default", rows)
	}
}

func TestListAllUploads_FiltersAndPaging(t *testing.T) {
	f := newForwardFixture(t, nil)
	ctx := context.Background()
	_, bobFile := f.sendWithFile(t, fwdBob, fwdDstChan, "", "0123456789")
	_, carolFile := f.sendWithFile(t, fwdCarol, fwdDM, "", "01234")
	if _, err := f.database.ExecContext(ctx, `UPDATE attachments SET mime_type = 'video/mp4', uploaded_at = '2020-01-01 00:00:00' WHERE id = ?`, carolFile); err != nil {
		t.Fatal(err)
	}

	page, err := f.uploads.ListAllUploads(ctx, AdminUploadsRequest{UploaderID: fwdBob})
	if err != nil || len(page.Items) != 1 || page.Items[0].Attachment.ID != bobFile || page.Items[0].Uploader != "bob" || page.Items[0].ChannelName != "target" {
		t.Fatalf("bob's files = %+v, %v", page.Items, err)
	}
	page, err = f.uploads.ListAllUploads(ctx, AdminUploadsRequest{Kind: db.UploadKindVideo, OlderThanDays: 30})
	if err != nil || len(page.Items) != 1 || page.Items[0].Attachment.ID != carolFile {
		t.Fatalf("old videos = %+v, %v", page.Items, err)
	}
	if it := page.Items[0]; it.ChannelType != "dm" || it.ChannelName != "" {
		t.Errorf("a DM file shows channel %q type %q, want no name and type dm", it.ChannelName, it.ChannelType)
	}

	first, err := f.uploads.ListAllUploads(ctx, AdminUploadsRequest{Limit: 1})
	if err != nil || len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	second, err := f.uploads.ListAllUploads(ctx, AdminUploadsRequest{Limit: 1, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Attachment.ID == first.Items[0].Attachment.ID {
		t.Fatalf("second page = %+v, %v", second, err)
	}

	for _, bad := range []AdminUploadsRequest{{Sort: "oldest"}, {Kind: "pdf"}, {OlderThanDays: -1}, {Cursor: "zzz"}} {
		if _, err := f.uploads.ListAllUploads(ctx, bad); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%+v: err = %v, want ErrBadRequest", bad, err)
		}
	}
}

type fakeLister []storage.Entry

func (l fakeLister) List() ([]storage.Entry, error) { return l, nil }

func TestScanLeftovers_CountsOnlyOldUnnamedFiles(t *testing.T) {
	f := newForwardFixture(t, nil)
	now := time.Now()
	old := now.Add(-48 * time.Hour)
	lister := fakeLister{
		{Name: f.srcFile, ModTime: old, Size: 100},
		{Name: "stray-old", ModTime: old, Size: 7},
		{Name: "stray-new", ModTime: now, Size: 9},
	}
	scan, err := f.uploads.ScanLeftovers(context.Background(), lister, now.Add(-LeftoverMinAge))
	if err != nil || scan != (LeftoverScan{Count: 1, Bytes: 7}) {
		t.Errorf("scan = %+v, %v; want one 7-byte file", scan, err)
	}
}
