package ws

// SRE-M2 server half: the "voice join" line carries the joining frame's req_id
// and every leave path records why it ran. These drive the real entry points
// and assert the log fields each one produces.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// lockedBuffer is a slog sink safe against the background goroutines a leave
// can spawn (the DB-retry loop logs concurrently with the handler).
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// captureVoiceLog redirects the default logger into a locked buffer for the
// duration of one test.
func captureVoiceLog(t *testing.T) *lockedBuffer {
	t.Helper()
	buf := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// newVoiceTraceHub builds a hub with a LiveKit client pointed at a dead
// address (enough to mint tokens) and one connected user, returning the user
// id and a voice channel they are cleared to join.
func newVoiceTraceHub(t *testing.T, name string) (*Hub, *db.DB, *Client, int64) {
	t.Helper()
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, name)
	chID := mustCreateVoiceChannel(t, database, name+"-voice")

	h := newTestHub(t, database, auth.NewRateLimiter(), nil)
	t.Cleanup(h.Stop)
	lk := healthyTestLiveKit(t)
	h.livekit = lk

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	c := NewTestClient(h, uid, make(chan []byte, 256))
	c.user = user
	h.clients[uid] = c
	return h, database, c, chID
}

// voiceFrame builds a client envelope of the given type.
func voiceFrame(t *testing.T, typ, id string, payload map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"type": typ, "id": id, "payload": payload})
	if err != nil {
		t.Fatalf("marshal %s: %v", typ, err)
	}
	return raw
}

// joinVoiceForTrace joins c to chID through a real voice_join frame.
func joinVoiceForTrace(t *testing.T, h *Hub, c *Client, chID int64) {
	t.Helper()
	h.handleMessage(c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": chID}))
	if got := c.getVoiceChID(); got != chID {
		t.Fatalf("setup join did not land: voice channel = %d, want %d", got, chID)
	}
}

// revokeConnectVoice denies CONNECT_VOICE on chID for the harvest role.
func revokeConnectVoice(t *testing.T, database *db.DB, chID int64) {
	t.Helper()
	if err := database.UpsertChannelOverride(context.Background(), chID, harvestVoiceRoleID, 0, permissions.ConnectVoice); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
}

// voiceLeaveReasons returns the reason of every "voice leave" line logged.
func voiceLeaveReasons(log string) []string {
	var reasons []string
	for line := range strings.Lines(log) {
		if !strings.Contains(line, `msg="voice leave"`) {
			continue
		}
		for field := range strings.FieldsSeq(line) {
			if r, ok := strings.CutPrefix(field, "reason="); ok {
				reasons = append(reasons, r)
			}
		}
	}
	return reasons
}

// TestVoiceLeave_EntryPointsLogTheirReason drives each server-side leave path
// from its real entry point and asserts the single "voice leave" line it
// produces names that path.
func TestVoiceLeave_EntryPointsLogTheirReason(t *testing.T) {
	cases := []struct {
		name  string
		want  string
		leave func(t *testing.T, h *Hub, database *db.DB, c *Client, chID int64)
	}{
		{"client voice_leave frame", voiceLeaveReasonClient, func(t *testing.T, h *Hub, _ *db.DB, c *Client, _ int64) {
			h.handleMessage(c, voiceFrame(t, "voice_leave", "leave", map[string]any{}))
		}},
		{"channel switch", voiceLeaveReasonSwitch, func(t *testing.T, h *Hub, database *db.DB, c *Client, _ int64) {
			other := mustCreateVoiceChannel(t, database, "trace-other")
			h.handleMessage(c, voiceFrame(t, "voice_join", "switch", map[string]any{"channel_id": other}))
		}},
		{"denied voice_token_refresh", voiceLeaveReasonTokenRefresh, func(t *testing.T, h *Hub, database *db.DB, c *Client, chID int64) {
			revokeConnectVoice(t, database, chID)
			h.handleMessage(c, voiceFrame(t, "voice_token_refresh", "refresh", map[string]any{}))
		}},
		{"revocation sweep", voiceLeaveReasonRevoked, func(t *testing.T, h *Hub, database *db.DB, _ *Client, chID int64) {
			revokeConnectVoice(t, database, chID)
			h.sweepStaleVoiceEvictRevoked(context.Background())
		}},
		{"moderator DisconnectFromVoice", voiceLeaveReasonModerator, func(t *testing.T, h *Hub, _ *db.DB, c *Client, _ int64) {
			if !h.DisconnectFromVoice(context.Background(), c.userID) {
				t.Fatal("DisconnectFromVoice reported no connection")
			}
		}},
		{"moderator kick via disconnectFromVoiceIn", voiceLeaveReasonModerator, func(t *testing.T, h *Hub, _ *db.DB, c *Client, chID int64) {
			if !disconnectFromVoiceIn(context.Background(), h, c.userID, chID) {
				t.Fatal("disconnectFromVoiceIn reported no eviction")
			}
		}},
		{"DM eviction via DisconnectFromVoiceInChannel", VoiceLeaveReasonBlocked, func(t *testing.T, h *Hub, _ *db.DB, c *Client, chID int64) {
			if !h.DisconnectFromVoiceInChannel(context.Background(), c.userID, chID, VoiceLeaveReasonBlocked) {
				t.Fatal("DisconnectFromVoiceInChannel reported no eviction")
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, database, c, chID := newVoiceTraceHub(t, "trace")
			joinVoiceForTrace(t, h, c, chID)

			buf := captureVoiceLog(t)
			tc.leave(t, h, database, c, chID)

			got := voiceLeaveReasons(buf.String())
			if len(got) != 1 || got[0] != tc.want {
				t.Fatalf("voice leave reasons = %q, want [%q]\n%s", got, tc.want, buf.String())
			}
		})
	}
}

// TestHandleVoiceJoin_LogsReqID sends a voice_join frame and asserts the join
// line carries its envelope id, capped at 64 chars like every req_id log
// site, so an operator can correlate a token with its arrival.
func TestHandleVoiceJoin_LogsReqID(t *testing.T) {
	h, _, c, chID := newVoiceTraceHub(t, "join-reqid")
	reqID := "req-join-" + strings.Repeat("x", 70)

	buf := captureVoiceLog(t)
	h.handleMessage(c, voiceFrame(t, "voice_join", reqID, map[string]any{"channel_id": chID}))

	if got := c.getVoiceChID(); got != chID {
		t.Fatalf("join did not land: voice channel = %d, want %d (log:\n%s)", got, chID, buf.String())
	}
	for line := range strings.Lines(buf.String()) {
		if strings.Contains(line, `msg="voice join"`) {
			if !strings.Contains(line, " req_id="+reqID[:64]+" ") {
				t.Fatalf("join log req_id is not the 64-char prefix %q:\n%s", reqID[:64], line)
			}
			return
		}
	}
	t.Fatalf("no voice join line logged:\n%s", buf.String())
}
