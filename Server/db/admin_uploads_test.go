package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func adminUploadIDs(items []db.AdminUpload) string {
	out := ""
	for i := range items {
		if i > 0 {
			out += ","
		}
		out += items[i].Attachment.ID
	}
	return out
}

func TestListAllUploads_FiltersSortAndPaging(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	f.file(t, "a-big", f.alice, "Raid.MP4", 900, "2026-01-01 10:00:00")
	f.file(t, "a-small", f.alice, "notes.txt", 10, "2026-03-01 10:00:00")
	f.file(t, "b-mid", f.bob, "song.mp3", 500, "2026-02-01 10:00:00")
	if _, err := f.database.ExecContext(ctx, `UPDATE attachments SET mime_type = 'video/mp4' WHERE id = 'a-big'`); err != nil {
		t.Fatal(err)
	}
	f.link(t, "a-big", f.alice, false)
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET avatar = '/api/v1/files/b-mid' WHERE id = ?`, f.bob); err != nil {
		t.Fatal(err)
	}

	list := func(q db.AdminUploadQuery) []db.AdminUpload {
		t.Helper()
		if q.Sort == "" {
			q.Sort = db.UploadSortNewest
		}
		if q.Limit == 0 {
			q.Limit = 50
		}
		items, err := f.database.ListAllUploads(ctx, q)
		if err != nil {
			t.Fatalf("ListAllUploads(%+v): %v", q, err)
		}
		return items
	}

	if got := adminUploadIDs(list(db.AdminUploadQuery{})); got != "a-small,b-mid,a-big" {
		t.Errorf("newest = %s", got)
	}
	if got := adminUploadIDs(list(db.AdminUploadQuery{Sort: db.UploadSortLargest})); got != "a-big,b-mid,a-small" {
		t.Errorf("largest = %s", got)
	}
	for name, tc := range map[string]struct {
		q    db.AdminUploadQuery
		want string
	}{
		"name":     {db.AdminUploadQuery{Name: "raid"}, "a-big"},
		"kind":     {db.AdminUploadQuery{Kind: db.UploadKindVideo}, "a-big"},
		"uploader": {db.AdminUploadQuery{UploaderID: f.bob}, "b-mid"},
		"channel":  {db.AdminUploadQuery{ChannelID: f.ch}, "a-big"},
		"before":   {db.AdminUploadQuery{Before: "2026-02-15 00:00:00"}, "b-mid,a-big"},
	} {
		if got := adminUploadIDs(list(tc.q)); got != tc.want {
			t.Errorf("%s filter = %s, want %s", name, got, tc.want)
		}
	}

	first := list(db.AdminUploadQuery{Sort: db.UploadSortLargest, Limit: 1})
	next := list(db.AdminUploadQuery{Sort: db.UploadSortLargest, Limit: 2, Cursor: db.OwnUploadCursor{
		UploadedAt: first[0].UploadedAt, Size: first[0].Attachment.Size, ID: first[0].Attachment.ID,
	}})
	if got := adminUploadIDs(next); got != "b-mid,a-small" {
		t.Errorf("largest after a-big = %s", got)
	}
	older := list(db.AdminUploadQuery{Limit: 5, Cursor: db.OwnUploadCursor{UploadedAt: "2026-03-01 10:00:00", ID: "a-small"}})
	if got := adminUploadIDs(older); got != "b-mid,a-big" {
		t.Errorf("newest after a-small = %s", got)
	}

	all := list(db.AdminUploadQuery{})
	for _, it := range all {
		switch it.Attachment.ID {
		case "a-big":
			if it.ChannelName != "general" || it.MessageID == nil || !it.Removable || it.Uploader != "alice" {
				t.Errorf("a-big = %+v", it)
			}
		case "b-mid":
			if it.Removable {
				t.Errorf("an avatar file is removable: %+v", it)
			}
		}
	}
}

func TestUploadTotals_GroupsByKind(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	f.file(t, "v1", f.alice, "a.mp4", 100, "2026-01-01 10:00:00")
	f.file(t, "o1", f.alice, "a.bin", 7, "2026-01-01 10:00:00")
	f.file(t, "o2", f.bob, "b.bin", 3, "2026-01-01 10:00:00")
	if _, err := f.database.ExecContext(ctx, `UPDATE attachments SET mime_type = 'video/mp4' WHERE id = 'v1'`); err != nil {
		t.Fatal(err)
	}
	totals, err := f.database.UploadTotals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]db.UploadKindTotal{}
	for _, k := range totals {
		got[k.Kind] = k
	}
	if got[db.UploadKindVideo].Count != 1 || got[db.UploadKindVideo].Bytes != 100 ||
		got[db.UploadKindOther].Count != 2 || got[db.UploadKindOther].Bytes != 10 {
		t.Errorf("totals = %+v", totals)
	}
}

func TestDeleteAttachmentByAdmin_AndInUse(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	f.file(t, "gone", f.alice, "x.bin", 42, "2026-01-01 10:00:00")
	f.file(t, "face", f.bob, "me.png", 5, "2026-01-01 10:00:00")
	msgID := f.link(t, "gone", f.alice, false)
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET avatar = '/api/v1/files/face' WHERE id = ?`, f.bob); err != nil {
		t.Fatal(err)
	}

	if inUse, exists, err := f.database.AttachmentInUse(ctx, "face"); err != nil || !exists || !inUse {
		t.Errorf("avatar in use = %v exists = %v err = %v", inUse, exists, err)
	}
	if inUse, exists, err := f.database.AttachmentInUse(ctx, "gone"); err != nil || !exists || inUse {
		t.Errorf("message file in use = %v exists = %v err = %v", inUse, exists, err)
	}
	if _, exists, err := f.database.AttachmentInUse(ctx, "nope"); err != nil || exists {
		t.Errorf("unknown exists = %v err = %v", exists, err)
	}

	removed, found, err := f.database.DeleteAttachmentByAdmin(ctx, "gone")
	if err != nil || !found {
		t.Fatalf("delete = %v, %v", found, err)
	}
	if removed.StoredAs != "gone.bin" || removed.Size != 42 || removed.Filename != "x.bin" ||
		removed.UploaderID == nil || *removed.UploaderID != f.alice || removed.MessageID == nil || *removed.MessageID != msgID {
		t.Errorf("removed = %+v", removed)
	}
	if _, found, err := f.database.DeleteAttachmentByAdmin(ctx, "gone"); err != nil || found {
		t.Errorf("second delete found = %v err = %v", found, err)
	}
}

