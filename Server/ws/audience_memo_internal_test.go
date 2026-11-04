package ws

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// audienceFixture is a migrated database, a hub with a real PermissionService
// and n registered Member-role clients, plus one text channel.
type audienceFixture struct {
	database *db.DB
	hub      *Hub
	chID     int64
	users    []int64
	conns    map[int64]*Client
}

func newAudienceFixture(tb testing.TB, n int) *audienceFixture {
	tb.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		tb.Fatalf("db.Open: %v", err)
	}
	tb.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		tb.Fatalf("Migrate: %v", err)
	}
	ctx := context.Background()
	chID, err := database.CreateChannel(ctx, "memo-ch", "text", "", "", 0)
	if err != nil {
		tb.Fatalf("CreateChannel: %v", err)
	}
	f := &audienceFixture{database: database, chID: chID, conns: map[int64]*Client{}}
	f.hub = newTestHub(tb, database, nil, nil)
	f.hub.perms = service.NewPermissionService(database, permissions.NewChecker(database))
	for i := range n {
		f.connect(tb, f.createUser(tb, fmt.Sprintf("memo-%04d", i), 4))
	}
	return f
}

func (f *audienceFixture) createUser(tb testing.TB, name string, role int) int64 {
	tb.Helper()
	id, err := f.database.CreateUser(context.Background(), name, "hash", role)
	if err != nil {
		tb.Fatalf("CreateUser %s: %v", name, err)
	}
	return id
}

func (f *audienceFixture) connect(tb testing.TB, uid int64) {
	tb.Helper()
	u, err := f.database.GetUserByID(context.Background(), uid)
	if err != nil || u == nil {
		tb.Fatalf("GetUserByID %d: %v", uid, err)
	}
	c := NewTestClientWithUser(f.hub, u, 0, make(chan []byte, 256))
	f.hub.registerNowTest(c, nil)
	f.users = append(f.users, uid)
	f.conns[uid] = c
}

func sortedIDs(ids []int64) []int64 {
	out := slices.Clone(ids)
	slices.Sort(out)
	return out
}

func TestAudienceMemo_ReusedUntilAGenerationMoves(t *testing.T) {
	f := newAudienceFixture(t, 3)
	ctx := context.Background()
	first := f.hub.channelReadAudience(ctx, f.chID)
	if got, want := sortedIDs(first), sortedIDs(f.users); !slices.Equal(got, want) {
		t.Fatalf("audience = %v, want %v", got, want)
	}
	// A second resolution in the same generations asks the permission cache nothing.
	hitsBefore, missesBefore := f.hub.perms.CacheStats()
	second := f.hub.channelReadAudience(ctx, f.chID)
	if !slices.Equal(sortedIDs(second), sortedIDs(first)) {
		t.Fatalf("memoised audience = %v, want %v", second, first)
	}
	if hits, misses := f.hub.perms.CacheStats(); hits != hitsBefore || misses != missesBefore {
		t.Fatalf("memoised resolution read the permission cache: hits %d->%d, misses %d->%d", hitsBefore, hits, missesBefore, misses)
	}
	// The caller owns the slice it gets: writing it never reaches the memo.
	second[0] = -1
	if slices.Contains(f.hub.channelReadAudience(ctx, f.chID), -1) {
		t.Fatal("a caller's write reached the memoised audience")
	}
}

