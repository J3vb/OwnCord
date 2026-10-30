package db_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

type uploadsFixture struct {
	database   *db.DB
	alice, bob int64
	ch         int64
}

func newUploadsFixture(t *testing.T) uploadsFixture {
	t.Helper()
	database := openMigratedMemory(t)
	return uploadsFixture{
		database: database,
		alice:    seedUser(t, database, "alice"),
		bob:      seedUser(t, database, "bob"),
		ch:       seedChannel(t, database, "general"),
	}
}

// file inserts an attachment row owned by user with the given size and upload time.
func (f uploadsFixture) file(t *testing.T, id string, user int64, name string, size int64, uploadedAt string) {
	t.Helper()
	ctx := context.Background()
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size, uploaded_at)
		 VALUES (?, ?, ?, ?, 'application/octet-stream', ?, ?)`,
		id, user, name, id+".bin", size, uploadedAt); err != nil {
		t.Fatalf("insert attachment %s: %v", id, err)
	}
}

// link attaches the file to a fresh message in ch, marking the message deleted when asked.
func (f uploadsFixture) link(t *testing.T, id string, user int64, deleted bool) int64 {
	t.Helper()
	ctx := context.Background()
	msgID, err := f.database.CreateMessage(ctx, f.ch, user, "files", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE attachments SET message_id = ? WHERE id = ?`, msgID, id); err != nil {
		t.Fatalf("link %s: %v", id, err)
	}
	if deleted {
		if _, err := f.database.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, msgID); err != nil {
			t.Fatalf("soft delete: %v", err)
		}
	}
	return msgID
}

func (f uploadsFixture) list(t *testing.T, q db.OwnUploadQuery) []db.OwnUpload {
	t.Helper()
	if q.UserID == 0 {
		q.UserID = f.alice
	}
	if q.Sort == "" {
		q.Sort = db.UploadSortNewest
	}
	if q.Limit == 0 {
		q.Limit = 50
	}
	items, err := f.database.ListOwnUploads(context.Background(), q)
	if err != nil {
		t.Fatalf("ListOwnUploads: %v", err)
	}
	return items
}

func uploadIDs(items []db.OwnUpload) string {
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = items[i].Attachment.ID
	}
	return fmt.Sprint(ids)
}

func TestListOwnUploads_SortsAndOwnership(t *testing.T) {
	f := newUploadsFixture(t)
	f.file(t, "a1", f.alice, "one.txt", 30, "2026-01-01 10:00:00")
	f.file(t, "a2", f.alice, "two.txt", 10, "2026-01-03 10:00:00")
	f.file(t, "a3", f.alice, "three.txt", 30, "2026-01-02 10:00:00")
	f.file(t, "b1", f.bob, "bob.txt", 99, "2026-01-04 10:00:00")

	if got := uploadIDs(f.list(t, db.OwnUploadQuery{Sort: db.UploadSortNewest})); got != "[a2 a3 a1]" {
		t.Errorf("newest = %s, want [a2 a3 a1]", got)
	}
	// Equal sizes fall back to the id, descending.
	if got := uploadIDs(f.list(t, db.OwnUploadQuery{Sort: db.UploadSortLargest})); got != "[a3 a1 a2]" {
		t.Errorf("largest = %s, want [a3 a1 a2]", got)
	}
	if got := uploadIDs(f.list(t, db.OwnUploadQuery{UserID: f.bob})); got != "[b1]" {
		t.Errorf("bob = %s, want [b1]", got)
	}
}

