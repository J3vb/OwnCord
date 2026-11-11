package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// removalGapStore runs between right after a delete or purge write commits, in
// the gap before the service reverses the removed messages' mention badges.
type removalGapStore struct {
	messageRemovalStore
	between func()
}

func (s *removalGapStore) DeleteMessageWithRemoval(ctx context.Context, msgID, deleterID int64, isMod bool, authorID int64, reportID *int64, reason string) error {
	err := s.messageRemovalStore.DeleteMessageWithRemoval(ctx, msgID, deleterID, isMod, authorID, reportID, reason)
	if err == nil && s.between != nil {
		s.between()
	}
	return err
}

func (s *removalGapStore) PurgeChannelMessagesWithAction(ctx context.Context, channelID, before int64, limit int, actorID int64, reportID *int64) ([]int64, error) {
	ids, err := s.messageRemovalStore.PurgeChannelMessagesWithAction(ctx, channelID, before, limit, actorID, reportID)
	if err == nil && s.between != nil {
		s.between()
	}
	return ids, err
}

func (s *removalGapStore) PurgeUserChannelMessagesSince(ctx context.Context, channelID, userID int64, since string, limit int) ([]int64, error) {
	ids, err := s.messageRemovalStore.PurgeUserChannelMessagesSince(ctx, channelID, userID, since, limit)
	if err == nil && s.between != nil {
		s.between()
	}
	return ids, err
}

// readerInGap returns the hook that makes a reader's pointer move land in the gap.
// The move runs on its own goroutine and the hook gives it a short window to
// finish: it finishes inside the window when nothing orders it behind the removal,
// and queues on the channel's emit lock when the removal still holds it. wait
// joins the goroutine once the removal has returned.
func readerInGap(t *testing.T, svc *MessageService, userID, channelID int64, op db.ReadPointerOp, messageID int64) (between func(), wait func()) {
	t.Helper()
	done := make(chan struct{})
	between = func() {
		go func() {
			defer close(done)
			if _, err := svc.MoveReadPointer(context.Background(), userID, channelID, op, messageID); err != nil {
				t.Errorf("MoveReadPointer: %v", err)
			}
		}()
		select {
		case <-done:
		case <-time.After(150 * time.Millisecond):
		}
	}
	return between, func() { <-done }
}

func mentionBadge(t *testing.T, database *db.DB, userID, channelID int64) int64 {
	t.Helper()
	_, count, _, err := database.GetReadState(context.Background(), userID, channelID)
	mustDo(t, "GetReadState", err)
	return count
}

// gapFixture is the mention fixture with the removal store wrapped, plus a
// moderator who may purge. alice (1) authors, bob (2) reads.
func gapFixture(t *testing.T) (*MessageService, *removalGapStore, *db.DB) {
	t.Helper()
	svc, _, database := newMentionFixture(t)
	_, err := database.ExecContext(context.Background(),
		`UPDATE roles SET permissions = permissions | ? WHERE id = ?`, permissions.ManageMessages, permissions.ModeratorRoleID)
	mustDo(t, "grant manage", err)
	gap := &removalGapStore{messageRemovalStore: svc.messageRemoval.st}
	svc.messageRemoval.st = gap
	return svc, gap, database
}

// A reader's mark_unread that lands between a delete and its badge reversal must
// not make the reversal take the deleted mention's badge a second time.
func TestDeleteMessage_MarkUnreadInGapKeepsMentionBadge(t *testing.T) {
	svc, gap, database := gapFixture(t)
	ctx := context.Background()
	m1 := sendAs(t, svc, 1, "@bob one").MessageID
	m2 := sendAs(t, svc, 1, "@bob two").MessageID
	_, err := svc.MoveReadPointer(ctx, 2, 10, db.ReadAtLatest, 0)
	mustDo(t, "ReadAtLatest", err)

	between, wait := readerInGap(t, svc, 2, 10, db.MarkUnread, m1)
	gap.between = between
	if _, err := svc.DeleteMessage(ctx, 1, m2); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	wait()
	if got := mentionBadge(t, database, 2, 10); got != 1 {
		t.Fatalf("badge = %d, want 1 (the first message is live, unread and mentions bob)", got)
	}
}

