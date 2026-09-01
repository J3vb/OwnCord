package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// The voice family's decisions moved onto VoiceService with B3-8. These pin
// the ones that are decisions rather than pass-throughs: which insert a
// capacity limit selects, which row a delete is allowed to remove, and which
// channel a compensating write may touch. All three are about a target who
// moves while a request about them is in flight — the case the hub cannot see
// and the reason the rules are here rather than at each call site.

// voiceFixture seeds two voice channels and a member, and returns the service.
func voiceFixture(t *testing.T) (*VoiceService, *db.DB, context.Context) {
	t.Helper()
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1, Username: "member"})
	seedUser(t, database, &db.User{ID: 2, Username: "other"})
	seedChannel(t, database, &db.Channel{ID: 10, Name: "room-a", Type: "voice"})
	seedChannel(t, database, &db.Channel{ID: 11, Name: "room-b", Type: "voice"})
	return NewVoiceService(database), database, context.Background()
}

func TestVoiceService_JoinHonoursTheChannelCap(t *testing.T) {
	svc, _, ctx := voiceFixture(t)

	// maxUsers 0 is "uncapped" and takes the plain upsert.
	if err := svc.Join(ctx, 1, 10, 0); err != nil {
		t.Fatalf("uncapped join: %v", err)
	}
	state, err := svc.State(ctx, 1)
	if err != nil || state == nil || state.ChannelID != 10 {
		t.Fatalf("State after join = %+v, %v", state, err)
	}

	// A positive cap takes the capacity-checked insert, which refuses once
	// the channel is full. Room A already holds user 1, so a cap of 1 must
	// turn user 2 away.
	err = svc.Join(ctx, 2, 10, 1)
	if !errors.Is(err, ErrVoiceChannelFull) {
		t.Fatalf("join into a full channel: err = %v, want ErrVoiceChannelFull", err)
	}
	if got, _ := svc.State(ctx, 2); got != nil {
		t.Errorf("a refused join left a row behind: %+v", got)
	}

	// The same cap admits while there is room.
	if err := svc.Join(ctx, 2, 11, 1); err != nil {
		t.Fatalf("join into an empty capped channel: %v", err)
	}
	if n, err := svc.CountInChannel(ctx, 11); err != nil || n != 1 {
		t.Errorf("CountInChannel(11) = %d, %v; want 1", n, err)
	}
}

// LeaveIfMatch is the only delete in the server, and this is why: between the
// snapshot a caller acts on and the delete it issues, the member can leave and
// rejoin. An unconditional delete by user id would then remove the NEW row,
// putting a live participant's membership out of existence.
func TestVoiceService_LeaveIfMatchWillNotDeleteANewerRow(t *testing.T) {
	svc, _, ctx := voiceFixture(t)

	if err := svc.Join(ctx, 1, 10, 0); err != nil {
		t.Fatalf("join: %v", err)
	}
	stale, err := svc.State(ctx, 1)
	if err != nil || stale == nil {
		t.Fatalf("State: %+v, %v", stale, err)
	}

	// The member moves to room B — a new row, a new joinedAt.
	if err := svc.Join(ctx, 1, 11, 0); err != nil {
		t.Fatalf("switch: %v", err)
	}

	deleted, err := svc.LeaveIfMatch(ctx, 1, stale.ChannelID, stale.JoinedAt)
	if err != nil {
		t.Fatalf("LeaveIfMatch: %v", err)
	}
	if deleted {
		t.Error("LeaveIfMatch reported a delete against a snapshot the member has already moved off")
	}
	live, err := svc.State(ctx, 1)
	if err != nil || live == nil || live.ChannelID != 11 {
		t.Fatalf("the stale delete removed the live membership: %+v, %v", live, err)
	}

	// Against its own snapshot it does delete, exactly once.
	deleted, err = svc.LeaveIfMatch(ctx, 1, live.ChannelID, live.JoinedAt)
	if err != nil || !deleted {
		t.Fatalf("LeaveIfMatch against the live row = %v, %v; want true", deleted, err)
	}
	if again, _ := svc.LeaveIfMatch(ctx, 1, live.ChannelID, live.JoinedAt); again {
		t.Error("LeaveIfMatch reported a second delete of the same row")
	}
}

