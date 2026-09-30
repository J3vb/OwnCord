package ws_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// The streamed ready must be byte for byte the frame the map-based encoder
// produced, for every kind of viewer, over a roster that exercises every
// presence rule and every escaping case the splice has to preserve.
func TestWriteReady_MatchesLegacyEncoderByteForByte(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)
	ctx := context.Background()
	seedTestChannel(t, database, "general <&> \"quoted\"")

	admin := seedOwnerUser(t, database, "admin")
	member := seedMemberUser(t, database, "member")
	ghost := seedMemberUser(t, database, "ghost")          // connected, invisible
	online := seedMemberUser(t, database, "online")        // connected, online
	away := seedMemberUser(t, database, "away")            // disconnected, idle saved
	odd := seedMemberUser(t, database, "odd\"</script>&é") // escaping in every string field

	for _, u := range []*db.User{admin, ghost, online, away, odd} {
		if err := database.UpdateUserCustomStatus(ctx, u.ID, new("brb <b>&\"")); err != nil {
			t.Fatalf("UpdateUserCustomStatus: %v", err)
		}
	}
	if err := database.UpdateUserProfile(ctx, odd.ID, odd.Username, new("a<&>.png"), new("Ödd \u2028 \\"), nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	if err := database.UpdateUserIdentityKey(ctx, odd.ID, new("k+/=<>")); err != nil {
		t.Fatalf("UpdateUserIdentityKey: %v", err)
	}
	for id, status := range map[int64]string{ghost.ID: db.StatusInvisible, away.ID: db.StatusIdle} {
		if err := database.UpdateUserStatus(ctx, id, status); err != nil {
			t.Fatalf("UpdateUserStatus: %v", err)
		}
	}
	for _, u := range []*db.User{admin, member, ghost, online, odd} {
		fresh, err := database.GetUserByID(ctx, u.ID)
		if err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		c := ws.NewTestClientWithUser(hub, fresh, 0, make(chan []byte, 64))
		hub.Register(c)
		waitRegistered(t, hub, c)
		hub.ApplyConnectStatusForTest(c)
	}

	for _, v := range []struct {
		name   string
		user   *db.User
		roleID int64
	}{
		{"admin", admin, 1},
		{"member", member, 4},
		{"invisible", ghost, 4},
		{"disconnected", away, 4},
	} {
		role, err := database.GetRoleByID(ctx, v.roleID)
		if err != nil {
			t.Fatalf("GetRoleByID: %v", err)
		}
		want, err := hub.LegacyReadyForTest(database, v.user.ID, role)
		if err != nil {
			t.Fatalf("%s: legacy ready: %v", v.name, err)
		}
		got, err := hub.BuildReadyWithRoleForTest(database, v.user.ID, role)
		if err != nil {
			t.Fatalf("%s: ready: %v", v.name, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s viewer: streamed ready differs from the legacy encoder\n got: %s\nwant: %s", v.name, got, want)
		}
	}
}

// P5-O01: the member array is encoded once per member generation and every
// ready streams it to the socket, splicing in only what the viewer's presence
// rule decides. Before, each ready re-encoded the whole roster into a fresh
// buffer and copied it: about 130 KB allocated per ready over this 500-member
// roster, most of it the roster's JSON.
func TestWriteReady_AllocatesAFifthOfTheRoster(t *testing.T) {
	hub, database := newTestHub(t)
	const members = 500
	ids := make([]int64, members)
	for i := range members {
		ids[i] = seedOwnerUser(t, database, fmt.Sprintf("roster-%d", i)).ID
	}
	var failed error
	res := testing.Benchmark(func(b *testing.B) {
		b.ReportAllocs()
		for i := range b.N {
			if err := hub.WriteReadyForTest(database, ids[i%members], nil, io.Discard); err != nil {
				failed = err
			}
		}
	})
	if failed != nil {
		t.Fatalf("WriteReady: %v", failed)
	}
	// A fifth of the 130 KB the whole-roster encode allocated.
	const limit = 26 << 10
	if got := res.AllocedBytesPerOp(); got > limit {
		t.Errorf("one ready allocates %d bytes, want at most %d", got, limit)
	}
}
