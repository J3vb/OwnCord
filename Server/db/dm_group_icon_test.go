package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedIconAttachment records an unlinked image attachment uploaded by uploader.
func seedIconAttachment(t *testing.T, database *db.DB, id string, uploader int64) {
	t.Helper()
	if err := database.CreateAttachment(context.Background(), id, uploader, id+".png", "stored-"+id, "image/png", 10, nil, nil); err != nil {
		t.Fatalf("CreateAttachment %s: %v", id, err)
	}
}

func iconOf(t *testing.T, database *db.DB, channelID int64) string {
	t.Helper()
	_, icon, err := database.GetGroupDMMeta(context.Background(), channelID)
	if err != nil {
		t.Fatalf("GetGroupDMMeta: %v", err)
	}
	return icon
}

func TestSetGroupDMIcon_WritesIconAndOneRow(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-a", f.bob)

	change, err := f.database.SetGroupDMIcon(ctx, f.group, f.bob, new("icon-a"), "bob changed the group icon.")
	if err != nil {
		t.Fatalf("SetGroupDMIcon: %v", err)
	}
	if got := iconOf(t, f.database, f.group); got != "icon-a" {
		t.Errorf("dm_icon = %q, want icon-a", got)
	}
	if len(change.Rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(change.Rows))
	}
	r := change.Rows[0]
	if r.Kind != db.MessageKindGroupIcon || r.AuthorID != f.bob || r.IconRemoved || r.Content != "bob changed the group icon." {
		t.Errorf("row = %+v, want a group_icon by bob that set an icon", r)
	}
	if want := []int64{f.alice, f.bob, f.carol}; len(change.MemberIDs) != 3 || change.MemberIDs[0] != want[0] {
		t.Errorf("MemberIDs = %v, want %v", change.MemberIDs, want)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM message_group_events WHERE message_id = ? AND icon_removed = 0`, r.MessageID); got != 1 {
		t.Errorf("group event detail rows = %d, want 1 with icon_removed 0", got)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM read_states WHERE channel_id = ? AND user_id = ? AND last_message_id = ?`, f.group, f.bob, r.MessageID); got != 1 {
		t.Errorf("the actor's read state was not advanced")
	}
}

func TestSetGroupDMIcon_ClearWritesRowOnlyWhenIconSet(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()

	change, err := f.database.SetGroupDMIcon(ctx, f.group, f.alice, nil, "cleared")
	if err != nil {
		t.Fatalf("clear with no icon: %v", err)
	}
	if len(change.Rows) != 0 || count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind = 6`, f.group) != 0 {
		t.Fatalf("clearing a group with no icon wrote a row: %+v", change.Rows)
	}

	seedIconAttachment(t, f.database, "icon-a", f.alice)
	if _, err = f.database.SetGroupDMIcon(ctx, f.group, f.alice, new("icon-a"), "set"); err != nil {
		t.Fatalf("set: %v", err)
	}
	change, err = f.database.SetGroupDMIcon(ctx, f.group, f.carol, nil, "cleared")
	if err != nil {
		t.Fatalf("clear: %v", err)
	}
	if len(change.Rows) != 1 || !change.Rows[0].IconRemoved || iconOf(t, f.database, f.group) != "" {
		t.Errorf("clear = %+v, icon %q, want one icon_removed row and no icon", change.Rows, iconOf(t, f.database, f.group))
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM message_group_events WHERE message_id = ? AND icon_removed = 1`, change.Rows[0].MessageID); got != 1 {
		t.Errorf("clear row detail icon_removed not stored")
	}
}

func TestSetGroupDMIcon_NonMemberAndOneToOneAreNotFound(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dave := seedUser(t, f.database, "dave")
	seedIconAttachment(t, f.database, "icon-a", dave)

	if _, err := f.database.SetGroupDMIcon(ctx, f.group, dave, new("icon-a"), "x"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("non-member err = %v, want ErrNotFound", err)
	}
	dm, _, err := f.database.GetOrCreateDMChannel(ctx, f.alice, f.bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if _, err = f.database.SetGroupDMIcon(ctx, dm.ID, f.alice, new("icon-a"), "x"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("1:1 err = %v, want ErrNotFound", err)
	}
	if iconOf(t, f.database, f.group) != "" || count(t, f.database, `SELECT COUNT(*) FROM messages WHERE kind = 6`) != 0 {
		t.Errorf("a refused change wrote an icon or a row")
	}
}

func TestSetGroupDMIcon_RemovedUploaderWritesNothing(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-a", f.bob)
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.bob, "removed"); err != nil {
		t.Fatalf("RemoveGroupDMMember: %v", err)
	}
	rows := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, f.group)
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.bob, new("icon-a"), "x"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, f.group); got != rows || iconOf(t, f.database, f.group) != "" {
		t.Errorf("a refused icon change wrote rows (%d -> %d) or an icon", rows, got)
	}
}