func TestDeleteMessage_PartialReadInGapKeepsMentionBadge(t *testing.T) {
	svc, gap, database := gapFixture(t)
	plain := sendAs(t, svc, 1, "plain").MessageID
	sendAs(t, svc, 1, "@bob one")
	m2 := sendAs(t, svc, 1, "@bob two").MessageID

	between, wait := readerInGap(t, svc, 2, 10, db.ReadUpTo, plain)
	gap.between = between
	if _, err := svc.DeleteMessage(context.Background(), 1, m2); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	wait()
	if got := mentionBadge(t, database, 2, 10); got != 1 {
		t.Fatalf("badge = %d, want 1 (one live mention is still unread)", got)
	}
}

func TestPurgeMessages_MarkUnreadInGapKeepsMentionBadge(t *testing.T) {
	svc, gap, database := gapFixture(t)
	ctx := context.Background()
	m1 := sendAs(t, svc, 1, "@bob one").MessageID
	sendAs(t, svc, 1, "@bob two")
	_, err := svc.MoveReadPointer(ctx, 2, 10, db.ReadAtLatest, 0)
	mustDo(t, "ReadAtLatest", err)

	between, wait := readerInGap(t, svc, 2, 10, db.MarkUnread, m1)
	gap.between = between
	if res, err := svc.PurgeMessages(ctx, 4, 10, 1, 0); err != nil || len(res.MessageIDs) != 1 {
		t.Fatalf("PurgeMessages = %+v, %v", res, err)
	}
	wait()
	if got := mentionBadge(t, database, 2, 10); got != 1 {
		t.Fatalf("badge = %d, want 1", got)
	}
}

func TestPurgeAfterBan_MarkUnreadInGapKeepsMentionBadge(t *testing.T) {
	f := banPurgeFixture(t)
	banPurgeBan(t, f, fixtureMember2)
	ctx := context.Background()
	database := f.database
	gap := &removalGapStore{messageRemovalStore: f.messages.messageRemoval.st}
	f.messages.messageRemoval.st = gap

	mention := func(author int64) int64 {
		id := banPurgeMsg(t, database, fixtureChannel, author, time.Minute)
		_, err := database.ReplaceMessageMentions(ctx, id, []int64{fixtureMember}, false, nil)
		mustDo(t, "ReplaceMessageMentions", err)
		mustDo(t, "IncrementMentionCounts", database.IncrementMentionCounts(ctx, fixtureChannel, id, []int64{fixtureMember}))
		return id
	}
	m1 := mention(fixtureOwner)
	mention(fixtureMember2)
	_, err := f.messages.MoveReadPointer(ctx, fixtureMember, fixtureChannel, db.ReadAtLatest, 0)
	mustDo(t, "ReadAtLatest", err)

	between, wait := readerInGap(t, f.messages, fixtureMember, fixtureChannel, db.MarkUnread, m1)
	gap.between = between
	if res := f.mod.PurgeAfterBan(ctx, fixtureMod, fixtureMember2, time.Hour); res.Err != nil || res.Deleted != 1 {
		t.Fatalf("PurgeAfterBan = %+v", res)
	}
	wait()
	if got := mentionBadge(t, database, fixtureMember, fixtureChannel); got != 1 {
		t.Fatalf("badge = %d, want 1", got)
	}
}

// A delete waits for the channel's emit lock only until its context ends, and
// writes nothing when it gives up.
func TestDeleteMessage_LockWaitHonoursContextAndWritesNothing(t *testing.T) {
	svc, _, database := gapFixture(t)
	m1 := sendAs(t, svc, 1, "@bob one").MessageID

	locked, release, held := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(held)
		mu := svc.mentionEmitLocks.forChannel(10)
		mu.Lock()
		close(locked)
		<-release
		mu.Unlock()
	}()
	<-locked
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := svc.DeleteMessage(ctx, 1, m1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("DeleteMessage err = %v, want context.DeadlineExceeded", err)
	}
	close(release)
	<-held
	if deleted, _, err := database.IsMessageDeleted(context.Background(), m1); err != nil || deleted {
		t.Fatalf("message deleted = %v, err = %v; a delete that gave up must write nothing", deleted, err)
	}
}
