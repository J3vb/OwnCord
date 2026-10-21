package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// reactionReadFixture seeds a service with a readable channel (10), an
// unreadable channel (11, read denied through a per-channel override) and a
// reader (user 2) alongside the author (user 1).
func reactionReadFixture(t *testing.T) (*MessageService, *db.DB, int64) {
	t.Helper()
	svc, database := newTestMessageService(t)
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 11, Name: "private", Type: "text"})
	seedChannelOverride(t, database, permissions.MemberRoleID, 11, 0, permissions.ReadMessages)
	msgID, err := database.CreateMessage(context.Background(), 11, 1, "hidden", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return svc, database, msgID
}

func reactionRows(t *testing.T, database *db.DB, msgID int64) int {
	t.Helper()
	counts, err := database.GetReactions(context.Background(), msgID)
	if err != nil {
		t.Fatalf("GetReactions: %v", err)
	}
	return len(counts)
}

func TestReaction_UnreadableChannelIsNotFoundAndWritesNothing(t *testing.T) {
	svc, database, msgID := reactionReadFixture(t)
	ctx := context.Background()

	if _, err := svc.AddReaction(ctx, 2, msgID, "👍"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("AddReaction = %v, want ErrNotFound", err)
	}
	if n := reactionRows(t, database, msgID); n != 0 {
		t.Fatalf("reaction rows after refused add = %d, want 0", n)
	}

	// A remove of an existing reaction by an unreadable-channel caller leaves it.
	if err := database.AddReaction(ctx, msgID, 2, "👍"); err != nil {
		t.Fatalf("seed AddReaction: %v", err)
	}
	if _, err := svc.RemoveReaction(ctx, 2, msgID, "👍"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("RemoveReaction = %v, want ErrNotFound", err)
	}
	if n := reactionRows(t, database, msgID); n != 1 {
		t.Fatalf("reaction rows after refused remove = %d, want 1", n)
	}
}

func TestReaction_UnacknowledgedAgeRestrictedChannelIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, int64(10)); err != nil {
		t.Fatalf("set nsfw: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, 10, 1, "labelled", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	if _, err := svc.AddReaction(ctx, 1, msgID, "👍"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("AddReaction before acknowledgement = %v, want ErrNotFound", err)
	}
	if n := reactionRows(t, database, msgID); n != 0 {
		t.Fatalf("reaction rows = %d, want 0", n)
	}

	if _, err := database.AcknowledgeNSFW(ctx, 1, 10); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}
	if _, err := svc.AddReaction(ctx, 1, msgID, "👍"); err != nil {
		t.Fatalf("AddReaction after acknowledgement: %v", err)
	}
	if _, err := svc.RemoveReaction(ctx, 1, msgID, "👍"); err != nil {
		t.Fatalf("RemoveReaction after acknowledgement: %v", err)
	}
}

func TestReaction_MissingDeletedAndUnreadableShareOneAnswer(t *testing.T) {
	svc, database, hiddenID := reactionReadFixture(t)
	ctx := context.Background()

	deletedID, err := database.CreateMessage(ctx, 10, 1, "gone", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.DeleteMessage(ctx, deletedID, 1, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	// A deleted message in a channel the caller cannot read answers the same too.
	hiddenDeletedID, err := database.CreateMessage(ctx, 11, 1, "gone hidden", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.DeleteMessage(ctx, hiddenDeletedID, 1, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	for _, add := range []bool{true, false} {
		texts := make([]string, 0, 4)
		for _, id := range []int64{999999, deletedID, hiddenID, hiddenDeletedID} {
			var err error
			if add {
				_, err = svc.AddReaction(ctx, 2, id, "👍")
			} else {
				_, err = svc.RemoveReaction(ctx, 2, id, "👍")
			}
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("add=%v id=%d: err = %v, want ErrNotFound", add, id, err)
			}
			texts = append(texts, err.Error())
		}
		for i := 1; i < len(texts); i++ {
			if texts[i] != texts[0] {
				t.Fatalf("add=%v: answers differ: %q vs %q", add, texts[0], texts[i])
			}
		}
	}
}

func TestReaction_DMNonParticipantIsNotFound(t *testing.T) {
	svc, database := newTestMessageService(t)
	ctx := context.Background()
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUser(t, database, &db.User{ID: 3, Username: "carol"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedUserRole(t, database, 3, permissions.MemberRoleID)

	ch, _, err := database.GetOrCreateDMChannel(ctx, 2, 3)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, ch.ID, 2, "psst", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	_, missingErr := svc.AddReaction(ctx, 1, 999999, "👍")
	if missingErr == nil {
		t.Fatal("missing id must be refused")
	}
	for _, add := range []bool{true, false} {
		var err error
		if add {
			_, err = svc.AddReaction(ctx, 1, msgID, "👍")
		} else {
			_, err = svc.RemoveReaction(ctx, 1, msgID, "👍")
		}
		if !errors.Is(err, ErrNotFound) || err.Error() != missingErr.Error() {
			t.Fatalf("add=%v: err = %v, want the missing-id answer %v", add, err, missingErr)
		}
	}
	if n := reactionRows(t, database, msgID); n != 0 {
		t.Fatalf("reaction rows = %d, want 0", n)
	}

	// A participant's happy path is unchanged.
	res, err := svc.AddReaction(ctx, 3, msgID, "👍")
	if err != nil || !res.IsDM || len(res.ParticipantIDs) == 0 {
		t.Fatalf("participant AddReaction = %+v, %v", res, err)
	}
}