func TestIsGroupDMIconForUser_MembersOfTheLiveIconOnly(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dave := seedUser(t, f.database, "dave")
	seedIconAttachment(t, f.database, "icon-a", f.alice)
	seedIconAttachment(t, f.database, "icon-b", f.alice)
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.alice, new("icon-a"), "x"); err != nil {
		t.Fatalf("set a: %v", err)
	}
	is := func(file string, user int64) bool {
		t.Helper()
		ok, err := f.database.IsGroupDMIconForUser(ctx, file, user)
		if err != nil {
			t.Fatalf("IsGroupDMIconForUser: %v", err)
		}
		return ok
	}
	if !is("icon-a", f.bob) {
		t.Errorf("a member must read the live icon")
	}
	if is("icon-a", dave) {
		t.Errorf("a non-member must not read the icon")
	}
	if is("icon-b", f.bob) {
		t.Errorf("an attachment that is not the icon must not be readable")
	}
	if _, err := f.database.RemoveGroupDMMember(ctx, f.group, f.alice, f.carol, "removed"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if is("icon-a", f.carol) {
		t.Errorf("a removed member must lose access")
	}
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.bob, new("icon-b"), "x"); err != nil {
		t.Fatalf("set b: %v", err)
	}
	if is("icon-a", f.bob) || !is("icon-b", f.bob) {
		t.Errorf("a replaced icon must stop being served and the new one must be")
	}
}

func TestGetUserDMChannels_CarriesIconURL(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-a", f.alice)
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.alice, new("icon-a"), "x"); err != nil {
		t.Fatalf("set: %v", err)
	}
	dms, err := f.database.GetUserDMChannels(ctx, f.bob)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	if len(dms) != 1 || dms[0].Icon != "/api/v1/files/icon-a" {
		t.Errorf("icon = %+v, want /api/v1/files/icon-a", dms)
	}
	if _, err = f.database.SetGroupDMIcon(ctx, f.group, f.alice, nil, "x"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if dms, _ = f.database.GetUserDMChannels(ctx, f.bob); dms[0].Icon != "" {
		t.Errorf("icon after clear = %q, want empty", dms[0].Icon)
	}
}

func TestOrphanSweep_KeepsLiveGroupIcon(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-old", f.alice)
	seedIconAttachment(t, f.database, "icon-live", f.bob)
	seedIconAttachment(t, f.database, "plain", f.bob)
	for _, id := range []string{"icon-old", "icon-live"} {
		if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.alice, new(id), "x"); err != nil {
			t.Fatalf("set %s: %v", id, err)
		}
	}
	swept, err := f.database.DeleteOrphanedAttachments(ctx, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	got := map[string]bool{}
	for _, s := range swept {
		got[s] = true
	}
	if got["stored-icon-live"] {
		t.Errorf("the sweep deleted the live icon")
	}
	if !got["stored-icon-old"] || !got["stored-plain"] {
		t.Errorf("the sweep kept a replaced icon or an orphan: swept %v", swept)
	}
}

func TestDiscardUnlinked_KeepsLiveGroupIcon(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-live", f.bob)
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.bob, new("icon-live"), "x"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, found, err := f.database.DiscardUnlinkedAttachment(ctx, "icon-live", f.bob); err != nil || found {
		t.Errorf("discard of the live icon = found %v, %v; want kept", found, err)
	}
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.bob, nil, "x"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, found, err := f.database.DiscardUnlinkedAttachment(ctx, "icon-live", f.bob); err != nil || !found {
		t.Errorf("discard of a cleared icon = found %v, %v; want discarded", found, err)
	}
}

func TestLinkAttachments_SkipsLiveGroupIcon(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-live", f.bob)
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.bob, new("icon-live"), "x"); err != nil {
		t.Fatalf("set: %v", err)
	}
	msgID, err := f.database.CreateMessage(ctx, f.group, f.bob, "carrier", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	linked, err := f.database.LinkAttachmentsToMessage(ctx, msgID, f.bob, []string{"icon-live"})
	if err != nil || len(linked) != 0 {
		t.Errorf("link = %v, %v; want the live icon skipped", linked, err)
	}
	if att, _ := f.database.GetAttachmentByID(ctx, "icon-live"); att == nil || att.MessageID != nil {
		t.Errorf("the live icon was linked to a message")
	}
}

func TestEraseAccount_ClearsIconUploadedBySubject(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	seedIconAttachment(t, f.database, "icon-bob", f.bob)
	if _, err := f.database.SetGroupDMIcon(ctx, f.group, f.alice, new("icon-bob"), "x"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, err := f.database.EraseAccount(ctx, f.bob, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if got := iconOf(t, f.database, f.group); got != "" {
		t.Errorf("icon after the uploader was erased = %q, want none", got)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM attachments WHERE id = 'icon-bob'`); got != 0 {
		t.Errorf("the erased user's icon attachment survived")
	}
	dms, err := f.database.GetUserDMChannels(ctx, f.alice)
	if err != nil || len(dms) != 1 || dms[0].Icon != "" {
		t.Errorf("summary after erasure = %+v, %v; want no icon", dms, err)
	}
}
