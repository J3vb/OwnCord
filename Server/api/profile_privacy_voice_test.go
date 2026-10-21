package api_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
)

// privacyEvictBroadcaster records the hub's per-channel voice evictions.
type privacyEvictBroadcaster struct {
	calls []evictCall
}

func (*privacyEvictBroadcaster) BroadcastUserUpdate(ws.UserUpdate) {}

func (b *privacyEvictBroadcaster) DisconnectFromVoiceInChannel(_ context.Context, userID, channelID int64, reason string) bool {
	b.calls = append(b.calls, evictCall{userID, channelID, reason})
	return true
}

// Turning "Allow DMs" off removes an untrusted counterpart from the 1:1 DM
// voice call at once, the way a block does; a trusted counterpart, a
// counterpart not in the call and a group call are left alone.
func TestPutPrivacy_DMsOffEvictsUntrustedCounterpartFromVoice(t *testing.T) {
	ctx := context.Background()
	database := newMigratedAuthTestDB(t)
	bc := &privacyEvictBroadcaster{}
	r := chi.NewRouter()
	limiter := auth.NewRateLimiter()
	api.MountProfileRoutes(r, service.New(database, limiter), nil, limiter, nil, bc, nil)

	alice := profileCreateToken(t, database, "alice-pv", 4)
	var aliceID int64
	if err := database.QueryRowContext(ctx, `SELECT id FROM users WHERE username = 'alice-pv'`).Scan(&aliceID); err != nil {
		t.Fatalf("alice id: %v", err)
	}
	seed := func(name string) int64 {
		id, err := database.CreateUser(ctx, name, "x", 4)
		if err != nil {
			t.Fatalf("CreateUser %s: %v", name, err)
		}
		return id
	}
	bob, carol, dave, erin := seed("bob-pv"), seed("carol-pv"), seed("dave-pv"), seed("erin-pv")
	dm := func(other int64) int64 {
		ch, _, err := database.GetOrCreateDMChannel(ctx, aliceID, other)
		if err != nil {
			t.Fatalf("GetOrCreateDMChannel: %v", err)
		}
		return ch.ID
	}
	bobDM, carolDM := dm(bob), dm(carol)
	dm(dave) // dave is not in a call
	group, err := database.CreateGroupDMChannel(ctx, "Crew", aliceID, []int64{aliceID, erin, bob})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	for _, j := range []struct{ user, ch int64 }{{bob, bobDM}, {carol, carolDM}, {erin, group.ID}} {
		if err := database.JoinVoiceChannel(ctx, j.user, j.ch); err != nil {
			t.Fatalf("JoinVoiceChannel: %v", err)
		}
	}
	// Alice trusts carol.
	if err := database.TrustSender(ctx, aliceID, carol, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}

	// Leaving the setting on evicts nobody.
	if rr := noteDo(t, r, http.MethodPut, privacyPath, alice, `{"allow_member_dms":true,"message_requests":true}`); rr.Code != http.StatusOK {
		t.Fatalf("PUT on = %d", rr.Code)
	}
	if len(bc.calls) != 0 {
		t.Fatalf("evictions with DMs on = %+v, want none", bc.calls)
	}

	if rr := noteDo(t, r, http.MethodPut, privacyPath, alice, `{"allow_member_dms":false,"message_requests":true}`); rr.Code != http.StatusOK {
		t.Fatalf("PUT off = %d; body = %s", rr.Code, rr.Body.String())
	}
	want := evictCall{bob, bobDM, ws.VoiceLeaveReasonBlocked}
	if len(bc.calls) != 1 || bc.calls[0] != want {
		t.Fatalf("evictions = %+v, want exactly %+v", bc.calls, want)
	}
}
