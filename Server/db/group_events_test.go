package db_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// groupRowFixture is a three-member group DM (alice owns it) with a plain
// message from bob. Nothing in the server writes a group event row yet, so
// tests insert them with raw SQL.
type groupRowFixture struct {
	database          *db.DB
	alice, bob, carol int64
	group             int64
}

func newGroupRowFixture(t *testing.T) groupRowFixture {
	t.Helper()
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	carol := seedUser(t, database, "carol")
	ch, err := database.CreateGroupDMChannel(context.Background(), "Crew", alice, []int64{alice, bob, carol})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	return groupRowFixture{database: database, alice: alice, bob: bob, carol: carol, group: ch.ID}
}

// insertGroupRow writes one group event row the way the 3B-10b writers will:
// a messages row of the given kind plus its message_group_events row.
func (f groupRowFixture) insertGroupRow(t *testing.T, author, kind int64, content string, target *int64, name *string, iconRemoved int) int64 {
	t.Helper()
	ctx := context.Background()
	res, err := f.database.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, ?, ?)`, f.group, author, content, kind)
	if err != nil {
		t.Fatalf("insert group row: %v", err)
	}
	id, _ := res.LastInsertId()
	if _, err := f.database.ExecContext(ctx,
		`INSERT INTO message_group_events (message_id, target_user_id, name, icon_removed) VALUES (?, ?, ?, ?)`,
		id, target, name, iconRemoved); err != nil {
		t.Fatalf("insert group event: %v", err)
	}
	return id
}

func ownerOf(t *testing.T, database *db.DB, channelID int64) int64 {
	t.Helper()
	owner, _, err := database.GetGroupDMMeta(context.Background(), channelID)
	if err != nil {
		t.Fatalf("GetGroupDMMeta: %v", err)
	}
	return owner
}

// ─── Migration 065 backfill ─────────────────────────────────────────────────

// migrate064 returns a database at migration 064 with three users.
func migrate064(t *testing.T) (database *db.DB, a, b, c int64) {
	t.Helper()
	database = openMemory(t)
	if err := db.MigrateFS(database, migrationsBefore(t, "065")); err != nil {
		t.Fatalf("migrate to 064: %v", err)
	}
	return database, seedUser(t, database, "ua"), seedUser(t, database, "ub"), seedUser(t, database, "uc")
}

func rawGroup(t *testing.T, database *db.DB, isGroup int, members ...int64) int64 {
	t.Helper()
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO channels (name, type, is_group) VALUES ('', 'dm', ?)`, isGroup)
	if err != nil {
		t.Fatalf("insert channel: %v", err)
	}
	id, _ := res.LastInsertId()
	for _, m := range members {
		if _, err := database.ExecContext(context.Background(),
			`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, id, m); err != nil {
			t.Fatalf("insert participant: %v", err)
		}
	}
	return id
}

func rawMessage(t *testing.T, database *db.DB, ch, user int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'hi')`, ch, user); err != nil {
		t.Fatalf("insert message: %v", err)
	}
}

func TestMigration065_BackfillsOwnerFromOldestMemberMessage(t *testing.T) {
	database, a, b, c := migrate064(t)
	gone := seedUser(t, database, "left")
	ch := rawGroup(t, database, 1, a, b, c)
	// The oldest message is by someone no longer a member, so it is skipped.
	rawMessage(t, database, ch, gone)
	rawMessage(t, database, ch, c)
	rawMessage(t, database, ch, a)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate to head: %v", err)
	}
	if got := ownerOf(t, database, ch); got != c {
		t.Errorf("owner = %d, want %d (oldest surviving member message)", got, c)
	}
}

func TestMigration065_FallsBackToLowestMember(t *testing.T) {
	database, a, b, c := migrate064(t)
	ch := rawGroup(t, database, 1, c, b, a)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate to head: %v", err)
	}
	if got := ownerOf(t, database, ch); got != a {
		t.Errorf("owner = %d, want %d (lowest member id, no messages)", got, a)
	}
}