// A revoked reader must drop out on the next frame: the deny override bumps the
// permission generation, so the memo is not reused.
func TestAudienceMemo_PermissionChangeIsSeenOnTheNextFrame(t *testing.T) {
	f := newAudienceFixture(t, 3)
	ctx := context.Background()
	if got := f.hub.channelReadAudience(ctx, f.chID); len(got) != 3 {
		t.Fatalf("audience = %v, want 3 users", got)
	}
	revoked := f.users[1]
	if err := f.database.UpsertChannelUserOverride(ctx, f.chID, revoked, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	f.hub.perms.InvalidateUser(revoked)
	got := f.hub.channelReadAudience(ctx, f.chID)
	if slices.Contains(got, revoked) || len(got) != 2 {
		t.Fatalf("audience after revoke = %v, want the two others", got)
	}
}

// A connect and a disconnect between two frames are both seen.
func TestAudienceMemo_ConnectAndDisconnectAreSeen(t *testing.T) {
	f := newAudienceFixture(t, 2)
	ctx := context.Background()
	_ = f.hub.channelReadAudience(ctx, f.chID)
	late := f.createUser(t, "memo-late", 4)
	f.connect(t, late)
	if got := f.hub.channelReadAudience(ctx, f.chID); !slices.Contains(got, late) {
		t.Fatalf("audience after connect = %v, missing %d", got, late)
	}
	gone := f.users[0]
	f.hub.unregisterNow(f.conns[gone])
	if got := f.hub.channelReadAudience(ctx, f.chID); slices.Contains(got, gone) {
		t.Fatalf("audience after disconnect = %v, still has %d", got, gone)
	}
}

// An invalidation that lands while an audience is being resolved must keep that
// result out of the memo: it may carry the pre-change verdict.
func TestAudienceMemo_RacingInvalidationIsNotStored(t *testing.T) {
	f := newAudienceFixture(t, 2)
	ctx := context.Background()
	revoked := f.users[0]
	permGen, connGen, ok := f.hub.memoGens()
	if !ok {
		t.Fatal("memo disabled on a hub with a PermissionService")
	}
	ref := permissions.ChannelRef{ID: f.chID, Type: "text"}
	key := audienceMemoKey{channelID: f.chID}
	stale := []int64{f.users[0], f.users[1]}
	// The revocation commits and invalidates after the resolution read permGen...
	if err := f.database.UpsertChannelUserOverride(ctx, f.chID, revoked, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	f.hub.perms.InvalidateUser(revoked)
	// ...and before it stores its (pre-change) answer.
	f.hub.storeIfUnchanged(&f.hub.audience.channels, key, ref, permGen, connGen, time.Now(), stale)
	if _, found := f.hub.audience.channels.Load(key); found {
		t.Fatal("a resolution that raced an invalidation was memoised")
	}
	if got := f.hub.channelReadAudience(ctx, f.chID); slices.Contains(got, revoked) {
		t.Fatalf("audience = %v still has the revoked reader", got)
	}
}

func TestAudienceMemo_ChannelFlagChangeIsNotReused(t *testing.T) {
	f := newAudienceFixture(t, 2)
	ctx := context.Background()
	ch, err := f.database.GetChannel(ctx, f.chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if got := f.hub.channelReadAudienceFor(ctx, f.chID, ch, false); len(got) != 2 {
		t.Fatalf("audience = %v, want 2", got)
	}
	archived := *ch
	archived.Archived = true
	if got := f.hub.channelReadAudienceFor(ctx, f.chID, &archived, false); len(got) != 0 {
		t.Fatalf("archived audience = %v, want nobody", got)
	}
	if got := f.hub.channelReadAudienceFor(ctx, f.chID, &archived, true); len(got) != 2 {
		t.Fatalf("pre-archival audience = %v, want 2", got)
	}
}

// Entries for channels nobody asks about again (a deleted thread) are dropped
// once they are too old to be reused.
func TestAudienceMemo_OldEntriesArePruned(t *testing.T) {
	f := newAudienceFixture(t, 1)
	ctx := context.Background()
	_ = f.hub.channelReadAudience(ctx, f.chID)
	key := audienceMemoKey{channelID: f.chID}
	f.hub.pruneChannelAudiences(time.Now())
	if _, found := f.hub.audience.channels.Load(key); !found {
		t.Fatal("a fresh entry was pruned")
	}
	f.hub.pruneChannelAudiences(time.Now().Add(audienceMemoMaxAge))
	if _, found := f.hub.audience.channels.Load(key); found {
		t.Fatal("an entry too old to be reused was kept")
	}
}

func TestModerators_MemoisedAndRoleChangeSeen(t *testing.T) {
	f := newAudienceFixture(t, 2)
	ctx := context.Background()
	mod := f.createUser(t, "memo-mod", 3)
	f.connect(t, mod)
	if got := f.hub.moderationAudience(ctx); !slices.Equal(got, []int64{mod}) {
		t.Fatalf("moderators = %v, want [%d]", got, mod)
	}
	if got := f.hub.moderationAudience(ctx, mod); len(got) != 0 {
		t.Fatalf("moderators excluding %d = %v, want none", mod, got)
	}
	// The exclusion above must not have shrunk the memoised set.
	if got := f.hub.moderationAudience(ctx); !slices.Equal(got, []int64{mod}) {
		t.Fatalf("moderators after an excluding call = %v, want [%d]", got, mod)
	}
	if err := f.database.UpdateUserRole(ctx, mod, 4); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	f.hub.perms.InvalidateUser(mod)
	if got := f.hub.moderationAudience(ctx); len(got) != 0 {
		t.Fatalf("moderators after demotion = %v, want none", got)
	}
}

// BenchmarkChannelReadAudience pins the per-frame cost of resolving a channel's
// readers at 1,000 connected clients: "memo" is a burst of frames in one
// permission generation, "cold" forces a full resolution every frame (the cost
// before the memo, and after any invalidation).
func BenchmarkChannelReadAudience(b *testing.B) {
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	b.Cleanup(func() { slog.SetDefault(prev) })
	f := newAudienceFixture(b, 1000)
	ctx := context.Background()
	_ = f.hub.channelReadAudience(ctx, f.chID) // warm the permission cache
	b.Run("memo", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			_ = f.hub.channelReadAudience(ctx, f.chID)
		}
	})
	b.Run("cold", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			f.hub.forgetChannelAudience(f.chID)
			_ = f.hub.channelReadAudience(ctx, f.chID)
		}
	})
	// The channel_activity flush and the thread coalescer pass a row they already
	// read, so this is the per-user resolution alone.
	ch, err := f.database.GetChannel(ctx, f.chID)
	if err != nil || ch == nil {
		b.Fatalf("GetChannel: %v", err)
	}
	b.Run("row-memo", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			_ = f.hub.channelReadAudienceFor(ctx, f.chID, ch, false)
		}
	})
	b.Run("row-cold", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			f.hub.forgetChannelAudience(f.chID)
			_ = f.hub.channelReadAudienceFor(ctx, f.chID, ch, false)
		}
	})
	b.Run("moderators", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			_ = f.hub.moderationAudience(ctx, 1, 2)
		}
	})
}