func TestListOwnUploads_KeysetPaging(t *testing.T) {
	f := newUploadsFixture(t)
	f.file(t, "a1", f.alice, "one.txt", 30, "2026-01-01 10:00:00")
	f.file(t, "a2", f.alice, "two.txt", 10, "2026-01-03 10:00:00")
	f.file(t, "a3", f.alice, "three.txt", 30, "2026-01-03 10:00:00")
	f.file(t, "a4", f.alice, "four.txt", 20, "2026-01-02 10:00:00")

	for _, tc := range []struct {
		sort string
		want [][]string
	}{
		{db.UploadSortNewest, [][]string{{"a3", "a2"}, {"a4", "a1"}}},
		{db.UploadSortLargest, [][]string{{"a3", "a1"}, {"a4", "a2"}}},
	} {
		var cur db.OwnUploadCursor
		for page, want := range tc.want {
			items := f.list(t, db.OwnUploadQuery{Sort: tc.sort, Limit: 2, Cursor: cur})
			if got := uploadIDs(items); got != fmt.Sprint(want) {
				t.Fatalf("%s page %d = %s, want %v", tc.sort, page, got, want)
			}
			last := items[len(items)-1]
			cur = db.OwnUploadCursor{UploadedAt: last.UploadedAt, Size: last.Attachment.Size, ID: last.Attachment.ID}
		}
		if rest := f.list(t, db.OwnUploadQuery{Sort: tc.sort, Limit: 2, Cursor: cur}); len(rest) != 0 {
			t.Errorf("%s past the end = %s, want none", tc.sort, uploadIDs(rest))
		}
	}
}

func TestListOwnUploads_NameFilterIsLiteralAndCaseInsensitive(t *testing.T) {
	f := newUploadsFixture(t)
	f.file(t, "a1", f.alice, "Holiday_Photo.PNG", 1, "2026-01-01 10:00:00")
	f.file(t, "a2", f.alice, "holidayXPhoto.png", 1, "2026-01-02 10:00:00")
	f.file(t, "a3", f.alice, "100%.txt", 1, "2026-01-03 10:00:00")

	if got := uploadIDs(f.list(t, db.OwnUploadQuery{Name: "holiday_photo"})); got != "[a1]" {
		t.Errorf("underscore = %s, want [a1] (wildcards must be literal)", got)
	}
	if got := uploadIDs(f.list(t, db.OwnUploadQuery{Name: "%"})); got != "[a3]" {
		t.Errorf("percent = %s, want [a3]", got)
	}
	if got := uploadIDs(f.list(t, db.OwnUploadQuery{Name: "PNG"})); got != "[a2 a1]" {
		t.Errorf("PNG = %s, want [a2 a1]", got)
	}
	if got := uploadIDs(f.list(t, db.OwnUploadQuery{Name: "x' OR 1=1 --"})); got != "[]" {
		t.Errorf("injection = %s, want none", got)
	}
}

