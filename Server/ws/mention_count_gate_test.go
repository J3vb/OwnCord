package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// mentionGateRoleID is a non-seeded role holding exactly READ|SEND, so a user
// on it is a normal (non-admin) reader whose channel access can be revoked.
const mentionGateRoleID = int64(210)

// newMentionGateFixture builds a full-migration database, a text channel and a
// hub whose mention notifier is the hub itself (NewHub installs it) with the
// inline mention fallback running synchronously.
func newMentionGateFixture(t testing.TB) (*Hub, *db.DB, *service.Services, int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'mention-gate', NULL, ?, 5, 0)`,
		mentionGateRoleID, permissions.ReadMessages|permissions.SendMessages,
	); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	chID, err := database.CreateChannel(context.Background(), "mention-gate-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHub(t, database, limiter, svc)
	hub.RunMentionCountsInlineForTest()
	return hub, database, svc, chID
}

func seedMentionGateUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	if _, err := database.CreateUser(context.Background(), username, "hash", int(mentionGateRoleID)); err != nil {
		t.Fatalf("CreateUser(%s): %v", username, err)
	}
	u, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%s): %v", username, err)
	}
	return u
}

// mentionCountFrames drains ch for d and returns the count carried by every
// mention_count frame it received.
func mentionCountFrames(ch chan []byte, d time.Duration) []int64 {
	var counts []int64
	for _, m := range drainChan(ch, d) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Count int64 `json:"count"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "mention_count" {
			counts = append(counts, env.Payload.Count)
		}
	}
	return counts
}

