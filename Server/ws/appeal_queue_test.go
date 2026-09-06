package ws_test

// Package ws_test (external), mirroring moderation_queue_test.go: this
// exercises BroadcastAppealQueue over the real migration set, since
// migration 050's appeals table and CanModerate have to resolve the way
// production does.

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestBroadcastAppealQueue_ReachesConnectedModeratorsOnly is B5-10's twin of
// TestModerationAudience_OnlyBitHoldersOrAdmin: only connected
// MODERATE_MEMBERS/Administrator holders are ever in the audience, and an
// appeal queue frame reaches exactly them, carrying appeal_id (never
// report_id).
func TestBroadcastAppealQueue_ReachesConnectedModeratorsOnly(t *testing.T) {
	database := openReportTestDB(t)
	ctx := context.Background()
	modID, err := database.CreateUser(ctx, "aq-mod", "hash", 3) // Moderator: MODERATE_MEMBERS
	if err != nil {
		t.Fatalf("CreateUser(mod): %v", err)
	}
	memberID, err := database.CreateUser(ctx, "aq-member", "hash", 4) // Member: no bit
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	appellantID, err := database.CreateUser(ctx, "aq-appellant", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(appellant): %v", err)
	}
	actionID, err := database.WarnUser(ctx, appellantID, modID, nil, "x")
	if err != nil {
		t.Fatalf("WarnUser: %v", err)
	}
	appealID, err := database.InsertAppeal(ctx, "pub-appeal-aq", actionID, appellantID, "please")
	if err != nil {
		t.Fatalf("InsertAppeal: %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	defer hub.Stop()

	modSend := make(chan []byte, 4)
	memberSend := make(chan []byte, 4)
	modClient := ws.NewTestClient(hub, modID, modSend)
	memberClient := ws.NewTestClient(hub, memberID, memberSend)
	hub.Register(modClient)
	hub.Register(memberClient)
	waitRegistered(t, hub, modClient)
	waitRegistered(t, hub, memberClient)

	hub.BroadcastAppealQueue(ctx, appealID, "open")

	assertReceived(t, modSend, []byte(`{"type":"mod_queue","payload":{"appeal_id":"pub-appeal-aq","state":"open"}}`), "moderator")
	assertNotReceived(t, memberSend, "plain member")
}

// TestBroadcastAppealQueue_UnknownAppealIDIsANoOp: an appeal id that does
// not resolve (a race with erasure, or a stale id) sends nothing to anyone,
// rather than a frame with an empty public id.
func TestBroadcastAppealQueue_UnknownAppealIDIsANoOp(t *testing.T) {
	database := openReportTestDB(t)
	ctx := context.Background()
	modID, err := database.CreateUser(ctx, "aq-mod-2", "hash", 3)
	if err != nil {
		t.Fatalf("CreateUser(mod): %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	defer hub.Stop()

	modSend := make(chan []byte, 4)
	modClient := ws.NewTestClient(hub, modID, modSend)
	hub.Register(modClient)
	waitRegistered(t, hub, modClient)

	hub.BroadcastAppealQueue(ctx, 999999, "open")

	assertNotReceived(t, modSend, "moderator, for an unknown appeal id")
}

// waitRegistered/assertReceived/assertNotReceived/newTestHubDeps/openReportTestDB
// are declared in moderation_queue_test.go / hub_test.go / wait_helpers_test.go,
// same external package.
