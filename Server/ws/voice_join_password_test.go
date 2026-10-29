package ws_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
)

const joinPasswordSecret = "correct horse"

// newPasswordHub is a voice hub on the full migrated schema, so the password
// columns and the grants table exist, and returns its limiter for the
// rate-limit cases.
func newPasswordHub(t *testing.T) (*ws.Hub, *db.DB, *auth.RateLimiter) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	hub := newTestHubWith(t, ws.HubOptions{DB: database, Limiter: limiter, LiveKit: healthyLiveKitClient(t)})
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database, limiter
}

// protectVoiceChannel gives chanID a password the way the admin write does:
// a hash and a version bump. A cheap bcrypt cost keeps the test fast; the
// compare reads the cost from the hash.
func protectVoiceChannel(t *testing.T, database *db.DB, chanID int64, password string) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET password_hash = ?, password_version = password_version + 1 WHERE id = ?`,
		string(hash), chanID); err != nil {
		t.Fatalf("protect channel: %v", err)
	}
}

func unprotectVoiceChannel(t *testing.T, database *db.DB, chanID int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET password_hash = NULL, password_version = password_version + 1 WHERE id = ?`,
		chanID); err != nil {
		t.Fatalf("unprotect channel: %v", err)
	}
}

func voiceJoinPasswordMsg(channelID int64, password string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": channelID, "password": password},
	})
	return raw
}

func connectPasswordClient(t *testing.T, hub *ws.Hub, user *db.User, chanID int64) (*ws.Client, chan []byte) {
	t.Helper()
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)
	return c, send
}

