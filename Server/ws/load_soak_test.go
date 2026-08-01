package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"go.uber.org/goleak"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/service"
	"github.com/owncord/server/ws"
)

// TestTheLoadTest is a load/soak test for the hub's concurrency machinery: it
// churns a few hundred WS clients through Register/Unregister from many
// goroutines while other goroutines drive broadcasts (chat_message via the
// real chat_send handler path, voice_state, presence, and raw channel-scoped
// fan-out) and channel focus changes, all against one live hub.
//
// It exercises two paths that are easy to get right in isolation but wrong
// under contention:
//   - channelReadAudience, the per-broadcast permission-audience resolution
//     used by voice_state/voice_leave and channel_create/update fan-out;
//   - MessageService's background mention-count bookkeeping, which the
//     production code fires with a bare `go fn()` per send (see
//     RunBackgroundInlineForTest's doc comment on MessageService.bg).
//
// Skipped under -short. Run explicitly with:
//
//	go test ./ws/ -race -run TheLoadTest -count=1
func TestTheLoadTest(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping load/soak test in -short mode")
	}

	// Baseline before anything is started, so this test only fails on
	// goroutines IT leaked — not on background goroutines belonging to
	// earlier tests in the same binary that happen to still be unwinding.
	defer goleak.VerifyNone(t, goleak.IgnoreCurrent())

	const (
		numChannels     = 4
		numAnchors      = 8   // steady readers, registered for the whole run
		numChurnUsers   = 200 // distinct users churned through register/unregister
		numChurnWorkers = 20
		churnRounds     = 4
		numBroadcasters = 6
		broadcastIters  = 30
		overallTimeout  = 90 * time.Second
	)

	// Deliberately not the shared openServeTestDB(t) helper: it closes the DB
	// via t.Cleanup, which fires AFTER this function's own defers (including
	// the goleak check above) — leaving database/sql's connectionOpener
	// goroutine looking "leaked" at check time even though it would close
	// fine a moment later. Closing it with an ordinary defer, positioned
	// after the goleak defer so it runs first (defers are LIFO), keeps the
	// check honest.
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer func() { _ = database.Close() }()
	migrFS := fstest.MapFS{"001_schema.sql": {Data: serveTestSchema}}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}

	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := ws.NewHub(database, limiter, svc)

	runDone := make(chan struct{})
	go func() {
		hub.Run()
		close(runDone)
	}()
	waitFor(t, waitTimeout, hub.RunningForTest, "hub Run loop to start")
	// Registered after database's defer above, so it runs first (LIFO): the
	// hub — and every background goroutine it owns — is fully stopped before
	// the DB closes under it.
	defer func() {
		hub.Stop()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("hub.Run() did not stop after hub.Stop()")
		}
	}()

	ctx := context.Background()

	// ── shared channels every client fans in and out of ────────────────────
	chIDs := make([]int64, numChannels)
	for i := range chIDs {
		chIDs[i] = seedTestChannel(t, database, fmt.Sprintf("load-ch-%d", i))
	}

	// ── anchors: registered once, stay up for the whole run, and are the
	// steady audience broadcasts land on plus the @mention targets that
	// exercise applyMentionCounts. ───────────────────────────────────────────
	type anchor struct {
		user      *db.User
		c         *ws.Client
		send      chan []byte
		stopDrain chan struct{}
	}
	anchors := make([]anchor, 0, numAnchors)
	for i := range numAnchors {
		u := seedOwnerUser(t, database, fmt.Sprintf("load-anchor-%d", i))
		send := make(chan []byte, 1024)
		c := ws.NewTestClientWithUser(hub, u, chIDs[i%numChannels], send)
		hub.Register(c)

		// Drain continuously so a busy channel never trips the client's
		// full-buffer auto-disconnect (BUG-124 behavior) — that disconnect is
		// correct production behavior but not what this test means to probe.
		stop := make(chan struct{})
		go func(ch chan []byte, stop chan struct{}) {
			for {
				select {
				case <-ch:
				case <-stop:
					return
				}
			}
		}(send, stop)

		anchors = append(anchors, anchor{user: u, c: c, send: send, stopDrain: stop})
	}
	for _, a := range anchors {
		waitRegistered(t, hub, a.c)
	}
	mentionNames := make([]string, len(anchors))
	for i, a := range anchors {
		mentionNames[i] = a.user.Username
	}

	// ── churn pool: pre-seeded so DB writes stay off the timed section; the
	// timed section only churns hub Register/Unregister + message dispatch. ──
	churnUsers := make([]*db.User, numChurnUsers)
	for i := range numChurnUsers {
		uid := seedTestUser(t, database, fmt.Sprintf("load-churn-%d", i))
		u, err := database.GetUserByID(ctx, uid)
		if err != nil || u == nil {
			t.Fatalf("GetUserByID(%d): %v", uid, err)
		}
		churnUsers[i] = u
	}

	var wg sync.WaitGroup
	usersPerWorker := numChurnUsers / numChurnWorkers

	// ── churn goroutines: concurrent register -> channel_focus -> chat_send
	// (mentioning an anchor) -> presence_update -> unregister, repeated for
	// churnRounds per assigned user. ────────────────────────────────────────
	for w := range numChurnWorkers {
		wg.Add(1)
		go func(workerIdx int) {
			defer wg.Done()
			start := workerIdx * usersPerWorker
			end := start + usersPerWorker
			for round := range churnRounds {
				for ui := start; ui < end; ui++ {
					user := churnUsers[ui]
					chID := chIDs[(ui+round)%numChannels]
					focusChID := chIDs[(ui+round+1)%numChannels]

					send := make(chan []byte, 32)
					c := ws.NewTestClientWithUser(hub, user, chID, send)
					hub.Register(c)

					focusPayload, _ := json.Marshal(map[string]any{
						"type":    "channel_focus",
						"payload": map[string]any{"channel_id": focusChID},
					})
					hub.HandleMessageForTest(c, focusPayload)

					target := mentionNames[(ui+round)%len(mentionNames)]
					content := fmt.Sprintf("hi @%s from churn user %d round %d", target, user.ID, round)
					chatPayload, _ := json.Marshal(map[string]any{
						"type": "chat_send",
						"id":   fmt.Sprintf("req-%d-%d", user.ID, round),
						"payload": map[string]any{
							"channel_id": chID,
							"content":    content,
						},
					})
					hub.HandleMessageForTest(c, chatPayload)

					status := []string{"online", "idle", "dnd"}[round%3]
					presPayload, _ := json.Marshal(map[string]any{
						"type":    "presence_update",
						"payload": map[string]any{"status": status},
					})
					hub.HandleMessageForTest(c, presPayload)

					hub.Unregister(c)
				}
			}
		}(w)
	}

	// ── broadcaster goroutines: hammer the real broadcast paths (channel-
	// scoped fan-out, voice_state/channelReadAudience, presence, and
	// channel_update/channelReadAudience) concurrently with the churn above. ─
	for b := range numBroadcasters {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			for i := range broadcastIters {
				chID := chIDs[(idx+i)%numChannels]
				switch i % 4 {
				case 0:
					msg := fmt.Appendf(nil, `{"type":"chat_message","payload":{"synthetic":%d}}`, i)
					hub.BroadcastToChannel(chID, msg)
				case 1:
					msg := fmt.Appendf(nil, `{"type":"voice_state","payload":{"channel_id":%d,"user_id":%d}}`, chID, idx)
					hub.BroadcastVoiceEventForTest(chID, msg)
				case 2:
					anchorUser := anchors[idx%len(anchors)].user
					status := []string{"online", "idle", "dnd", "invisible"}[i%4]
					hub.BroadcastPresence(anchorUser.ID, status, nil)
				case 3:
					// BroadcastChannelUpdate is called by the admin HubBroadcaster
					// interface, which carries no context (see hub_broadcast.go);
					// context.Background() matches that production call shape,
					// not the request-scoped ctx used elsewhere in this test.
					ch, err := database.GetChannel(context.Background(), chID)
					if err == nil && ch != nil {
						hub.BroadcastChannelUpdate(ch) // exercises channelReadAudience
					}
				}
			}
		}(b)
	}

	// Fail loudly instead of hanging if anything above ever deadlocks: every
	// send in the production path is non-blocking (select+default), so the
	// only way this fires is a genuine bug (e.g. the hub loop stuck, or a
	// lock held across a blocking call).
	allDone := make(chan struct{})
	go func() {
		wg.Wait()
		close(allDone)
	}()
	select {
	case <-allDone:
	case <-time.After(overallTimeout):
		t.Fatal("load test workers did not finish within timeout — possible deadlock in the hub")
	}

	if !hub.RunningForTest() {
		t.Error("hub stopped running mid-test (panic-loop guard tripped?)")
	}

	// Only the anchors should remain registered — every churned client
	// unregistered itself at the end of its own round.
	waitFor(t, 5*time.Second, func() bool { return hub.ClientCount() == numAnchors },
		"churned clients to fully unregister")
	if got := hub.ClientCount(); got != numAnchors {
		t.Errorf("ClientCount = %d after churn settled, want %d (anchors only)", got, numAnchors)
	}

	t.Logf("load test done: %d anchors, %d churn users x %d rounds, %d broadcasters x %d iters, broadcast drops=%d",
		numAnchors, numChurnUsers, churnRounds, numBroadcasters, broadcastIters, hub.BroadcastDropCount())

	for _, a := range anchors {
		hub.Unregister(a.c)
	}
	waitFor(t, 5*time.Second, func() bool { return hub.ClientCount() == 0 }, "anchors to unregister")
	for _, a := range anchors {
		close(a.stopDrain)
	}

	// SendMessage fires mention-count bookkeeping with a bare `go fn()` and
	// deliberately does not wait for it (see MessageService.bg) — that is the
	// exact background path this test means to exercise. Give the last few
	// in-flight goroutines a moment to finish their handful of DB queries
	// before the deferred teardown stops the hub and closes the DB out from
	// under them; without this they still exit cleanly (goleak retries with
	// backoff), but they'd do it via a "database is closed" error instead of
	// completing the work, which is a false alarm this bounded wait avoids.
	time.Sleep(300 * time.Millisecond)

	// hub.Stop()/runDone wait and the DB close happen in the deferred cleanup
	// above (LIFO: hub first, then DB, then the goleak check registered at
	// the top of this test).
}
