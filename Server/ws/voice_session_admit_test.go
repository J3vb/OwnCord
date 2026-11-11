package ws

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	lkproto "github.com/livekit/protocol/livekit"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// admitFixture is a harness with one member in a voice channel whose role may
// use the microphone and the camera, plus what the tests need to name that join.
type admitFixture struct {
	*vmHarness
	alice    *vmMember
	store    *failingVoiceStore
	chID     int64
	token    string // alice's join token
	identity string
}

func newAdmitFixture(t *testing.T) *admitFixture {
	t.Helper()
	store := &failingVoiceStore{}
	h := newVMHarnessWithVoice(t, 1, func(real VoiceStore) VoiceStore {
		store.VoiceStore = real
		return store
	})
	if _, err := h.db.ExecContext(context.Background(), `UPDATE roles SET permissions = ? WHERE id = ?`,
		permissions.ReadMessages|permissions.ConnectVoice|permissions.SpeakVoice|permissions.UseVideo, harvestVoiceRoleID); err != nil {
		t.Fatalf("seed role: %v", err)
	}
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "admit")
	_, token := alice.c.voice.state()
	oldAdmit, oldConfirm := voiceAdmitRetryDelay, voiceConfirmRetryDelay
	voiceAdmitRetryDelay, voiceConfirmRetryDelay = time.Millisecond, time.Millisecond
	t.Cleanup(func() { voiceAdmitRetryDelay, voiceConfirmRetryDelay = oldAdmit, oldConfirm })
	return &admitFixture{vmHarness: h, alice: alice, store: store, chID: chID, token: token, identity: identity}
}

// widest mints a credential for alice's join carrying every publish right,
// whatever she holds now.
func (f *admitFixture) widest() string {
	f.t.Helper()
	token, err := f.hub.livekit.GenerateToken(f.alice.userID, f.alice.name, f.chID, f.token, true, true, true)
	if err != nil {
		f.t.Fatalf("GenerateToken: %v", err)
	}
	return token
}

// admit admits the widest credential and fails the test on a refusal.
func (f *admitFixture) admit() VoiceSessionTicket {
	f.t.Helper()
	ticket, err := f.hub.AdmitVoiceSession(context.Background(), f.widest())
	if err != nil {
		f.t.Fatalf("AdmitVoiceSession: %v", err)
	}
	return ticket
}

// sessionStarts models the media server holding the participant.
func (f *admitFixture) sessionStarts() {
	f.sfu.add(RoomName(f.chID), f.identity)
}

// beforeSession models a join with no participant at the media server yet;
// updates then behave as they do at the real media server.
func (f *admitFixture) beforeSession() {
	f.sfu.remove(RoomName(f.chID), f.identity)
	f.sfu.setStrictUpdates(true)
}

// confirmedUpdate runs Confirm and returns the one update it sent.
func (f *admitFixture) confirmedUpdate(ticket VoiceSessionTicket) *lkproto.UpdateParticipantRequest {
	f.t.Helper()
	if err := ticket.Confirm(context.Background()); err != nil {
		f.t.Fatalf("Confirm: %v", err)
	}
	updates := f.sfu.updatesFor(f.identity)
	if len(updates) != 1 {
		f.t.Fatalf("Confirm sent %d updates, want exactly 1", len(updates))
	}
	return updates[0]
}

func (f *admitFixture) serverMute() {
	f.t.Helper()
	// With no participant at the media server the update half reports it
	// missing; the row is what the test needs.
	if matched, _, err := f.hub.SetServerMuteLocked(context.Background(), f.alice.userID, f.chID, true); !matched {
		f.t.Fatalf("SetServerMuteLocked: matched=%v err=%v", matched, err)
	}
}

// claimsOf verifies a credential against the harness key and returns its claims.
func (f *admitFixture) claimsOf(token string) *auth.ClaimGrants {
	f.t.Helper()
	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		f.t.Fatalf("ParseAPIToken: %v", err)
	}
	_, claims, err := verifier.Verify(f.hub.livekit.apiSecret)
	if err != nil {
		f.t.Fatalf("Verify: %v", err)
	}
	return claims
}

