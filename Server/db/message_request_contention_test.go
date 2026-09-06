package db

import (
	"context"
	"errors"
	"testing"
	"time"
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
// Codex review round 3: acknowledging goroutine start (closing ignoreAcked)
// is not enough either — that only proves the goroutine function was
// entered, not that its query ever reached the DB, so Accept could still
// finish first regardless. The writer pool's MaxOpenConns(1) makes real
// queueing directly observable: database.writer.Stats().WaitCount only
// increases once Ignore's TransitionMessageRequest call has actually
// reached the pool and blocked waiting for the sole connection Accept's
// open transaction currently holds. Poll for that increase — not just the
// goroutine's own claim to be about to run — before releasing Accept.
//
// The single writer connection then guarantees Accept commits first
// regardless of exactly when Ignore's write actually executes, so the
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

	waitCountBefore := database.writer.Stats().WaitCount
	var ignoreOK bool
	var ignoreErr error
	go func() {
		ignoreOK, ignoreErr = database.TransitionMessageRequest(ctx, req.ID, recipient, "ignored")
		done <- struct{}{}
	}()
	// Wait for real queueing: WaitCount only rises once Ignore's query has
	// actually reached the pool and is blocked on the single, currently-held
	// writer connection — not just once its goroutine has been scheduled.
	queued := false
	for range 1000 {
		if database.writer.Stats().WaitCount > waitCountBefore {
			queued = true
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !queued {
		t.Fatal("Ignore's competing write never queued behind Accept's open transaction — no forced overlap")
	}
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

// TestGetOrCreateDMChannelGated_UntrustedOpensCallerOnly and
// TestGetOrCreateDMChannelGated_TrustedOpensBoth exercise
// decideAndOpenRecipientDM's two success branches directly: the only other
// caller of GetOrCreateDMChannelGated is service/dm.go's CreateDM, whose own
// tests live in a different package and so contribute nothing to this
// package's own coverage.
func TestGetOrCreateDMChannelGated_UntrustedOpensCallerOnly(t *testing.T) {
	database := contentionOpenMigrated(t)
	ctx := context.Background()
	caller := contentionSeedUser(t, database, "gated-untrusted-caller")
	recipient := contentionSeedUser(t, database, "gated-untrusted-recipient")

	ch, created, recipientOpened, err := database.GetOrCreateDMChannelGated(ctx, caller, recipient)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannelGated: %v", err)
	}
	if !created || recipientOpened {
		t.Fatalf("created=%v recipientOpened=%v, want true, false (untrusted pair)", created, recipientOpened)
	}
	if n := openStateCount(t, database, caller, ch.ID); n != 1 {
		t.Errorf("caller's dm_open_state rows = %d, want 1", n)
	}
	if n := openStateCount(t, database, recipient, ch.ID); n != 0 {
		t.Errorf("recipient's dm_open_state rows = %d, want 0", n)
	}
}

func TestGetOrCreateDMChannelGated_TrustedOpensBoth(t *testing.T) {
	database := contentionOpenMigrated(t)
	ctx := context.Background()
	caller := contentionSeedUser(t, database, "gated-trusted-caller")
	recipient := contentionSeedUser(t, database, "gated-trusted-recipient")
	if err := database.TrustSender(ctx, recipient, caller, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}

	ch, created, recipientOpened, err := database.GetOrCreateDMChannelGated(ctx, caller, recipient)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannelGated: %v", err)
	}
	if !created || !recipientOpened {
		t.Fatalf("created=%v recipientOpened=%v, want true, true (trusted pair)", created, recipientOpened)
	}
	if n := openStateCount(t, database, caller, ch.ID); n != 1 {
		t.Errorf("caller's dm_open_state rows = %d, want 1", n)
	}
	if n := openStateCount(t, database, recipient, ch.ID); n != 1 {
		t.Errorf("recipient's dm_open_state rows = %d, want 1", n)
	}

	// Existing-channel branch of the same gated path: recipientOpened is
	// reported true unconditionally (untouched, matching GetOrCreateDMChannel's
	// own existing-channel branch), created is false.
	ch2, created2, recipientOpened2, err := database.GetOrCreateDMChannelGated(ctx, caller, recipient)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannelGated (existing): %v", err)
	}
	if created2 || !recipientOpened2 || ch2.ID != ch.ID {
		t.Errorf("second call = channel %d created=%v recipientOpened=%v, want channel %d, false, true", ch2.ID, created2, recipientOpened2, ch.ID)
	}
}

func openStateCount(t *testing.T, database *DB, userID, channelID int64) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM dm_open_state WHERE user_id = ? AND channel_id = ?`, userID, channelID).Scan(&n); err != nil {
		t.Fatalf("dm_open_state count: %v", err)
	}
	return n
}
