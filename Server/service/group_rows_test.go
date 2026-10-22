package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// groupRowFixture is a group DM of fixtureMember (the creator and owner),
// fixtureMember2 and fixtureMod, holding one group event row authored by
// fixtureMember. Only the server writes such a row, so the test inserts it
// directly. Every group row kind is read-only in the same way, so the cases
// below loop over all five.
func groupRowFixture(t *testing.T, kind int64) (f *moderationActionsFixture, dmID, rowID int64) {
	t.Helper()
	f = newModerationActionsFixture(t)
	ctx := context.Background()
	res, err := NewDMService(f.database, f.mod.perms).CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	dmID = res.Channel.ID
	r, err := f.database.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, 'group event', ?)`, dmID, fixtureMember, kind)
	if err != nil {
		t.Fatalf("insert group row: %v", err)
	}
	rowID, _ = r.LastInsertId()
	return f, dmID, rowID
}

var groupKinds = []int64{
	db.MessageKindGroupAdd, db.MessageKindGroupRemove, db.MessageKindGroupLeave,
	db.MessageKindGroupRename, db.MessageKindGroupIcon,
}

func assertGroupRowUnchanged(t *testing.T, f *moderationActionsFixture, msgID int64) {
	t.Helper()
	m, err := f.database.GetMessage(context.Background(), msgID)
	if err != nil || m == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if m.Deleted || m.Pinned || m.EditedAt != nil || m.Content != "group event" {
		t.Errorf("group row changed: %+v", m)
	}
	reactions, err := f.database.GetReactions(context.Background(), msgID)
	if err != nil || len(reactions) != 0 {
		t.Errorf("reactions = %v (%v), want none", reactions, err)
	}
}

func TestEditMessage_GroupRowForbidden(t *testing.T) {
	for _, kind := range groupKinds {
		f, _, msgID := groupRowFixture(t, kind)
		if _, err := f.messages.EditMessage(context.Background(), fixtureMember, msgID, "rewritten"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("kind %d: author edit = %v, want ErrForbidden", kind, err)
		}
		assertGroupRowUnchanged(t, f, msgID)
	}
}

func TestDeleteMessage_GroupRowForbidden(t *testing.T) {
	for _, kind := range groupKinds {
		f, _, msgID := groupRowFixture(t, kind)
		ctx := context.Background()
		for _, who := range []int64{fixtureMember, fixtureMod, fixtureOwner} {
			if _, err := f.messages.DeleteMessage(ctx, who, msgID); !errors.Is(err, ErrForbidden) {
				t.Errorf("kind %d: delete by %d = %v, want ErrForbidden", kind, who, err)
			}
		}
		if _, err := f.messages.DeleteMessageForReport(ctx, fixtureMod, msgID, 1, "r"); !errors.Is(err, ErrForbidden) {
			t.Errorf("kind %d: report-linked delete = %v, want ErrForbidden", kind, err)
		}
		assertGroupRowUnchanged(t, f, msgID)
	}
}

func TestReaction_GroupRowRefused(t *testing.T) {
	for _, kind := range groupKinds {
		f, _, msgID := groupRowFixture(t, kind)
		ctx := context.Background()
		if _, err := f.messages.AddReaction(ctx, fixtureMember2, msgID, "👍"); !errors.Is(err, ErrBadRequest) {
			t.Errorf("kind %d: add = %v, want ErrBadRequest", kind, err)
		}
		if _, err := f.messages.RemoveReaction(ctx, fixtureMember2, msgID, "👍"); !errors.Is(err, ErrBadRequest) {
			t.Errorf("kind %d: remove = %v, want ErrBadRequest", kind, err)
		}
		assertGroupRowUnchanged(t, f, msgID)
	}
}

func TestPin_GroupRowRefused(t *testing.T) {
	for _, kind := range groupKinds {
		f, dmID, msgID := groupRowFixture(t, kind)
		if _, err := f.messages.SetMessagePinned(context.Background(), fixtureMember, dmID, msgID, true); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("kind %d: pin = %v, want ErrBadRequest", kind, err)
		}
		assertGroupRowUnchanged(t, f, msgID)
	}
}

func TestSend_ReplyToGroupRowRefused(t *testing.T) {
	for _, kind := range groupKinds {
		f, dmID, msgID := groupRowFixture(t, kind)
		_, err := f.messages.SendMessage(context.Background(), SendMessageParams{
			ChannelID: dmID, UserID: fixtureMember2, Username: "u5", Content: "answering", ReplyTo: &msgID,
		})
		if !errors.Is(err, ErrBadRequest) {
			t.Fatalf("kind %d: reply = %v, want ErrBadRequest", kind, err)
		}
	}
}

// ─── Owner in the summary ───────────────────────────────────────────────────

func TestCreateGroupDM_CreatorOwnsAndSummaryCarriesOwner(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	svc := NewDMService(f.database, f.mod.perms)
	res, err := svc.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	for _, viewer := range []int64{fixtureMember, fixtureMember2, fixtureMod} {
		sum, err := svc.DMSummaryFor(ctx, viewer, res.Channel.ID)
		if err != nil {
			t.Fatalf("DMSummaryFor(%d): %v", viewer, err)
		}
		if sum.OwnerID != fixtureMember {
			t.Errorf("viewer %d: owner_id = %d, want %d", viewer, sum.OwnerID, fixtureMember)
		}
	}
	oneToOne, err := svc.CreateDM(ctx, fixtureMember, fixtureMember2)
	if err != nil {
		t.Fatalf("CreateDM: %v", err)
	}
	sum, err := svc.DMSummaryFor(ctx, fixtureMember, oneToOne.Channel.ID)
	if err != nil || sum.OwnerID != 0 {
		t.Errorf("1:1 summary owner = %d (%v), want 0", sum.OwnerID, err)
	}
}

func TestCloseDM_OwnerLeaveHandsOffAndSummaryFollows(t *testing.T) {
	f := newModerationActionsFixture(t)
	ctx := context.Background()
	svc := NewDMService(f.database, f.mod.perms)
	res, err := svc.CreateGroupDM(ctx, fixtureMember, []int64{fixtureMember2, fixtureMod}, "Crew")
	if err != nil {
		t.Fatalf("CreateGroupDM: %v", err)
	}
	if _, err := svc.CloseDM(ctx, fixtureMember, res.Channel.ID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}
	// fixtureMod (2) is the lowest remaining member id.
	sum, err := svc.DMSummaryFor(ctx, fixtureMember2, res.Channel.ID)
	if err != nil || sum.OwnerID != fixtureMod {
		t.Errorf("owner after hand-off = %d (%v), want %d", sum.OwnerID, err, fixtureMod)
	}
}