func publishRights(claims *auth.ClaimGrants) voicePublishGrants {
	return voicePublishGrants{
		microphone:  claims.Video.GetCanPublishSource(lkproto.TrackSource_MICROPHONE),
		camera:      claims.Video.GetCanPublishSource(lkproto.TrackSource_CAMERA),
		screenshare: claims.Video.GetCanPublishSource(lkproto.TrackSource_SCREEN_SHARE),
	}
}

// handBuiltCredential signs a room credential for identity that expires at
// expires; the token library cannot issue one that is already expired.
func handBuiltCredential(t *testing.T, key, secret, identity, room string, expires time.Time) string {
	t.Helper()
	part := func(v any) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	signed := part(map[string]string{"alg": "HS256", "typ": "JWT"}) + "." + part(map[string]any{
		"iss": key, "sub": identity, "exp": expires.Unix(), "nbf": expires.Add(-time.Hour).Unix(),
		"video": map[string]any{"roomJoin": true, "room": room},
	})
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// The ticket's credential names the same join as the presented one and carries
// the rights the member holds now, not the ones the presented one carries.
func TestAdmitVoiceSession_IssuesCurrentRights(t *testing.T) {
	f := newAdmitFixture(t)

	claims := f.claimsOf(f.admit().Token)
	if claims.Identity != f.identity || claims.Video.Room != RoomName(f.chID) || claims.Name != f.alice.name {
		t.Fatalf("ticket names %q in %q as %q, want %q in %q as %q",
			claims.Identity, claims.Video.Room, claims.Name, f.identity, RoomName(f.chID), f.alice.name)
	}
	if got, want := publishRights(claims), (voicePublishGrants{microphone: true, camera: true}); got != want {
		t.Fatalf("ticket rights = %+v, want %+v (the role has no screen share)", got, want)
	}

	f.serverMute()
	claims = f.claimsOf(f.admit().Token)
	if got, want := publishRights(claims), (voicePublishGrants{camera: true}); got != want {
		t.Fatalf("ticket rights after a server mute = %+v, want %+v", got, want)
	}
	if claims.Video.GetCanPublishData() {
		t.Fatal("ticket after a server mute still carries the data right, which follows the microphone")
	}
}

// A credential that names no current join is refused, and one that does not
// verify is invalid; neither reaches the media server.
func TestAdmitVoiceSession_RefusesWhatIsNotACurrentJoin(t *testing.T) {
	f := newAdmitFixture(t)
	lk := f.hub.livekit
	mint := func(userID, channelID int64, joinToken string) string {
		token, err := lk.GenerateToken(userID, "x", channelID, joinToken, true, true, true)
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		return token
	}
	custom := func(key, secret string, validFor time.Duration, grant *auth.VideoGrant) string {
		token, err := auth.NewAccessToken(key, secret).SetVideoGrant(grant).
			SetIdentity(f.identity).SetValidFor(validFor).ToJWT()
		if err != nil {
			t.Fatalf("ToJWT: %v", err)
		}
		return token
	}
	room := &auth.VideoGrant{RoomJoin: true, Room: RoomName(f.chID)}
	other := f.chanOf("admit-other")

	for _, tc := range []struct {
		name      string
		presented string
		want      error
	}{
		{"another join of the same member", mint(f.alice.userID, f.chID, "an-earlier-join"), ErrVoiceSessionRefused},
		{"a channel the member is not in", mint(f.alice.userID, other, f.token), ErrVoiceSessionRefused},
		{"another user", mint(f.alice.userID+1000, f.chID, f.token), ErrVoiceSessionRefused},
		{"identity without a join", mint(f.alice.userID, f.chID, ""), ErrVoiceSessionRefused},
		{"not a room credential", custom(lk.apiKey, lk.apiSecret, time.Minute, &auth.VideoGrant{RoomList: true}), ErrVoiceSessionRefused},
		{"not a voice channel room", custom(lk.apiKey, lk.apiSecret, time.Minute, &auth.VideoGrant{RoomJoin: true, Room: "lobby"}), ErrVoiceSessionRefused},
		{"expired beyond tolerance", handBuiltCredential(t, lk.apiKey, lk.apiSecret, f.identity, RoomName(f.chID), time.Now().Add(-5*time.Minute)), ErrVoiceCredentialInvalid},
		{"signed with another secret", custom(lk.apiKey, "another-secret-0123456789abcdef", time.Minute, room), ErrVoiceCredentialInvalid},
		{"issued under another key", custom("another-key", lk.apiSecret, time.Minute, room), ErrVoiceCredentialInvalid},
		{"not a credential", "not.a.jwt", ErrVoiceCredentialInvalid},
		{"empty", "", ErrVoiceCredentialInvalid},
	} {
		if _, err := f.hub.AdmitVoiceSession(context.Background(), tc.presented); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}

	// The hand-built shape itself is sound: with time left it is admitted.
	if _, err := f.hub.AdmitVoiceSession(context.Background(), handBuiltCredential(t, lk.apiKey, lk.apiSecret, f.identity, RoomName(f.chID), time.Now().Add(time.Minute))); err != nil {
		t.Errorf("a hand-built credential with time left: %v", err)
	}

	// The join ends: the same credential that was admitted is now refused.
	presented := f.widest()
	f.evict(f.alice)
	if _, err := f.hub.AdmitVoiceSession(context.Background(), presented); !errors.Is(err, ErrVoiceSessionRefused) {
		t.Errorf("after the join ended: err = %v, want %v", err, ErrVoiceSessionRefused)
	}
	if got := f.sfu.updatesFor(f.identity); len(got) != 0 {
		t.Errorf("admission sent %d updates to the media server, want 0", len(got))
	}
}

// failingVoiceStore fails the next `failures` State reads.
type failingVoiceStore struct {
	VoiceStore
	failures atomic.Int32
}

func (s *failingVoiceStore) State(ctx context.Context, userID int64) (*db.VoiceState, error) {
	if s.failures.Load() > 0 && s.failures.Add(-1) >= 0 {
		return nil, errors.New("database is locked")
	}
	return s.VoiceStore.State(ctx, userID)
}

// One failed membership read is retried; a second failure is reported as
// neither admitted nor refused, so the caller answers "try again".
func TestAdmitVoiceSession_MembershipReadFailure(t *testing.T) {
	f := newAdmitFixture(t)
	store := f.store
	presented := f.widest()

	store.failures.Store(1)
	if _, err := f.hub.AdmitVoiceSession(context.Background(), presented); err != nil {
		t.Fatalf("one failed read was not retried: %v", err)
	}

	store.failures.Store(2)
	_, err := f.hub.AdmitVoiceSession(context.Background(), presented)
	if err == nil || errors.Is(err, ErrVoiceSessionRefused) || errors.Is(err, ErrVoiceCredentialInvalid) {
		t.Fatalf("two failed reads: err = %v, want an error that is neither refusal", err)
	}

	store.failures.Store(1)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.hub.AdmitVoiceSession(cancelled, presented); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled request waited out the retry: %v", err)
	}
	store.failures.Store(0)
}