// tryJoin sends voice_join (with the password when it is not empty) and
// returns the error code answered, "" when the join went through.
func tryJoin(hub *ws.Hub, c *ws.Client, send chan []byte, chanID int64, password string) string {
	msg := voiceJoinMsg(chanID)
	if password != "" {
		msg = voiceJoinPasswordMsg(chanID, password)
	}
	hub.HandleMessageForTest(c, msg)
	code := ""
	for _, m := range drainChanTimeout(send, 40*time.Millisecond) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Code string `json:"code"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "error" {
			code = env.Payload.Code
		}
	}
	return code
}

func inVoiceChannel(t *testing.T, database *db.DB, userID, chanID int64) bool {
	t.Helper()
	st, err := database.GetVoiceState(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	return st != nil && st.ChannelID == chanID
}

func hasGrant(t *testing.T, database *db.DB, chanID, userID int64) bool {
	t.Helper()
	ok, err := database.HasChannelPasswordGrant(context.Background(), chanID, userID)
	if err != nil {
		t.Fatalf("HasChannelPasswordGrant: %v", err)
	}
	return ok
}

func TestVoiceJoinPassword_RequiredWhenNoneSent(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-required")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-required-user")
	c, send := connectPasswordClient(t, hub, user, chanID)

	if code := tryJoin(hub, c, send, chanID, ""); code != "PASSWORD_REQUIRED" {
		t.Fatalf("code = %q, want PASSWORD_REQUIRED", code)
	}
	if inVoiceChannel(t, database, user.ID, chanID) {
		t.Fatal("a join without the password must not place the member in the channel")
	}
}

func TestVoiceJoinPassword_WrongPassword(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-wrong")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-wrong-user")
	c, send := connectPasswordClient(t, hub, user, chanID)

	if code := tryJoin(hub, c, send, chanID, "nope"); code != "WRONG_PASSWORD" {
		t.Fatalf("code = %q, want WRONG_PASSWORD", code)
	}
	if inVoiceChannel(t, database, user.ID, chanID) || hasGrant(t, database, chanID, user.ID) {
		t.Fatal("a wrong password must neither join nor store a grant")
	}
}

func TestVoiceJoinPassword_RightPasswordJoinsAndRemembers(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-right")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-right-user")
	c, send := connectPasswordClient(t, hub, user, chanID)

	if code := tryJoin(hub, c, send, chanID, joinPasswordSecret); code != "" {
		t.Fatalf("right password answered %q", code)
	}
	if !inVoiceChannel(t, database, user.ID, chanID) {
		t.Fatal("right password did not join")
	}
	if !hasGrant(t, database, chanID, user.ID) {
		t.Fatal("right password did not store a grant")
	}

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	drainChanTimeout(send, 40*time.Millisecond)
	if code := tryJoin(hub, c, send, chanID, ""); code != "" || !inVoiceChannel(t, database, user.ID, chanID) {
		t.Fatalf("a granted member rejoining without a password: code %q, in channel %v", code, inVoiceChannel(t, database, user.ID, chanID))
	}
}

// A reconnect rejoin sends no password: the stored grant lets it in, and once
// the password changes the same rejoin is asked for the new one.
func TestVoiceJoinPassword_RejoinUsesGrantUntilPasswordChanges(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-rejoin")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-rejoin-user")
	c, send := connectPasswordClient(t, hub, user, chanID)
	if code := tryJoin(hub, c, send, chanID, joinPasswordSecret); code != "" {
		t.Fatalf("first join answered %q", code)
	}

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	drainChanTimeout(send, 40*time.Millisecond)
	if code := tryJoin(hub, c, send, chanID, ""); code != "" {
		t.Fatalf("rejoin with a grant answered %q", code)
	}

	hub.HandleMessageForTest(c, voiceLeaveMsg())
	drainChanTimeout(send, 40*time.Millisecond)
	protectVoiceChannel(t, database, chanID, "a new password")
	if code := tryJoin(hub, c, send, chanID, ""); code != "PASSWORD_REQUIRED" {
		t.Fatalf("rejoin after a password change answered %q, want PASSWORD_REQUIRED", code)
	}
	if code := tryJoin(hub, c, send, chanID, joinPasswordSecret); code != "WRONG_PASSWORD" {
		t.Fatalf("old password after a change answered %q, want WRONG_PASSWORD", code)
	}
}

// changingStateReader changes the channel's password right after the hash was
// read, the window between the compare and the grant write.
type changingStateReader struct {
	ws.DispatchReader
	database *db.DB
	t        *testing.T
}

func (r changingStateReader) ChannelPasswordState(ctx context.Context, channelID int64) (string, int64, bool, error) {
	hash, version, found, err := r.DispatchReader.ChannelPasswordState(ctx, channelID)
	if _, execErr := r.database.ExecContext(ctx,
		`UPDATE channels SET password_hash = ?, password_version = password_version + 1 WHERE id = ?`,
		"changed while joining", channelID); execErr != nil {
		r.t.Fatalf("change password mid-join: %v", execErr)
	}
	return hash, version, found, err
}

func TestVoiceJoinPassword_ChangedBetweenHashReadAndGrantRefusesJoin(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	readers := ws.DBReaders(database)
	readers.Dispatch = changingStateReader{DispatchReader: database, database: database, t: t}
	hub := newTestHubWith(t, ws.HubOptions{DB: database, Limiter: auth.NewRateLimiter(), LiveKit: healthyLiveKitClient(t), Readers: readers})
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	chanID := seedVoiceChan(t, database, "pw-race")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-race-user")
	c, send := connectPasswordClient(t, hub, user, chanID)

	if code := tryJoin(hub, c, send, chanID, joinPasswordSecret); code != "WRONG_PASSWORD" {
		t.Fatalf("code = %q, want WRONG_PASSWORD", code)
	}
	if inVoiceChannel(t, database, user.ID, chanID) || hasGrant(t, database, chanID, user.ID) {
		t.Fatal("a password that changed mid-join must leave neither a join nor a grant")
	}
}

func TestVoiceJoinPassword_BypassHoldersJoinWithoutPassword(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-bypass")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)

	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (30, 'chan-manager', ?, 50, 0)`,
		permissions.ConnectVoice|permissions.ReadMessages|permissions.ManageChannels); err != nil {
		t.Fatal(err)
	}
	manager := seedVoiceUserWithRole(t, database, "pw-manager", 30)
	admin := seedVoiceOwner(t, database, "pw-admin")

	for _, u := range []*db.User{manager, admin} {
		c, send := connectPasswordClient(t, hub, u, chanID)
		if code := tryJoin(hub, c, send, chanID, ""); code != "" || !inVoiceChannel(t, database, u.ID, chanID) {
			t.Fatalf("%s: code %q, in channel %v", u.Username, code, inVoiceChannel(t, database, u.ID, chanID))
		}
		if hasGrant(t, database, chanID, u.ID) {
			t.Fatalf("%s skipped the password and needs no grant", u.Username)
		}
	}
}

