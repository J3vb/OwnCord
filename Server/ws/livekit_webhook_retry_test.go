package ws

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

func reconciliationLiveKit(t *testing.T, url string) *LiveKitClient {
	t.Helper()
	lk, err := NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey: "test-reconciliation-key", LiveKitAPISecret: "test-reconciliation-secret-long-enough", LiveKitURL: url,
	})
	if err != nil {
		t.Fatal(err)
	}
	return lk
}

func reconciliationJoinedRequest(t *testing.T, lk *LiveKitClient, joinToken string) *http.Request {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"event":       "participant_joined",
		"room":        map[string]string{"name": RoomName(100)},
		"participant": map[string]string{"identity": participantIdentity(1, joinToken)},
	})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	token, err := auth.NewAccessToken(lk.apiKey, lk.apiSecret).
		SetValidFor(5 * time.Minute).SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/livekit/webhook", strings.NewReader(string(body)))
	r.Header.Set("Authorization", token)
	return r
}

// Failed reconciliation cannot return 200: LiveKit would stop retrying, and
// the periodic DB sweep has no row from which to discover this rogue identity.
func TestLiveKitWebhook_JoinedFailuresRemainRetryable(t *testing.T) {
	for _, failure := range []string{"state_read", "remove_participant"} {
		t.Run(failure, func(t *testing.T) {
			ctx := context.Background()
			_, database := tokenRefreshDeps(t)
			if err := database.LeaveVoiceChannel(ctx, 1); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int64
			var failing atomic.Bool
			failing.Store(true)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if failing.Load() {
					http.Error(w, "temporarily offline", http.StatusServiceUnavailable)
					return
				}
				w.Header().Set("Content-Type", "application/protobuf")
				w.WriteHeader(http.StatusOK)
			}))
			defer srv.Close()
			lk := reconciliationLiveKit(t, srv.URL)
			h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
			if failure == "state_read" {
				if _, err := database.ExecContext(ctx, `ALTER TABLE voice_states RENAME TO voice_states_offline`); err != nil {
					t.Fatal(err)
				}
			}
			handler := h.NewLiveKitWebhookHandler(lk.apiKey, lk.apiSecret)
			w := httptest.NewRecorder()
			handler(w, reconciliationJoinedRequest(t, lk, "old-join"))
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("failed reconciliation HTTP = %d, want 503 for retry", w.Code)
			}
			if failure == "state_read" {
				if calls.Load() != 0 {
					t.Fatal("a DB read error alone must not trigger participant removal")
				}
				if _, err := database.ExecContext(ctx, `ALTER TABLE voice_states_offline RENAME TO voice_states`); err != nil {
					t.Fatal(err)
				}
			}
			before := calls.Load()
			failing.Store(false)
			h.sweepStaleVoiceStates()
			if calls.Load() != before {
				t.Fatal("fixture must exercise an SFU identity invisible to the DB sweep")
			}
			w = httptest.NewRecorder()
			handler(w, reconciliationJoinedRequest(t, lk, "old-join"))
			if w.Code != http.StatusOK || calls.Load() != before+1 {
				t.Fatalf("retry HTTP = %d, SFU calls = %d, want 200 and %d", w.Code, calls.Load(), before+1)
			}
		})
	}
}

func TestLiveKitWebhook_AlreadyRemovedParticipantIsIdempotent(t *testing.T) {
	_, database := tokenRefreshDeps(t)
	if err := database.LeaveVoiceChannel(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"code":"not_found","msg":"participant does not exist"}`)
	}))
	defer srv.Close()
	lk := reconciliationLiveKit(t, srv.URL)
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	handler := h.NewLiveKitWebhookHandler(lk.apiKey, lk.apiSecret)
	for range 2 {
		w := httptest.NewRecorder()
		handler(w, reconciliationJoinedRequest(t, lk, "old-join"))
		if w.Code != http.StatusOK {
			t.Fatalf("already removed participant HTTP = %d, want 200", w.Code)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("removal attempts = %d, want 2", calls.Load())
	}
}

func TestLiveKitWebhook_ReusedJoinIdentityGetsCurrentPermissions(t *testing.T) {
	ctx := context.Background()
	_, database := tokenRefreshDeps(t)
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo|permissions.ShareScreen)
	state, err := database.GetVoiceState(ctx, 1)
	if err != nil || state == nil {
		t.Fatalf("voice state: %v", err)
	}
	updates := make(chan *livekit.UpdateParticipantRequest, 2)
	var failing atomic.Bool
	failing.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/UpdateParticipant") {
			t.Errorf("unexpected SFU request: %s", r.URL.Path)
			http.Error(w, "unexpected RPC", http.StatusBadRequest)
			return
		}
		if failing.Load() {
			http.Error(w, "temporarily offline", http.StatusServiceUnavailable)
			return
		}
		raw, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			t.Error(readErr)
			return
		}
		var update livekit.UpdateParticipantRequest
		if err := proto.Unmarshal(raw, &update); err != nil {
			t.Error(err)
			return
		}
		updates <- &update
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	lk := reconciliationLiveKit(t, srv.URL)
	h := newTestHubWith(t, HubOptions{DB: database, LiveKit: lk})
	// An already issued JWT can reconnect with this same join identity after
	// the moderator's DB flag changes. The webhook must apply the new grant.
	if matched, err := database.SetVoiceServerMute(ctx, 1, 100, true); err != nil || !matched {
		t.Fatalf("server mute: matched=%v err=%v", matched, err)
	}
	handler := h.NewLiveKitWebhookHandler(lk.apiKey, lk.apiSecret)
	w := httptest.NewRecorder()
	handler(w, reconciliationJoinedRequest(t, lk, state.JoinedAt))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("permission update failure HTTP = %d, want 503", w.Code)
	}
	failing.Store(false)
	w = httptest.NewRecorder()
	handler(w, reconciliationJoinedRequest(t, lk, state.JoinedAt))
	if w.Code != http.StatusOK {
		t.Fatalf("permission update retry HTTP = %d, want 200", w.Code)
	}
	select {
	case update := <-updates:
		if update.Identity != participantIdentity(1, state.JoinedAt) || update.Room != RoomName(100) {
			t.Fatalf("permission update targeted wrong membership: %v", update)
		}
		want := []livekit.TrackSource{livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO}
		if update.Permission == nil || !update.Permission.CanPublish || !update.Permission.CanSubscribe || !slices.Equal(update.Permission.CanPublishSources, want) {
			t.Fatalf("reconnect source grant = %v, want mic denied and camera/stream allowed", update.Permission)
		}
	default:
		t.Fatal("matching join identity did not reconcile current permissions")
	}
}