// Confirm applies the rights the member holds when it runs, not the ones the
// ticket was issued with: one update, here without the microphone.
func TestConfirmVoiceSession_AppliesRightsThatNarrowedWhileConnecting(t *testing.T) {
	f := newAdmitFixture(t)
	f.beforeSession()

	ticket := f.admit()
	f.serverMute()
	if got := f.sfu.updatesFor(f.identity); len(got) != 0 {
		t.Fatalf("setup: the mute reached a participant that does not exist yet (%d updates)", len(got))
	}
	f.sessionStarts()

	update := f.confirmedUpdate(ticket)
	assertVoicePermissionSources(t, update, lkproto.TrackSource_CAMERA)
	if update.Permission.CanPublishData {
		t.Fatal("the applied rights keep the data right, which follows the microphone")
	}
}

// With nothing changed since the ticket was issued, Confirm still applies the
// rights once: the answer is what shows the media server holds the participant.
func TestConfirmVoiceSession_UnchangedRightsAreAppliedOnce(t *testing.T) {
	f := newAdmitFixture(t)
	ticket := f.admit()
	f.sessionStarts()
	assertVoicePermissionSources(t, f.confirmedUpdate(ticket), lkproto.TrackSource_MICROPHONE, lkproto.TrackSource_CAMERA)
}