func TestMigration065_OneToOneHasNoOwner(t *testing.T) {
	database, a, b, _ := migrate064(t)
	ch := rawGroup(t, database, 0, a, b)
	rawMessage(t, database, ch, a)
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate to head: %v", err)
	}
	if got := count(t, database, `SELECT COUNT(*) FROM channels WHERE id = ? AND dm_owner_id IS NULL`, ch); got != 1 {
		t.Errorf("1:1 DM has an owner")
	}
	if got := ownerOf(t, database, ch); got != 0 {
		t.Errorf("GetGroupDMMeta on a 1:1 = %d, want 0", got)
	}
}

// ─── Owner at create, hand-off on leave ─────────────────────────────────────

func TestCreateGroupDMChannel_SetsOwner(t *testing.T) {
	f := newGroupRowFixture(t)
	if got := ownerOf(t, f.database, f.group); got != f.alice {
		t.Errorf("owner = %d, want creator %d", got, f.alice)
	}
	if _, err := f.database.CreateGroupDMChannel(context.Background(), "x", 999, []int64{f.alice, f.bob, f.carol}); err == nil {
		t.Error("CreateGroupDMChannel accepted an owner who is not a participant")
	}
}

func TestLeaveGroupDM_OwnerHandsOffToLowestRemaining(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	if _, err := f.database.LeaveGroupDM(ctx, f.alice, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.bob {
		t.Fatalf("owner after the owner left = %d, want %d (lowest remaining)", got, f.bob)
	}
	// Two members left, the owner leaves again: a group of one keeps an owner.
	res, err := f.database.LeaveGroupDM(ctx, f.bob, f.group, "left")
	if err != nil || res.Deleted {
		t.Fatalf("LeaveGroupDM = %+v, %v, want a survivor", res, err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.carol {
		t.Errorf("owner of the last member = %d, want %d", got, f.carol)
	}
}

func TestLeaveGroupDM_NonOwnerLeaveKeepsOwner(t *testing.T) {
	f := newGroupRowFixture(t)
	if _, err := f.database.LeaveGroupDM(context.Background(), f.carol, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.alice {
		t.Errorf("owner = %d, want %d unchanged", got, f.alice)
	}
}

// The owner statement also heals a NULL owner (a group whose owner column was
// cleared) on the next membership change.
func TestLeaveGroupDM_HealsNullOwner(t *testing.T) {
	f := newGroupRowFixture(t)
	if _, err := f.database.ExecContext(context.Background(), `UPDATE channels SET dm_owner_id = NULL WHERE id = ?`, f.group); err != nil {
		t.Fatalf("clear owner: %v", err)
	}
	if _, err := f.database.LeaveGroupDM(context.Background(), f.carol, f.group, "left"); err != nil {
		t.Fatalf("LeaveGroupDM: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.alice {
		t.Errorf("owner = %d, want %d", got, f.alice)
	}
}

func TestGetUserDMChannels_CarriesOwner(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	dm, _, err := f.database.GetOrCreateDMChannel(ctx, f.alice, f.bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	dms, err := f.database.GetUserDMChannels(ctx, f.bob)
	if err != nil {
		t.Fatalf("GetUserDMChannels: %v", err)
	}
	seen := 0
	for _, d := range dms {
		raw, _ := json.Marshal(d)
		var wire map[string]json.RawMessage
		_ = json.Unmarshal(raw, &wire)
		switch d.ChannelID {
		case f.group:
			seen++
			if d.OwnerID != f.alice || string(wire["owner_id"]) == "" {
				t.Errorf("group summary owner = %d (%s), want %d", d.OwnerID, wire["owner_id"], f.alice)
			}
		case dm.ID:
			seen++
			if _, present := wire["owner_id"]; present {
				t.Errorf("1:1 summary carries owner_id: %s", raw)
			}
		}
	}
	if seen != 2 {
		t.Errorf("saw %d of the 2 DMs", seen)
	}
}

// ─── History payload ────────────────────────────────────────────────────────

func TestMessagesForAPI_GroupRowCarriesKindAndGroupEvent(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	plain, err := f.database.CreateMessage(ctx, f.group, f.bob, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	name := "Raid night"
	empty := ""
	add := f.insertGroupRow(t, f.alice, db.MessageKindGroupAdd, "Alice added Carol to the group.", &f.carol, nil, 0)
	remove := f.insertGroupRow(t, f.alice, db.MessageKindGroupRemove, "Alice removed Carol from the group.", &f.carol, nil, 0)
	leave := f.insertGroupRow(t, f.bob, db.MessageKindGroupLeave, "Bob left the group.", nil, nil, 0)
	rename := f.insertGroupRow(t, f.alice, db.MessageKindGroupRename, "renamed", nil, &name, 0)
	cleared := f.insertGroupRow(t, f.alice, db.MessageKindGroupRename, "cleared", nil, &empty, 0)
	icon := f.insertGroupRow(t, f.alice, db.MessageKindGroupIcon, "icon", nil, nil, 1)
	iconSet := f.insertGroupRow(t, f.alice, db.MessageKindGroupIcon, "icon set", nil, nil, 0)

	msgs, err := f.database.GetMessagesForAPI(ctx, f.group, 0, 20, f.alice)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	wire := map[int64]string{}
	kinds := map[int64]string{}
	for _, m := range msgs {
		raw, _ := json.Marshal(m)
		var out struct {
			GroupEvent json.RawMessage `json:"group_event"`
		}
		_ = json.Unmarshal(raw, &out)
		wire[m.ID] = string(out.GroupEvent)
		kinds[m.ID] = m.Kind
	}
	want := map[int64][2]string{
		add:     {"group_add", `{"target_user_id":` + itoa(f.carol) + `}`},
		remove:  {"group_remove", `{"target_user_id":` + itoa(f.carol) + `}`},
		leave:   {"group_leave", `{}`},
		rename:  {"group_rename", `{"name":"Raid night"}`},
		cleared: {"group_rename", `{"name":""}`},
		icon:    {"group_icon", `{"icon_removed":true}`},
		iconSet: {"group_icon", `{"icon_removed":false}`},
		plain:   {"", ""},
	}
	if len(msgs) != len(want) {
		t.Fatalf("%d messages, want %d", len(msgs), len(want))
	}
	for id, w := range want {
		if kinds[id] != w[0] || wire[id] != w[1] {
			t.Errorf("message %d: kind %q group_event %q, want %q %q", id, kinds[id], wire[id], w[0], w[1])
		}
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// ─── Read-only ──────────────────────────────────────────────────────────────

func TestEditMessageContent_GroupRowNotFound(t *testing.T) {
	f := newGroupRowFixture(t)
	row := f.insertGroupRow(t, f.alice, db.MessageKindGroupLeave, "Alice left the group.", nil, nil, 0)
	if _, err := f.database.EditMessage(context.Background(), row, f.alice, "rewritten"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EditMessage on a group row: err = %v, want ErrNotFound", err)
	}
	m, _ := f.database.GetMessage(context.Background(), row)
	if m.Content != "Alice left the group." || m.EditedAt != nil || m.Kind != db.MessageKindGroupLeave {
		t.Errorf("group row after refused edit = %+v", m)
	}
}

func TestSoftDeleteMessage_GroupRowUntouched(t *testing.T) {
	f := newGroupRowFixture(t)
	row := f.insertGroupRow(t, f.alice, db.MessageKindGroupLeave, "Alice left the group.", nil, nil, 0)
	ctx := context.Background()
	if err := f.database.DeleteMessage(ctx, row, f.alice, false); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("author delete: err = %v, want ErrNotFound", err)
	}
	if err := f.database.DeleteMessage(ctx, row, f.bob, true); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("moderator delete: err = %v, want ErrNotFound", err)
	}
	if _, err := f.database.SetMessagePinned(ctx, db.SetPinnedParams{MessageID: row, Pinned: true, UserID: 1}); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("pin: err = %v, want ErrNotFound", err)
	}
	if got := count(t, f.database, `SELECT deleted + pinned FROM messages WHERE id = ?`, row); got != 0 {
		t.Errorf("group row was deleted or pinned")
	}
}

func TestSearch_ExcludesGroupRows(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	f.insertGroupRow(t, f.alice, db.MessageKindGroupLeave, "zebra left the group", nil, nil, 0)
	ordinary, err := f.database.CreateMessage(ctx, f.group, f.bob, "zebra message", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	got, err := f.database.SearchMessagesInChannels(ctx, "zebra", []int64{f.group}, db.SearchPage{Limit: 10})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(got) != 1 || got[0].MessageID != ordinary {
		t.Errorf("hits = %+v, want only message %d", got, ordinary)
	}
}

func TestGetReferencedMessages_GroupRowIsSystem(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	row := f.insertGroupRow(t, f.alice, db.MessageKindGroupLeave, "Alice left the group.", nil, nil, 0)
	plain, err := f.database.CreateMessage(ctx, f.group, f.bob, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	refs, err := f.database.GetReferencedMessages(ctx, f.group, []int64{row, plain})
	if err != nil {
		t.Fatalf("GetReferencedMessages: %v", err)
	}
	if refs[row] == nil || !refs[row].IsSystem {
		t.Errorf("group row ref = %+v, want IsSystem", refs[row])
	}
	if refs[plain] == nil || refs[plain].IsSystem {
		t.Errorf("ordinary ref = %+v, want not IsSystem", refs[plain])
	}
}

func TestMessageKindName(t *testing.T) {
	want := map[int64]string{
		db.MessageKindUser: "", db.MessageKindCall: "call", db.MessageKindGroupAdd: "group_add",
		db.MessageKindGroupRemove: "group_remove", db.MessageKindGroupLeave: "group_leave",
		db.MessageKindGroupRename: "group_rename", db.MessageKindGroupIcon: "group_icon", db.MessageKindPinAdd: "pin_add",
		db.MessageKindMemberJoin: "member_join", 99: "",
	}
	for kind, name := range want {
		if got := db.MessageKindName(kind); got != name {
			t.Errorf("MessageKindName(%d) = %q, want %q", kind, got, name)
		}
	}
}

// ─── Erasure ────────────────────────────────────────────────────────────────

func TestEraseAccount_RemovesRowsNamingSubjectAsTarget(t *testing.T) {
	f := newGroupRowFixture(t)
	ctx := context.Background()
	// alice adds carol and bob: erasing carol removes only the row naming her,
	// even though alice authored it. Rows naming bob stay.
	naming := f.insertGroupRow(t, f.alice, db.MessageKindGroupAdd, "Alice added Carol to the group.", &f.carol, nil, 0)
	other := f.insertGroupRow(t, f.alice, db.MessageKindGroupAdd, "Alice added Bob to the group.", &f.bob, nil, 0)
	authored := f.insertGroupRow(t, f.carol, db.MessageKindGroupLeave, "Carol left the group.", nil, nil, 0)

	if _, err := f.database.EraseAccount(ctx, f.carol, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	for _, id := range []int64{naming, authored} {
		if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE id = ?`, id); got != 0 {
			t.Errorf("row %d survived the erasure of the member it names or that authored it", id)
		}
		if got := count(t, f.database, `SELECT COUNT(*) FROM message_group_events WHERE message_id = ?`, id); got != 0 {
			t.Errorf("event detail %d survived", id)
		}
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE id = ?`, other); got != 1 {
		t.Errorf("the row naming another member was removed")
	}
}

func TestEraseAccount_HandsOffGroupOwnership(t *testing.T) {
	f := newGroupRowFixture(t)
	if _, err := f.database.EraseAccount(context.Background(), f.alice, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if got := ownerOf(t, f.database, f.group); got != f.bob {
		t.Errorf("owner after the owner was erased = %d, want %d (lowest remaining member)", got, f.bob)
	}
	members, err := f.database.GetDMParticipantIDs(context.Background(), f.group)
	if err != nil || !slices.Contains(members, ownerOf(t, f.database, f.group)) {
		t.Errorf("owner is not a current member: members %v (%v)", members, err)
	}
}
