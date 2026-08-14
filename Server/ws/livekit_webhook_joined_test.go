package ws_test

import (
	"bytes"
	"context"
	"log/slog"
	"strconv"
	"strings"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/owncord/server/ws"
)

// handleWebhookParticipantJoined had no coverage. It is the server's guard
// against a replayed LiveKit join token: LiveKit reports who joined a room, and
// the hub cross-checks that against its own voice_states row, evicting anyone
// who has no matching state or presents a stale token. If that check silently
// stops firing, a leaked token grants voice access to a channel the holder was
// removed from.
//
// The handler's only side effects are a slog warning and a RemoveParticipant
// call, so these tests assert on captured log output.

// captureLogs swaps the default slog logger for one writing into a buffer and
// returns an accessor for what was written.
func captureLogs(t *testing.T) func() string {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf.String
}

func TestWebhook_ParticipantJoined_RogueParticipantFlagged(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "joined-rogue-user")
	chanID := seedVoiceChan(t, database, "joined-rogue-ch")

	logs := captureLogs(t)

	// No voice_states row exists for this user — the join is unauthorized.
	hub.HandleWebhookParticipantJoinedForTest(
		participantIdentityFor(user.ID, "sometoken"),
		roomNameFor(chanID),
	)

	if !strings.Contains(logs(), "rogue participant_joined") {
		t.Errorf("no rogue-participant warning logged; got:\n%s", logs())
	}
}

func TestWebhook_ParticipantJoined_StaleTokenFlagged(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "joined-stale-user")
	chanID := seedVoiceChan(t, database, "joined-stale-ch")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	logs := captureLogs(t)

	// A matching row exists, but the webhook presents a token from an older
	// session. This is exactly the replay case the check exists for.
	hub.HandleWebhookParticipantJoinedForTest(
		participantIdentityFor(user.ID, "an-old-token"),
		roomNameFor(chanID),
	)

	if !strings.Contains(logs(), "stale join token") {
		t.Errorf("no stale-token warning logged; got:\n%s", logs())
	}
}

func TestWebhook_ParticipantJoined_ValidJoinAccepted(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "joined-valid-user")
	chanID := seedVoiceChan(t, database, "joined-valid-ch")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v (nil=%v)", err, state == nil)
	}

	logs := captureLogs(t)

	hub.HandleWebhookParticipantJoinedForTest(
		participantIdentityFor(user.ID, state.JoinedAt),
		roomNameFor(chanID),
	)

	out := logs()
	if strings.Contains(out, "rogue participant_joined") || strings.Contains(out, "stale join token") {
		t.Errorf("a legitimate join was flagged; log:\n%s", out)
	}
	if !strings.Contains(out, "participant joined") {
		t.Errorf("legitimate join was not logged at all; log:\n%s", out)
	}
}

// TestWebhook_ParticipantJoined_TransientReadErrorDoesNotEvict locks OC-0065:
// a GetVoiceState read failure must not be treated as proof of a rogue
// participant. sweepStaleVoiceStates already draws this distinction via
// hasChannelPermChecked ("a transient read failure ... is not a revocation");
// the webhook path OR'd stateErr into the same branch as "no matching row",
// so a transient DB error (SQLITE_BUSY, an I/O blip) ejected a legitimate
// participant from the SFU mid-call.
func TestWebhook_ParticipantJoined_TransientReadErrorDoesNotEvict(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "joined-dberr-user")
	chanID := seedVoiceChan(t, database, "joined-dberr-ch")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Fault-inject exactly the GetVoiceState read: renaming the table out from
	// under the query makes it return a genuine DB error instead of the
	// sql.ErrNoRows GetVoiceState collapses to (nil, nil) for a real "no
	// membership" case.
	if _, err := database.ExecContext(context.Background(),
		`ALTER TABLE voice_states RENAME TO voice_states_offline`); err != nil {
		t.Fatalf("rename voice_states: %v", err)
	}

	logs := captureLogs(t)

	hub.HandleWebhookParticipantJoinedForTest(
		participantIdentityFor(user.ID, "some-token"),
		roomNameFor(chanID),
	)

	if out := logs(); strings.Contains(out, "rogue participant_joined") {
		t.Errorf("a transient GetVoiceState error was treated as a rogue participant and evicted; log:\n%s", out)
	}
}

func TestWebhook_ParticipantJoined_WrongChannelFlagged(t *testing.T) {
	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "joined-wrongch-user")
	joined := seedVoiceChan(t, database, "joined-wrongch-a")
	other := seedVoiceChan(t, database, "joined-wrongch-b")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, joined); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	logs := captureLogs(t)

	// Correct token, wrong room — the state's channel must match too.
	hub.HandleWebhookParticipantJoinedForTest(
		participantIdentityFor(user.ID, state.JoinedAt),
		roomNameFor(other),
	)

	if !strings.Contains(logs(), "rogue participant_joined") {
		t.Errorf("a join into a channel the user is not in was not flagged; got:\n%s", logs())
	}
}

func TestWebhook_ParticipantJoined_MalformedInput(t *testing.T) {
	tests := []struct {
		name     string
		identity string
		room     string
		wantLog  string
	}{
		{"identity without user- prefix", "bogus", "channel-1", "bad identity"},
		{"identity with non-numeric id", "user-abc:tok", "channel-1", "bad identity"},
		{"empty identity", "", "channel-1", "bad identity"},
		{"room without channel- prefix", "user-1:tok", "lobby", "bad room"},
		{"room with non-numeric id", "user-1:tok", "channel-xyz", "bad room"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hub, _ := newVoiceHub(t)
			logs := captureLogs(t)

			// A webhook body is attacker-influenced input; the handler must
			// reject malformed values rather than panic or act on them.
			hub.HandleWebhookParticipantJoinedForTest(tt.identity, tt.room)

			if !strings.Contains(logs(), tt.wantLog) {
				t.Errorf("log does not mention %q; got:\n%s", tt.wantLog, logs())
			}
		})
	}
}

func TestWebhook_ParticipantJoined_NilFieldsIgnored(t *testing.T) {
	hub, _ := newVoiceHub(t)
	logs := captureLogs(t)

	// GetParticipant/GetRoom return nil for a partial event; the guard must
	// bail out before dereferencing either.
	hub.HandleWebhookParticipantJoinedEventForTest(&livekit.WebhookEvent{Event: "participant_joined"})
	hub.HandleWebhookParticipantJoinedEventForTest(&livekit.WebhookEvent{
		Event: "participant_joined",
		Room:  &livekit.Room{Name: "channel-1"},
	})
	hub.HandleWebhookParticipantJoinedEventForTest(&livekit.WebhookEvent{
		Event:       "participant_joined",
		Participant: &livekit.ParticipantInfo{Identity: "user-1:tok"},
	})

	if out := logs(); strings.Contains(out, "participant joined") {
		t.Errorf("an event with nil participant/room was processed; log:\n%s", out)
	}
}

// participantIdentityFor mirrors the identity format LiveKit sends back.
func participantIdentityFor(userID int64, joinToken string) string {
	id := "user-" + strconv.FormatInt(userID, 10)
	if joinToken == "" {
		return id
	}
	return id + ":" + joinToken
}

func roomNameFor(channelID int64) string {
	return ws.RoomName(channelID)
}