// The media server can accept a session a moment before it holds the
// participant. Confirm waits for it, and reports a participant that never
// appears as a failure, not as confirmed.
func TestConfirmVoiceSession_WaitsForTheParticipant(t *testing.T) {
	t.Run("appears after the first try", func(t *testing.T) {
		f := newAdmitFixture(t)
		f.beforeSession()
		ticket := f.admit()
		f.serverMute()
		f.sfu.setOnMissingUpdate(f.sessionStarts)
		assertVoicePermissionSources(t, f.confirmedUpdate(ticket), lkproto.TrackSource_CAMERA)
	})
	t.Run("never appears", func(t *testing.T) {
		f := newAdmitFixture(t)
		f.beforeSession()
		if err := f.admit().Confirm(context.Background()); !errors.Is(err, ErrVoiceSessionAbsent) {
			t.Fatalf("Confirm: err = %v, want %v", err, ErrVoiceSessionAbsent)
		}
	})
}

// A join that ended since the ticket was issued is refused: Confirm removes
// the session and leaves the identity on the removed watch.
func TestConfirmVoiceSession_RemovesSessionOfAJoinThatEnded(t *testing.T) {
	f := newAdmitFixture(t)
	f.beforeSession()

	ticket := f.admit()
	f.evict(f.alice)
	f.sessionStarts()

	if err := ticket.Confirm(context.Background()); !errors.Is(err, ErrVoiceSessionRefused) {
		t.Fatalf("Confirm: err = %v, want %v", err, ErrVoiceSessionRefused)
	}
	if f.sfu.has(RoomName(f.chID), f.identity) {
		t.Fatal("the session of a join that ended is still at the media server")
	}
	if _, watched := f.hub.livekit.removed.snapshot(true)[f.chID][f.identity]; !watched {
		t.Fatal("the removed identity is not on the removed watch")
	}
}

// Confirm fails without refusing when it cannot read the join or cannot apply
// the rights.
func TestConfirmVoiceSession_Failures(t *testing.T) {
	t.Run("membership read fails", func(t *testing.T) {
		f := newAdmitFixture(t)
		ticket := f.admit()
		f.sessionStarts()
		f.store.failures.Store(1)
		err := ticket.Confirm(context.Background())
		if err == nil || errors.Is(err, ErrVoiceSessionRefused) {
			t.Fatalf("Confirm: err = %v, want a failure that is not a refusal", err)
		}
		if !f.sfu.has(RoomName(f.chID), f.identity) {
			t.Fatal("a failed read removed the session")
		}
	})
	t.Run("media server refuses the update", func(t *testing.T) {
		f := newAdmitFixture(t)
		ticket := f.admit()
		f.sfu.setUpdatesFail(true)
		err := ticket.Confirm(context.Background())
		if err == nil || errors.Is(err, ErrVoiceSessionRefused) || errors.Is(err, ErrVoiceSessionAbsent) {
			t.Fatalf("Confirm: err = %v, want a failure that is not a refusal", err)
		}
	})
}

// Confirm takes the member's moderation lock, the one every mute and unmute
// holds across its write and its media server update.
func TestConfirmVoiceSession_WaitsForModerationLock(t *testing.T) {
	f := newAdmitFixture(t)
	ticket := f.admit()
	f.sessionStarts()

	unlock := f.hub.voiceHub.mod.Lock(f.alice.userID)
	done := make(chan error, 1)
	go func() { done <- ticket.Confirm(context.Background()) }()
	select {
	case err := <-done:
		unlock()
		t.Fatalf("Confirm finished while the moderation lock was held: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	unlock()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Confirm: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Confirm never finished after the lock was released")
	}
}

// With voice off there is nothing to admit.
func TestAdmitVoiceSession_VoiceNotConfigured(t *testing.T) {
	h := newTestHubWith(t, HubOptions{DB: newHarvestVoiceDB(t)})
	_, err := h.AdmitVoiceSession(context.Background(), "anything")
	if err == nil || errors.Is(err, ErrVoiceSessionRefused) || errors.Is(err, ErrVoiceCredentialInvalid) {
		t.Fatalf("err = %v, want a failure that is neither refusal", err)
	}
}