// TestNotifyMentionCount_SkipsReaderWhoLostChannelAccess reproduces the
// deletion-badge leak: a reader mentioned while they could read the channel,
// who then loses READ_MESSAGES, must not receive the lowered mention_count
// frame when the mentioning message is deleted. The delivered count is still
// corrected in storage for them, and a reader who can still read gets the
// frame — so the frame only follows current channel visibility (or DM
// membership), not historical recipient status.
func TestNotifyMentionCount_SkipsReaderWhoLostChannelAccess(t *testing.T) {
	hub, database, svc, chID := newMentionGateFixture(t)
	ctx := context.Background()
	author := seedMentionGateUser(t, database, "gate-author")
	bob := seedMentionGateUser(t, database, "gate-bob")
	carol := seedMentionGateUser(t, database, "gate-carol")

	bobSend := make(chan []byte, 16)
	carolSend := make(chan []byte, 16)
	hub.clients[author.ID] = []*Client{NewTestClient(hub, author.ID, make(chan []byte, 16))}
	hub.clients[bob.ID] = []*Client{NewTestClient(hub, bob.ID, bobSend)}
	hub.clients[carol.ID] = []*Client{NewTestClient(hub, carol.ID, carolSend)}

	res, err := svc.Messages.SendMessage(ctx, service.SendMessageParams{
		ChannelID: chID, UserID: author.ID, Username: "gate-author", RoleName: "member",
		Content: "@gate-bob @gate-carol hello",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if counts := mentionCountFrames(bobSend, 100*time.Millisecond); len(counts) != 1 || counts[0] != 1 {
		t.Fatalf("bob increment frames = %v, want one count 1", counts)
	}
	if counts := mentionCountFrames(carolSend, 100*time.Millisecond); len(counts) != 1 || counts[0] != 1 {
		t.Fatalf("carol increment frames = %v, want one count 1", counts)
	}

	// Revoke bob's READ_MESSAGES on this channel, exactly as an admin override
	// edit does: DB write, then invalidate the permission cache.
	if err := database.UpsertChannelUserOverride(ctx, chID, bob.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	svc.Permissions.InvalidateAll()

	if _, err := svc.Messages.DeleteMessage(ctx, author.ID, res.MessageID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// The stored count is corrected for bob regardless of visibility...
	if n, _ := database.GetMentionCount(ctx, bob.ID, chID); n != 0 {
		t.Errorf("bob stored mention_count = %d after delete, want 0", n)
	}
	// ...but bob must not receive the lowered frame.
	if counts := mentionCountFrames(bobSend, 100*time.Millisecond); len(counts) != 0 {
		t.Errorf("revoked user received mention_count frames %v, want none", counts)
	}
	// Carol still sees the channel and gets the lowered total.
	if counts := mentionCountFrames(carolSend, 100*time.Millisecond); len(counts) != 1 || counts[0] != 0 {
		t.Errorf("visible reader frames = %v, want one count 0", counts)
	}
}

// PrepareMentionCounts resolves the audience once, before the emit lock; a
// reader who connects between the preparation and the send is checked at send
// time, so a visible reader still gets the frame and a reader without access
// still does not.
func TestPrepareMentionCounts_ChecksAReaderWhoConnectsAfterPreparing(t *testing.T) {
	hub, database, svc, chID := newMentionGateFixture(t)
	ctx := context.Background()
	bob := seedMentionGateUser(t, database, "prep-bob")
	dave := seedMentionGateUser(t, database, "prep-dave")
	erin := seedMentionGateUser(t, database, "prep-erin")
	if err := database.UpsertChannelUserOverride(ctx, chID, dave.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	svc.Permissions.InvalidateAll()

	erinSend := make(chan []byte, 16)
	hub.clients[erin.ID] = []*Client{NewTestClient(hub, erin.ID, erinSend)}
	send := hub.PrepareMentionCounts(ctx, chID, []int64{bob.ID, dave.ID, erin.ID})

	bobSend := make(chan []byte, 16)
	daveSend := make(chan []byte, 16)
	hub.clients[bob.ID] = []*Client{NewTestClient(hub, bob.ID, bobSend)}
	hub.clients[dave.ID] = []*Client{NewTestClient(hub, dave.ID, daveSend)}
	send(bob.ID, 1)
	send(dave.ID, 1)
	send(erin.ID, 2)

	if counts := mentionCountFrames(bobSend, 100*time.Millisecond); len(counts) != 1 || counts[0] != 1 {
		t.Errorf("late visible reader frames = %v, want one count 1", counts)
	}
	if counts := mentionCountFrames(daveSend, 100*time.Millisecond); len(counts) != 0 {
		t.Errorf("late reader without access got frames %v, want none", counts)
	}
	if counts := mentionCountFrames(erinSend, 100*time.Millisecond); len(counts) != 1 || counts[0] != 2 {
		t.Errorf("prepared reader frames = %v, want one count 2", counts)
	}
}

// A channel that cannot be read sends nothing (fails closed).
func TestPrepareMentionCounts_MissingChannelSendsNothing(t *testing.T) {
	hub, database, _, _ := newMentionGateFixture(t)
	bob := seedMentionGateUser(t, database, "prep-missing-bob")
	bobSend := make(chan []byte, 16)
	hub.clients[bob.ID] = []*Client{NewTestClient(hub, bob.ID, bobSend)}

	hub.PrepareMentionCounts(context.Background(), 987654, []int64{bob.ID})(bob.ID, 1)
	if counts := mentionCountFrames(bobSend, 100*time.Millisecond); len(counts) != 0 {
		t.Errorf("frames for a missing channel = %v, want none", counts)
	}
}

// BenchmarkMentionBadgeLockHold measures what a mention flush to 1,000 connected
// readers does while it holds the channel's emit lock: "per-reader" resolves each
// reader's visibility under the lock (one notify per reader, the shape before the
// audience was prepared), "prepared" only enqueues frames after
// PrepareMentionCounts resolved the audience outside it ("prepare", off the lock).
func BenchmarkMentionBadgeLockHold(b *testing.B) {
	hub, database, _, chID := newMentionGateFixture(b)
	ctx := context.Background()
	const readers = 1000
	ids := make([]int64, 0, readers)
	for i := range readers {
		res, err := database.ExecContext(ctx,
			`INSERT INTO users (username, password, role_id) VALUES (?, 'hash', ?)`,
			fmt.Sprintf("bench-reader-%d", i), mentionGateRoleID)
		if err != nil {
			b.Fatalf("insert user: %v", err)
		}
		id, _ := res.LastInsertId()
		ids = append(ids, id)
		hub.clients[id] = []*Client{NewTestClient(hub, id, make(chan []byte, 1))}
	}
	b.Run("per-reader", func(b *testing.B) {
		for b.Loop() {
			for _, id := range ids {
				hub.NotifyMentionCount(id, chID, 1)
			}
		}
	})
	b.Run("prepare", func(b *testing.B) {
		for b.Loop() {
			hub.PrepareMentionCounts(ctx, chID, ids)
		}
	})
	b.Run("prepared", func(b *testing.B) {
		send := hub.PrepareMentionCounts(ctx, chID, ids)
		b.ResetTimer()
		for b.Loop() {
			for _, id := range ids {
				send(id, 1)
			}
		}
	})
}