func TestUserStorageQuotaMB_SetAndList(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	if q, err := f.database.UserStorageQuotaMB(ctx, f.alice); err != nil || q != nil {
		t.Errorf("fresh quota = %v, %v; want nil", q, err)
	}
	five := int64(5)
	if found, err := f.database.SetUserStorageQuotaMB(ctx, f.alice, &five); err != nil || !found {
		t.Fatalf("set = %v, %v", found, err)
	}
	if q, err := f.database.UserStorageQuotaMB(ctx, f.alice); err != nil || q == nil || *q != 5 {
		t.Errorf("quota = %v, %v; want 5", q, err)
	}
	if found, err := f.database.SetUserStorageQuotaMB(ctx, 999999, &five); err != nil || found {
		t.Errorf("unknown user found = %v err = %v", found, err)
	}

	rows, err := f.database.ListMemberStorage(ctx, []int64{f.alice, f.bob})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].UserID != f.alice || rows[0].QuotaMB == nil || *rows[0].QuotaMB != 5 {
		t.Errorf("member storage = %+v", rows)
	}
	if rows, err := f.database.ListMemberStorage(ctx, nil); err != nil || len(rows) != 0 {
		t.Errorf("no ids = %+v, %v", rows, err)
	}

	if found, err := f.database.SetUserStorageQuotaMB(ctx, f.alice, nil); err != nil || !found {
		t.Fatalf("clear = %v, %v", found, err)
	}
	if q, err := f.database.UserStorageQuotaMB(ctx, f.alice); err != nil || q != nil {
		t.Errorf("cleared quota = %v, %v; want nil", q, err)
	}
}
