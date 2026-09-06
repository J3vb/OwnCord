package db

import (
	"context"
	"errors"
	"testing"
)

// This file is package db (not db_test): its tests need acceptGuardHook and
// afterDMParticipantsInsertHook, unexported test seams with no exported
// setter (Codex review round 2, P1/P2-8) — reachable only from a test in
// this same package, which is why they live here rather than in service
// (where TestAcceptMessageRequest_ConcurrentDecisionsOneWins ran before,
// against the now-deleted SetAcceptMessageRequestGuardHookForTest) or in
// message_request_queries_test.go (package db_test).

func contentionOpenMigrated(t *testing.T) *DB {
	t.Helper()
	database, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return database
}

func contentionSeedUser(t *testing.T, database *DB, username string) int64 {
	t.Helper()
	id, err := database.CreateUser(context.Background(), username, "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(%q): %v", username, err)
	}
	return id
}

// TestAcceptMessageRequest_ConcurrentDecisionsOneWins: Accept and Ignore
// decide the same pending row at once. Codex P2-8 round 2: launching Ignore
// and releasing Accept immediately affords no guarantee the two ever
// actually overlap — nothing stops Accept's transaction from committing
// (via acceptGuardHook's release) before Ignore's goroutine is even
// scheduled, which would make this pass without ever exercising a race.
// ignoreAcked is the missing acknowledgment: the test does not release
// Accept until Ignore's own goroutine confirms it is about to issue its
// competing write, so Accept's transaction is provably still open at that
// moment. The single writer connection then guarantees Accept commits
// first regardless of exactly when Ignore's write actually executes, so the
// outcome (Accept wins, Ignore loses) is deterministic — assert the exact
// final state, trust row and OpenDM effect.
func TestAcceptMessageRequest_ConcurrentDecisionsOneWins(t *testing.T) {
	database := contentionOpenMigrated(t)
	ctx := context.Background()

	sender := contentionSeedUser(t, database, "mrq-race-sender")
	recipient := contentionSeedUser(t, database, "mrq-race-recipient")
	ch, _, err := database.GetOrCreateDMChannel(ctx, sender, recipient)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, ch.ID, sender, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.CreateMessageRequest(ctx, sender, recipient, ch.ID, msgID); err != nil {
		t.Fatalf("CreateMessageRequest: %v", err)
	}
	req, err := database.GetMessageRequestByPair(ctx, sender, recipient)
	if err != nil {
		t.Fatalf("GetMessageRequestByPair: %v", err)
	}

	guardReached := make(chan struct{})
	release := make(chan struct{})
	database.acceptGuardHook = func() {
		close(guardReached)
		<-release
	}
	defer func() { database.acceptGuardHook = nil }()

	done := make(chan struct{}, 2)
	var acceptErr error
	go func() {
		_, acceptErr = database.AcceptMessageRequest(ctx, req.ID, recipient)
		done <- struct{}{}
	}()
	<-guardReached // Accept confirmed pending and now holds the sole writer connection, transaction still open

	ignoreAcked := make(chan struct{})
	var ignoreOK bool
	var ignoreErr error
	go func() {
		close(ignoreAcked) // acknowledged: about to issue the competing write
		ignoreOK, ignoreErr = database.TransitionMessageRequest(ctx, req.ID, recipient, "ignored")
		done <- struct{}{}
	}()
	<-ignoreAcked  // do not release Accept until Ignore has committed to racing it
	close(release) // let Accept finish; Ignore's write cannot execute until it does
	<-done
	<-done

	if acceptErr != nil {
		t.Fatalf("Accept = %v, want nil (forced to win)", acceptErr)
	}
	if ignoreErr != nil || ignoreOK {
		t.Fatalf("Ignore (forced loser) = %v, %v; want false, nil", ignoreOK, ignoreErr)
	}

	final, err := database.GetMessageRequest(ctx, req.ID, recipient)
	if err != nil {
		t.Fatalf("GetMessageRequest: %v", err)
	}
	if final.State != "accepted" {
		t.Errorf("state = %q, want accepted", final.State)
	}
	var trustCount int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = ? AND sender_id = ? AND source = 'accepted'`,
		recipient, sender).Scan(&trustCount); err != nil || trustCount != 1 {
		t.Errorf("accepted-source trusted_senders rows = %d, %v; want 1, nil", trustCount, err)
	}
	var openCount int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dm_open_state WHERE user_id = ? AND channel_id = ?`,
		recipient, ch.ID).Scan(&openCount); err != nil || openCount != 1 {
		t.Errorf("dm_open_state rows for the recipient = %d, %v; want 1, nil (opened on accept)", openCount, err)
	}
}

// TestGetOrCreateDMChannelGated_FailureAfterParticipantsLeavesRecipientNeverOpened
// is Codex review round 2, P1: the old shape committed the channel with both
// sides open, THEN called CloseDM in a separate step — so a cancellation or
// a CloseDM failure between those two calls left the recipient open.
// afterDMParticipantsInsertHook fires in the exact window that used to be
// the gap between "create" and "cleanup" (after participants are inserted,
// before the recipient's visibility is decided and written); forcing it to
// fail here must roll back the WHOLE transaction, so the recipient never has
// an open-state row at all, rather than a permanently-open one.
func TestGetOrCreateDMChannelGated_FailureAfterParticipantsLeavesRecipientNeverOpened(t *testing.T) {
	database := contentionOpenMigrated(t)
	ctx := context.Background()
	caller := contentionSeedUser(t, database, "gated-fail-caller")
	recipient := contentionSeedUser(t, database, "gated-fail-recipient")

	injected := errors.New("simulated failure/cancellation between create and the old cleanup point")
	database.afterDMParticipantsInsertHook = func() error { return injected }
	defer func() { database.afterDMParticipantsInsertHook = nil }()

	if _, _, _, err := database.GetOrCreateDMChannelGated(ctx, caller, recipient); !errors.Is(err, injected) {
		t.Fatalf("GetOrCreateDMChannelGated = %v, want the injected failure", err)
	}

	var openCount int
	if err := database.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dm_open_state WHERE user_id = ?`, recipient).Scan(&openCount); err != nil || openCount != 0 {
		t.Errorf("dm_open_state rows for the recipient = %d, %v; want 0 (the recipient never had one, not a leaked open one)", openCount, err)
	}
	var channelCount int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels`).Scan(&channelCount); err != nil || channelCount != 0 {
		t.Errorf("channels rows = %d, %v; want 0 (the whole transaction rolled back, not just the open-state write)", channelCount, err)
	}
}