func TestListOwnUploads_States(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	for i, id := range []string{"live", "gone", "pending", "avatar", "banner", "icon"} {
		f.file(t, id, f.alice, id+".png", 5, fmt.Sprintf("2026-01-0%d 10:00:00", i+1))
	}
	liveMsg := f.link(t, "live", f.alice, false)
	goneMsg := f.link(t, "gone", f.alice, true)
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET avatar = '/api/v1/files/avatar' WHERE id = ?`, f.alice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE users SET banner_id = 'banner' WHERE id = ?`, f.alice); err != nil {
		t.Fatal(err)
	}
	if _, err := f.database.ExecContext(ctx, `UPDATE channels SET dm_icon = 'icon' WHERE id = ?`, f.ch); err != nil {
		t.Fatal(err)
	}

	type want struct {
		state   string
		msg     *int64
		channel *int64
		remove  bool
	}
	ch := f.ch
	wants := map[string]want{
		"live":    {db.UploadStateMessage, &liveMsg, &ch, true},
		"gone":    {db.UploadStateDeleted, &goneMsg, &ch, true},
		"pending": {db.UploadStatePending, nil, nil, true},
		"avatar":  {db.UploadStateAvatar, nil, nil, false},
		"banner":  {db.UploadStateBanner, nil, nil, false},
		"icon":    {db.UploadStateGroupIcon, nil, nil, false},
	}
	items := f.list(t, db.OwnUploadQuery{})
	if len(items) != len(wants) {
		t.Fatalf("got %d items, want %d", len(items), len(wants))
	}
	for _, it := range items {
		w := wants[it.Attachment.ID]
		if it.State != w.state || it.Removable != w.remove {
			t.Errorf("%s: state=%s removable=%v, want %s/%v", it.Attachment.ID, it.State, it.Removable, w.state, w.remove)
		}
		if fmt.Sprint(deref(it.MessageID)) != fmt.Sprint(deref(w.msg)) || fmt.Sprint(deref(it.ChannelID)) != fmt.Sprint(deref(w.channel)) {
			t.Errorf("%s: message=%v channel=%v, want %v %v", it.Attachment.ID, deref(it.MessageID), deref(it.ChannelID), deref(w.msg), deref(w.channel))
		}
		if it.Attachment.URL != "/api/v1/files/"+it.Attachment.ID || it.UploadedAt == "" {
			t.Errorf("%s: url=%q uploaded_at=%q", it.Attachment.ID, it.Attachment.URL, it.UploadedAt)
		}
	}
}

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestDeleteOwnAttachment(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	f.file(t, "mine", f.alice, "mine.txt", 7, "2026-01-01 10:00:00")
	msgID := f.link(t, "mine", f.alice, false)

	// Someone else's id finds nothing and leaves the row alone.
	if _, found, err := f.database.DeleteOwnAttachment(ctx, "mine", f.bob); err != nil || found {
		t.Fatalf("other user's delete = found %v err %v, want not found", found, err)
	}
	got, found, err := f.database.DeleteOwnAttachment(ctx, "mine", f.alice)
	if err != nil || !found {
		t.Fatalf("own delete = found %v err %v", found, err)
	}
	if got.StoredAs != "mine.bin" || got.Size != 7 || got.MessageID == nil || *got.MessageID != msgID {
		t.Errorf("removed = %+v, want stored mine.bin size 7 message %d", got, msgID)
	}
	if _, found, err := f.database.DeleteOwnAttachment(ctx, "mine", f.alice); err != nil || found {
		t.Errorf("second delete = found %v err %v, want not found", found, err)
	}
}

func TestDeleteOwnAttachment_RefusesInUseRows(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	for _, id := range []string{"avatar", "banner", "icon"} {
		f.file(t, id, f.alice, id+".png", 5, "2026-01-01 10:00:00")
	}
	for _, stmt := range []string{
		`UPDATE users SET avatar = '/api/v1/files/avatar' WHERE id = ` + fmt.Sprint(f.alice),
		`UPDATE users SET banner_id = 'banner' WHERE id = ` + fmt.Sprint(f.alice),
		`UPDATE channels SET dm_icon = 'icon' WHERE id = ` + fmt.Sprint(f.ch),
	} {
		if _, err := f.database.ExecContext(ctx, stmt); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"avatar", "banner", "icon"} {
		if _, found, err := f.database.DeleteOwnAttachment(ctx, id, f.alice); err != nil || found {
			t.Errorf("%s: found %v err %v, want refused", id, found, err)
		}
		inUse, exists, err := f.database.OwnAttachmentInUse(ctx, id, f.alice)
		if err != nil || !exists || !inUse {
			t.Errorf("%s: OwnAttachmentInUse = %v %v %v, want in use", id, inUse, exists, err)
		}
	}
	if _, exists, err := f.database.OwnAttachmentInUse(ctx, "avatar", f.bob); err != nil || exists {
		t.Errorf("other user's id: exists %v err %v, want not found", exists, err)
	}
}

func TestAttachmentStoredNameShared(t *testing.T) {
	f := newUploadsFixture(t)
	ctx := context.Background()
	f.file(t, "a1", f.alice, "a.txt", 1, "2026-01-01 10:00:00")
	if ok, err := f.database.AttachmentStoredNameInUse(ctx, "a1.bin"); err != nil || !ok {
		t.Errorf("present = %v %v, want true", ok, err)
	}
	if ok, err := f.database.AttachmentStoredNameInUse(ctx, "zzz.bin"); err != nil || ok {
		t.Errorf("absent = %v %v, want false", ok, err)
	}
}