func TestVoiceService_RestoreModFlags(t *testing.T) {
	svc, _, ctx := voiceFixture(t)
	if err := svc.Join(ctx, 1, 10, 0); err != nil {
		t.Fatalf("join: %v", err)
	}

	// Nothing to restore: no round trips, and the caller keeps the row it has.
	if got := svc.RestoreModFlags(ctx, 1, 10, false, false); got != nil {
		t.Errorf("RestoreModFlags with no flags set returned %+v, want nil", got)
	}

	got := svc.RestoreModFlags(ctx, 1, 10, true, true)
	if got == nil {
		t.Fatal("RestoreModFlags returned nil after restoring both flags")
	}
	if !got.ServerMuted || !got.ServerDeafened {
		t.Errorf("restored row = {muted:%v deafened:%v}, want both true — "+
			"the caller broadcasts this row, so unrestored flags reach every client as lifted",
			got.ServerMuted, got.ServerDeafened)
	}

	// Scoped to the channel named, so a restore cannot land on a membership
	// the moderator's decision never covered.
	if err := svc.Join(ctx, 2, 11, 0); err != nil {
		t.Fatalf("join other: %v", err)
	}
	if got := svc.RestoreModFlags(ctx, 2, 10, true, false); got != nil && got.ServerMuted {
		t.Error("a restore scoped to channel 10 muted a member who is in channel 11")
	}
}

// RollbackServerDeafen's direction rule (OC-0034 / OC-0036). The undo runs
// after the paired server_muted write failed to match, which in practice means
// the target moved — so which channel the undo may touch is the whole
// question, and it differs by direction.
func TestVoiceService_RollbackServerDeafenScopesByDirection(t *testing.T) {
	t.Run("a deafen rolls back by clearing and follows the moved row", func(t *testing.T) {
		svc, _, ctx := voiceFixture(t)
		if err := svc.Join(ctx, 1, 10, 0); err != nil {
			t.Fatalf("join: %v", err)
		}
		if _, err := svc.SetServerDeafen(ctx, 1, 10, true); err != nil {
			t.Fatalf("SetServerDeafen: %v", err)
		}
		// The target switches channels — the deafen persisted across the
		// switch (a moderator flag survives a re-join), and channel 10 is now
		// stale.
		if err := svc.Join(ctx, 1, 11, 0); err != nil {
			t.Fatalf("switch: %v", err)
		}
		if _, err := svc.SetServerDeafen(ctx, 1, 11, true); err != nil {
			t.Fatalf("carry the flag onto the new row: %v", err)
		}

		svc.RollbackServerDeafen(ctx, 1, 10, true)

		state, err := svc.State(ctx, 1)
		if err != nil || state == nil {
			t.Fatalf("State: %+v, %v", state, err)
		}
		if state.ServerDeafened {
			t.Error("the rollback was scoped to the stale channel and matched nothing — " +
				"the target is left deafened, not SFU-muted, and unable to undeafen themselves")
		}
	})

	t.Run("an undeafen rolls back by re-applying and stays on the authorized channel", func(t *testing.T) {
		svc, _, ctx := voiceFixture(t)
		if err := svc.Join(ctx, 1, 10, 0); err != nil {
			t.Fatalf("join: %v", err)
		}
		if err := svc.Join(ctx, 1, 11, 0); err != nil {
			t.Fatalf("switch: %v", err)
		}

		// The moderator was authorized against channel 10; the target is now
		// in 11. Re-applying a restriction must not follow them there.
		svc.RollbackServerDeafen(ctx, 1, 10, false)

		state, err := svc.State(ctx, 1)
		if err != nil || state == nil {
			t.Fatalf("State: %+v, %v", state, err)
		}
		if state.ServerDeafened {
			t.Error("the rollback re-applied a server deafen on channel 11, which the actor " +
				"was never authorized against — it must be scoped to the authorized channel")
		}
	})

	t.Run("with the target still in place both directions land", func(t *testing.T) {
		svc, _, ctx := voiceFixture(t)
		if err := svc.Join(ctx, 1, 10, 0); err != nil {
			t.Fatalf("join: %v", err)
		}

		svc.RollbackServerDeafen(ctx, 1, 10, false) // undo an undeafen: re-apply
		if state, _ := svc.State(ctx, 1); state == nil || !state.ServerDeafened {
			t.Fatalf("re-apply did not land: %+v", state)
		}
		svc.RollbackServerDeafen(ctx, 1, 10, true) // undo a deafen: clear
		if state, _ := svc.State(ctx, 1); state == nil || state.ServerDeafened {
			t.Fatalf("clear did not land: %+v", state)
		}
	})

	t.Run("a target who left voice entirely has nothing to roll back", func(t *testing.T) {
		svc, _, ctx := voiceFixture(t)
		// No membership at all: the undo must be a no-op, not an insert.
		svc.RollbackServerDeafen(ctx, 1, 10, true)
		if state, err := svc.State(ctx, 1); err != nil || state != nil {
			t.Errorf("State = %+v, %v; want no row", state, err)
		}
	})
}