func TestVoiceJoinPassword_RateLimitedPerUserAndChannel(t *testing.T) {
	hub, database, limiter := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-limit")
	otherID := seedVoiceChan(t, database, "pw-limit-other")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	protectVoiceChannel(t, database, otherID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-limit-user")
	c, send := connectPasswordClient(t, hub, user, chanID)

	key := auth.Key(auth.Key("voice_join_password", user.ID), chanID)
	for i := range 5 {
		if !limiter.Allow(key, 5, time.Minute) {
			t.Fatalf("attempt %d should have been allowed", i+1)
		}
	}
	// Even the right password is refused while the bucket is full, and no
	// grant is stored.
	if code := tryJoin(hub, c, send, chanID, joinPasswordSecret); code != "RATE_LIMITED" {
		t.Fatalf("sixth attempt answered %q, want RATE_LIMITED", code)
	}
	if hasGrant(t, database, chanID, user.ID) {
		t.Fatal("a rate-limited attempt must not store a grant")
	}
	// The bucket is per channel.
	time.Sleep(1100 * time.Millisecond) // past the voice_join bucket (5 per second)
	if code := tryJoin(hub, c, send, otherID, joinPasswordSecret); code != "" {
		t.Fatalf("another channel answered %q", code)
	}
}

func TestVoiceJoinPassword_RemovingPasswordOpensChannel(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-removed")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-removed-user")
	c, send := connectPasswordClient(t, hub, user, chanID)
	if code := tryJoin(hub, c, send, chanID, ""); code != "PASSWORD_REQUIRED" {
		t.Fatalf("code = %q, want PASSWORD_REQUIRED", code)
	}

	unprotectVoiceChannel(t, database, chanID)
	if code := tryJoin(hub, c, send, chanID, ""); code != "" || !inVoiceChannel(t, database, user.ID, chanID) {
		t.Fatalf("after removal: code %q, in channel %v", code, inVoiceChannel(t, database, user.ID, chanID))
	}
}

func TestVoiceJoinPassword_ModeratorMoveIntoProtectedChannel(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	fromID := seedVoiceChan(t, database, "pw-move-from")
	toID := seedVoiceChan(t, database, "pw-move-to")
	protectVoiceChannel(t, database, toID, joinPasswordSecret)
	actor := seedVoiceUserWithRole(t, database, "pw-move-actor", int(permissions.OwnerRoleID))
	target := seedVoiceMember(t, database, "pw-move-target")

	tc, tsend := connectPasswordClient(t, hub, target, fromID)
	if code := tryJoin(hub, tc, tsend, fromID, ""); code != "" {
		t.Fatalf("target join answered %q", code)
	}
	ac, asend := connectPasswordClient(t, hub, actor, fromID)
	hub.HandleMessageForTest(ac, voiceModMoveMsg(target.ID, toID))
	if code := receiveErrorCode(asend, 100*time.Millisecond); code != "" {
		t.Fatalf("move answered %q", code)
	}

	// The target's client answers voice_moved with an ordinary voice_join, sent
	// without a password.
	if code := tryJoin(hub, tc, tsend, toID, ""); code != "" || !inVoiceChannel(t, database, target.ID, toID) {
		t.Fatalf("moved member's rejoin: code %q, in channel %v", code, inVoiceChannel(t, database, target.ID, toID))
	}
}

func TestVoiceJoinPassword_PayloadsNeverCarryTheHash(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-payload")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	ch, err := database.GetChannel(context.Background(), chanID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if !ch.PasswordProtected {
		t.Fatal("channel row must say it is password protected")
	}
	raw, _ := json.Marshal(ch)
	if strings.Contains(string(raw), "$2a$") || strings.Contains(string(raw), "password_hash") {
		t.Fatalf("channel JSON leaks the hash: %s", raw)
	}

	user := seedVoiceMember(t, database, "pw-payload-user")
	_, send := connectPasswordClient(t, hub, user, chanID)
	hub.BroadcastChannelUpdate(ch)
	var update map[string]any
	for _, m := range drainChanTimeout(send, 100*time.Millisecond) {
		if strings.Contains(string(m), "$2a$") || strings.Contains(string(m), "password_hash") {
			t.Fatalf("frame leaks the hash: %s", m)
		}
		var env struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "channel_update" {
			update = env.Payload
		}
	}
	if update == nil || update["password_protected"] != true {
		t.Fatalf("channel_update payload = %v, want password_protected true", update)
	}

	unprotectVoiceChannel(t, database, chanID)
	ch, _ = database.GetChannel(context.Background(), chanID)
	hub.BroadcastChannelUpdate(ch)
	for _, m := range drainChanTimeout(send, 100*time.Millisecond) {
		var env struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "channel_update" && env.Payload["password_protected"] != false {
			t.Fatalf("unprotected channel_update = %v, want password_protected false", env.Payload)
		}
	}
}

