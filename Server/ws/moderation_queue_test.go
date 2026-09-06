package ws_test

// Package ws_test (external) because BroadcastModQueue is exported and this
// package's existing synchronisation helpers (waitRegistered,
// assertReceived, assertNotReceived — hub_test.go, wait_helpers_test.go)
// already cover everything this test needs: no reason to reach into
// moderationAudience directly, or to hand-roll a second poll loop.
//
// This uses the real migration set (db.Migrate), not the package's minimal
// hubTestSchema fixture (openTestDB) — migration 048's reports table and its
// Moderator-role grant have to exist for a report row and CanModerate to
// resolve the way production does.

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

func openReportTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// TestModerationAudience_OnlyBitHoldersOrAdmin pins the base property: only
// connected MODERATE_MEMBERS/Administrator holders are ever in the
// audience, and a mod_queue frame reaches exactly them.
func TestModerationAudience_OnlyBitHoldersOrAdmin(t *testing.T) {
	database := openReportTestDB(t)
	ctx := context.Background()
	ownerID, err := database.CreateUser(ctx, "mq-owner", "hash", 1) // Owner: Administrator
	if err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	modID, err := database.CreateUser(ctx, "mq-mod", "hash", 3) // Moderator: MODERATE_MEMBERS since migration 048
	if err != nil {
		t.Fatalf("CreateUser(mod): %v", err)
	}
	memberID, err := database.CreateUser(ctx, "mq-member", "hash", 4) // Member: no bit
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	// A report naming neither connected user: the audience should be
	// unfiltered by principal exclusion here, isolating the bit check.
	reporterID, err := database.CreateUser(ctx, "mq-reporter-offline", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(reporter): %v", err)
	}
	subjectID, err := database.CreateUser(ctx, "mq-subject-offline", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(subject): %v", err)
	}
	reportID, err := database.FileReport(ctx, "pub-base", reporterID, subjectID, "user", "1", nil, "spam", "", nil)
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	defer hub.Stop()

	ownerSend := make(chan []byte, 4)
	modSend := make(chan []byte, 4)
	memberSend := make(chan []byte, 4)
	ownerClient := ws.NewTestClient(hub, ownerID, ownerSend)
	modClient := ws.NewTestClient(hub, modID, modSend)
	memberClient := ws.NewTestClient(hub, memberID, memberSend)
	hub.Register(ownerClient)
	hub.Register(modClient)
	hub.Register(memberClient)
	waitRegistered(t, hub, ownerClient)
	waitRegistered(t, hub, modClient)
	waitRegistered(t, hub, memberClient)

	hub.BroadcastModQueue(ctx, reportID, "assigned")

	assertReceived(t, ownerSend, []byte(`{"type":"mod_queue","payload":{"report_id":"pub-base","state":"assigned"}}`), "owner")
	assertReceived(t, modSend, []byte(`{"type":"mod_queue","payload":{"report_id":"pub-base","state":"assigned"}}`), "moderator")
	assertNotReceived(t, memberSend, "plain member")
}

// TestModQueue_ExcludesSubjectAndReporterEvenIfTheyHoldTheBit is P1-1's
// regression test: filing (or acting on) a report about a bit holder, or
// filed by one, must not tell either of them — even though both would
// otherwise pass the CanModerate check the audience is built from. A third
// bit holder, named by neither role, must still receive the frame.
func TestModQueue_ExcludesSubjectAndReporterEvenIfTheyHoldTheBit(t *testing.T) {
	database := openReportTestDB(t)
	ctx := context.Background()
	// All three are Moderator-role (id 3): CanModerate is satisfied by all,
	// so only the principal exclusion can be responsible for who is left out.
	reporterID, err := database.CreateUser(ctx, "mq-reporter-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(reporter): %v", err)
	}
	subjectID, err := database.CreateUser(ctx, "mq-subject-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(subject): %v", err)
	}
	thirdModID, err := database.CreateUser(ctx, "mq-third-mod", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(third): %v", err)
	}
	reportID, err := database.FileReport(ctx, "pub-excl", reporterID, subjectID, "user", "1", nil, "spam", "", nil)
	if err != nil {
		t.Fatalf("FileReport: %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	defer hub.Stop()

	reporterSend := make(chan []byte, 4)
	subjectSend := make(chan []byte, 4)
	thirdSend := make(chan []byte, 4)
	reporterClient := ws.NewTestClient(hub, reporterID, reporterSend)
	subjectClient := ws.NewTestClient(hub, subjectID, subjectSend)
	thirdClient := ws.NewTestClient(hub, thirdModID, thirdSend)
	hub.Register(reporterClient)
	hub.Register(subjectClient)
	hub.Register(thirdClient)
	waitRegistered(t, hub, reporterClient)
	waitRegistered(t, hub, subjectClient)
	waitRegistered(t, hub, thirdClient)

	hub.BroadcastModQueue(ctx, reportID, "open")

	assertNotReceived(t, reporterSend, "the reporter (a bit holder)")
	assertNotReceived(t, subjectSend, "the subject (a bit holder)")
	assertReceived(t, thirdSend, []byte(`{"type":"mod_queue","payload":{"report_id":"pub-excl","state":"open"}}`), "an uninvolved moderator")
}