// The moderator flags are channel-scoped and report whether they matched;
// that boolean is what lets a handler refuse rather than let a write follow a
// target who moved between the authorization and the write (OC-0005).
func TestVoiceService_ServerFlagsReportAMissedChannel(t *testing.T) {
	svc, _, ctx := voiceFixture(t)
	if err := svc.Join(ctx, 1, 10, 0); err != nil {
		t.Fatalf("join: %v", err)
	}

	matched, err := svc.SetServerMute(ctx, 1, 10, true)
	if err != nil || !matched {
		t.Fatalf("SetServerMute on the live channel = %v, %v; want true", matched, err)
	}
	matched, err = svc.SetServerMute(ctx, 1, 11, true)
	if err != nil {
		t.Fatalf("SetServerMute: %v", err)
	}
	if matched {
		t.Error("SetServerMute reported a match against a channel the member is not in")
	}
	matched, err = svc.SetServerDeafen(ctx, 1, 11, true)
	if err != nil {
		t.Fatalf("SetServerDeafen: %v", err)
	}
	if matched {
		t.Error("SetServerDeafen reported a match against a channel the member is not in")
	}
}

// The reads the sweep and the join sequence depend on.
func TestVoiceService_Reads(t *testing.T) {
	svc, _, ctx := voiceFixture(t)
	if state, err := svc.State(ctx, 1); err != nil || state != nil {
		t.Fatalf("State for a member not in voice = %+v, %v; want (nil, nil)", state, err)
	}
	if err := svc.Join(ctx, 1, 10, 0); err != nil {
		t.Fatalf("join 1: %v", err)
	}
	if err := svc.Join(ctx, 2, 11, 0); err != nil {
		t.Fatalf("join 2: %v", err)
	}

	all, err := svc.AllStates(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("AllStates returned %d rows, %v; want 2 — the stale sweep reconciles against this", len(all), err)
	}
	in10, err := svc.ChannelStates(ctx, 10)
	if err != nil || len(in10) != 1 || in10[0].UserID != 1 {
		t.Fatalf("ChannelStates(10) = %+v, %v; want just user 1", in10, err)
	}
}

// A failed read must surface as an error, never as an empty roster: the stale
// sweep deletes every row it cannot match to a connected client, so "no rows"
// from a broken read would evict everyone in voice.
func TestVoiceService_ReadsFailLoud(t *testing.T) {
	svc, database, ctx := voiceFixture(t)
	if err := database.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if _, err := svc.AllStates(ctx); err == nil {
		t.Error("AllStates on a closed database returned no error — the sweep would read that as an empty roster")
	}
	if _, err := svc.State(ctx, 1); err == nil {
		t.Error("State on a closed database returned no error")
	}
	if _, err := svc.ChannelStates(ctx, 10); err == nil {
		t.Error("ChannelStates on a closed database returned no error")
	}
	if err := svc.Join(ctx, 1, 10, 0); err == nil {
		t.Error("Join on a closed database returned no error")
	}
	if err := svc.Join(ctx, 1, 10, 5); err == nil {
		t.Error("capacity-checked Join on a closed database returned no error")
	}
}