// Attempts on different channels draw on one per-member budget.
func TestVoiceJoinPassword_PerUserBudgetSpansChannels(t *testing.T) {
	hub, database, limiter := newPasswordHub(t)
	a := seedVoiceChan(t, database, "pw-user-a")
	b := seedVoiceChan(t, database, "pw-user-b")
	protectVoiceChannel(t, database, a, joinPasswordSecret)
	protectVoiceChannel(t, database, b, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-user-budget")
	c, send := connectPasswordClient(t, hub, user, a)

	// Five tries on A and four on B, each channel inside its own limit.
	for range 5 {
		limiter.Allow(auth.Key(auth.Key("voice_join_password", user.ID), a), 5, time.Minute)
		limiter.Allow(auth.Key("voice_join_password_user", user.ID), 10, time.Minute)
	}
	for range 4 {
		limiter.Allow(auth.Key("voice_join_password_user", user.ID), 10, time.Minute)
	}
	// The tenth attempt is the last one allowed, on a fresh channel bucket.
	if code := tryJoin(hub, c, send, b, "nope"); code != "WRONG_PASSWORD" {
		t.Fatalf("tenth attempt answered %q, want WRONG_PASSWORD", code)
	}
	time.Sleep(1100 * time.Millisecond) // past the voice_join bucket
	if code := tryJoin(hub, c, send, b, joinPasswordSecret); code != "RATE_LIMITED" {
		t.Fatalf("eleventh attempt answered %q, want RATE_LIMITED", code)
	}
	if hasGrant(t, database, b, user.ID) {
		t.Fatal("a rate-limited attempt must not store a grant")
	}
}

func TestVoiceJoinPassword_ServerWideBackstop(t *testing.T) {
	hub, database, limiter := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-backstop")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	user := seedVoiceMember(t, database, "pw-backstop-user")
	c, send := connectPasswordClient(t, hub, user, chanID)

	for range 60 {
		limiter.Allow("voice_join_password_all", 60, time.Minute)
	}
	if code := tryJoin(hub, c, send, chanID, joinPasswordSecret); code != "RATE_LIMITED" {
		t.Fatalf("code = %q, want RATE_LIMITED", code)
	}
}

// The gate comes after the role rules: a member who may not join the channel
// is told so, not asked for a password.
func TestVoiceJoinPassword_RoleRulesAnswerFirst(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	chanID := seedVoiceChan(t, database, "pw-gate-order")
	protectVoiceChannel(t, database, chanID, joinPasswordSecret)
	cases := map[string]int64{
		"no CONNECT_VOICE": permissions.ReadMessages,
		"no READ_MESSAGES": permissions.ConnectVoice,
	}
	roleID := 40
	for name, perms := range cases {
		roleID++
		if _, err := database.ExecContext(context.Background(),
			`INSERT INTO roles (id, name, permissions, position, is_default) VALUES (?, ?, ?, 10, 0)`,
			roleID, name, perms); err != nil {
			t.Fatal(err)
		}
		user := seedVoiceUserWithRole(t, database, "pw-gate-"+strings.ReplaceAll(name, " ", "-"), roleID)
		c, send := connectPasswordClient(t, hub, user, chanID)
		for _, pw := range []string{"", joinPasswordSecret} {
			if code := tryJoin(hub, c, send, chanID, pw); code != "FORBIDDEN" {
				t.Errorf("%s (password %q): code = %q, want FORBIDDEN", name, pw, code)
			}
		}
	}
}

// A move that does not happen leaves no grant behind.
func TestVoiceJoinPassword_FailedModeratorMoveStoresNoGrant(t *testing.T) {
	hub, database, _ := newPasswordHub(t)
	fromID := seedVoiceChan(t, database, "pw-nomove-from")
	toID := seedVoiceChan(t, database, "pw-nomove-to")
	protectVoiceChannel(t, database, toID, joinPasswordSecret)
	actor := seedVoiceUserWithRole(t, database, "pw-nomove-actor", int(permissions.OwnerRoleID))
	target := seedVoiceMember(t, database, "pw-nomove-target")
	// A voice row with no live connection behind it.
	if err := database.JoinVoiceChannel(context.Background(), target.ID, fromID); err != nil {
		t.Fatal(err)
	}
	ac, asend := connectPasswordClient(t, hub, actor, fromID)

	hub.HandleMessageForTest(ac, voiceModMoveMsg(target.ID, toID))
	if code := receiveErrorCode(asend, 200*time.Millisecond); code != "VOICE_ERROR" {
		t.Fatalf("move answered %q, want VOICE_ERROR", code)
	}
	if hasGrant(t, database, toID, target.ID) {
		t.Fatal("a move that evicted nobody stored a grant")
	}
}
