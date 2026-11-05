package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── UpdateUserProfile tests ─────────────────────────────────────────────────

func TestUpdateUserProfile_UsernameAndAvatar(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	id := mustCreateUser(t, database, "profileuser", "hash", 4)

	avatar := "https://example.com/avatar.png"
	mustDo(t, "UpdateUserProfile", database.UpdateUserProfile(context.Background(), id, "newname", &avatar, nil, nil, nil, nil))

	user := mustGetUserByID(t, database, id)
	if user.Username != "newname" {
		t.Errorf("Username = %q, want %q", user.Username, "newname")
	}
	if user.Avatar == nil || *user.Avatar != avatar {
		t.Errorf("Avatar = %v, want %q", user.Avatar, avatar)
	}
}

func TestUpdateUserProfile_UsernameOnly(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	id, _ := database.CreateUser(context.Background(), "keepavatar", "hash", 4)

	mustDo(t, "UpdateUserProfile", database.UpdateUserProfile(context.Background(), id, "renamed", nil, nil, nil, nil, nil))

	user, _ := database.GetUserByID(context.Background(), id)
	if user.Username != "renamed" {
		t.Errorf("Username = %q, want %q", user.Username, "renamed")
	}
	if user.Avatar != nil {
		t.Errorf("Avatar = %v, want nil", user.Avatar)
	}
}

func TestUpdateUserProfile_DuplicateUsername(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	database.CreateUser(context.Background(), "existing", "hash", 4)
	id2, _ := database.CreateUser(context.Background(), "changeme", "hash", 4)

	err := database.UpdateUserProfile(context.Background(), id2, "existing", nil, nil, nil, nil, nil)
	if err == nil {
		t.Error("UpdateUserProfile with duplicate username should return error")
	}
}

func TestUpdateUserProfile_NonExistentUser(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	err := database.UpdateUserProfile(context.Background(), 99999, "ghost", nil, nil, nil, nil, nil)
	if err == nil {
		t.Error("UpdateUserProfile for non-existent user should return error")
	}
}

// ─── UpdateUserPassword tests ────────────────────────────────────────────────

func TestUpdateUserPassword_Success(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	id, _ := database.CreateUser(context.Background(), "pwuser", "oldhash", 4)

	mustDo(t, "UpdateUserPassword", database.UpdateUserPassword(context.Background(), id, "newhash"))

	user, _ := database.GetUserByID(context.Background(), id)
	if user.PasswordHash != "newhash" {
		t.Errorf("PasswordHash = %q, want %q", user.PasswordHash, "newhash")
	}
}

// ─── ListUserSessions tests ─────────────────────────────────────────────────

func TestListUserSessions_ReturnsSessions(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	uid, _ := database.CreateUser(context.Background(), "sessuser", "hash", 4)

	database.CreateSession(context.Background(), uid, "tok1", "Chrome", "1.2.3.4")
	database.CreateSession(context.Background(), uid, "tok2", "Firefox", "5.6.7.8")

	sessions, err := database.ListUserSessions(context.Background(), uid)
	mustDo(t, "ListUserSessions", err)
	if len(sessions) != 2 {
		t.Errorf("len(sessions) = %d, want 2", len(sessions))
	}
}

func TestListUserSessions_EmptyArray(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	uid, _ := database.CreateUser(context.Background(), "nosess", "hash", 4)

	sessions, err := database.ListUserSessions(context.Background(), uid)
	mustDo(t, "ListUserSessions", err)
	if sessions == nil {
		t.Error("ListUserSessions should return empty slice, not nil")
	}
	if len(sessions) != 0 {
		t.Errorf("len(sessions) = %d, want 0", len(sessions))
	}
}

func TestListUserSessions_DoesNotReturnOtherUsers(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	uid1, _ := database.CreateUser(context.Background(), "user1", "hash", 4)
	uid2, _ := database.CreateUser(context.Background(), "user2", "hash", 4)

	database.CreateSession(context.Background(), uid1, "tok-u1", "Chrome", "1.2.3.4")
	database.CreateSession(context.Background(), uid2, "tok-u2", "Firefox", "5.6.7.8")

	sessions, _ := database.ListUserSessions(context.Background(), uid1)
	if len(sessions) != 1 {
		t.Errorf("len(sessions) = %d, want 1", len(sessions))
	}
}

// ─── SignOutEverywhere tests (B4-7, sign-out-everywhere) ─────────────────────

func TestSignOutEverywhere_RevokesEveryOneOfTheUsersOnly(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice, _ := database.CreateUser(ctx, "alice-all", "hash", 4)
	bob, _ := database.CreateUser(ctx, "bob-all", "hash", 4)
	database.CreateSession(ctx, alice, "alice-a", "Chrome", "1.2.3.4")
	database.CreateSession(ctx, bob, "bob-a", "Firefox", "5.6.7.8")
	database.CreateSession(ctx, alice, "alice-b", "Phone", "9.9.9.9")
	if _, err := database.CreateAPIToken(ctx, alice, "alice-tok", "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	if _, err := database.CreateAPIToken(ctx, bob, "bob-tok", "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	sessions, tokens, err := database.SignOutEverywhere(ctx, alice)
	mustDo(t, "SignOutEverywhere", err)
	if sessions != 2 || tokens != 1 {
		t.Fatalf("revoked = (%d sessions, %d tokens), want (2, 1)", sessions, tokens)
	}
	if left, _ := database.ListUserSessions(ctx, alice); len(left) != 0 {
		t.Errorf("alice still has %d session(s)", len(left))
	}
	if tok, _ := database.GetActiveAPIToken(ctx, "alice-tok"); tok != nil {
		t.Error("alice's API token is still active")
	}
	if left, _ := database.ListUserSessions(ctx, bob); len(left) != 1 {
		t.Errorf("bob has %d session(s), want 1 untouched", len(left))
	}
	if tok, _ := database.GetActiveAPIToken(ctx, "bob-tok"); tok == nil {
		t.Error("bob's API token was revoked")
	}

	// Nothing left to revoke is not an error, just zero.
	sessions, tokens, err = database.SignOutEverywhere(ctx, alice)
	if err != nil || sessions != 0 || tokens != 0 {
		t.Fatalf("second SignOutEverywhere = (%d, %d, %v), want (0, 0, nil)", sessions, tokens, err)
	}
}

// A failure deleting the sessions leaves the API tokens live too: the two
// revocations commit together or not at all.
func TestSignOutEverywhere_RollsBackAsAWhole(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid, _ := database.CreateUser(ctx, "unlucky-all", "hash", 4)
	if _, err := database.CreateSession(ctx, uid, "tok-live", "laptop", "10.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := database.CreateAPIToken(ctx, uid, "api-live", "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		"CREATE TRIGGER fault_delete_sessions BEFORE DELETE ON sessions BEGIN SELECT RAISE(FAIL, 'injected fault'); END"); err != nil {
		t.Fatalf("install fault: %v", err)
	}
	if _, _, err := database.SignOutEverywhere(ctx, uid); err == nil {
		t.Fatal("SignOutEverywhere succeeded through an injected session-delete failure")
	}
	if tok, _ := database.GetActiveAPIToken(ctx, "api-live"); tok == nil {
		t.Error("the API token was revoked by a sign-out-everywhere that failed")
	}
	if left, _ := database.ListUserSessions(ctx, uid); len(left) != 1 {
		t.Errorf("sessions = %d, want the live one kept", len(left))
	}
}

// ─── DeleteSessionByID tests ─────────────────────────────────────────────────

func TestDeleteSessionByID_Success(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	uid, _ := database.CreateUser(context.Background(), "delsess", "hash", 4)
	sessID, _ := database.CreateSession(context.Background(), uid, "deltok", "Chrome", "1.2.3.4")

	err := database.DeleteSessionByID(context.Background(), sessID, uid)
	mustDo(t, "DeleteSessionByID", err)

	// Session should be gone.
	sess, _ := database.GetSessionByTokenHash(context.Background(), "deltok")
	if sess != nil {
		t.Error("session should have been deleted")
	}
}

func TestDeleteSessionByID_WrongOwner(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	uid1, _ := database.CreateUser(context.Background(), "owner1", "hash", 4)
	uid2, _ := database.CreateUser(context.Background(), "owner2", "hash", 4)
	sessID, _ := database.CreateSession(context.Background(), uid1, "ownertok", "Chrome", "1.2.3.4")

	err := database.DeleteSessionByID(context.Background(), sessID, uid2)
	if err == nil {
		t.Error("DeleteSessionByID should fail when user does not own the session")
	}
}

func TestDeleteSessionByID_NotFound(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	uid, _ := database.CreateUser(context.Background(), "delnf", "hash", 4)

	err := database.DeleteSessionByID(context.Background(), 99999, uid)
	if err == nil {
		t.Error("DeleteSessionByID should fail for non-existent session")
	}
}

// B4-7's new-login signal: a session created by a login is the account's
// unseen new login until another device lists sessions, and the device that
// signed in never acknowledges itself.
func TestMarkSessionsSeen_AcknowledgesEveryLoginButTheCallers(t *testing.T) {
	database := newSchemaTestDB(t, testSchema)
	ctx := context.Background()
	uid := mustCreateUser(t, database, "seenuser", "hash", 4)
	other := mustCreateUser(t, database, "otheruser", "hash", 4)
	login := func(t *testing.T, userID int64, tokenHash, device string) int64 {
		t.Helper()
		id, err := database.CreateSession(ctx, userID, tokenHash, device, "10.0.0.1")
		if err != nil {
			t.Fatalf("CreateSession(%s): %v", device, err)
		}
		return id
	}
	laptop := login(t, uid, "hash-laptop", "Laptop")
	phone := login(t, uid, "hash-phone", "Phone")
	tablet := login(t, other, "hash-tablet", "Tablet")

	unseen := func(t *testing.T, userID int64) map[int64]bool {
		t.Helper()
		sessions, err := database.ListUserSessions(ctx, userID)
		mustDo(t, "ListUserSessions", err)
		flags := make(map[int64]bool, len(sessions))
		for _, s := range sessions {
			flags[s.ID] = s.Unseen
		}
		return flags
	}

	if got := unseen(t, uid); !got[laptop] || !got[phone] {
		t.Fatalf("logins should start unseen, got %v", got)
	}

	// The phone lists: it acknowledges the laptop's login, never its own.
	n, err := database.MarkSessionsSeen(ctx, uid, phone)
	mustDo(t, "MarkSessionsSeen(phone)", err)
	if n != 1 {
		t.Errorf("rows acknowledged = %d, want 1", n)
	}
	if got := unseen(t, uid); got[laptop] || !got[phone] {
		t.Errorf("after the phone lists: laptop unseen = %v, phone unseen = %v; want false, true", got[laptop], got[phone])
	}
	if got := unseen(t, other); !got[tablet] {
		t.Error("another account's login was acknowledged")
	}

	// Listing again from the phone changes nothing; the laptop's listing
	// acknowledges the phone.
	if n, err := database.MarkSessionsSeen(ctx, uid, phone); err != nil || n != 0 {
		t.Errorf("second MarkSessionsSeen(phone) = %d, %v; want 0, nil", n, err)
	}
	if _, err := database.MarkSessionsSeen(ctx, uid, laptop); err != nil {
		t.Fatalf("MarkSessionsSeen(laptop): %v", err)
	}
	if got := unseen(t, uid); got[phone] {
		t.Error("the laptop's listing should have acknowledged the phone's login")
	}

	// An API-token principal holds no session and acknowledges every row.
	extra := login(t, uid, "hash-extra", "Desktop")
	if _, err := database.MarkSessionsSeen(ctx, uid, 0); err != nil {
		t.Fatalf("MarkSessionsSeen(0): %v", err)
	}
	if got := unseen(t, uid); got[extra] {
		t.Error("session id 0 should acknowledge every row")
	}

	// The token lookup carries the flag too.
	sess, err := database.GetSessionByTokenHash(ctx, "hash-tablet")
	if err != nil || sess == nil {
		t.Fatalf("GetSessionByTokenHash: %v, %v", sess, err)
	}
	if !sess.Unseen {
		t.Error("GetSessionByTokenHash dropped the unseen flag")
	}
}

// The profile and the identity key commit together: a username clash fails
// the whole write, so the key is not published either; a clean write stores
// both.
func TestUpdateUserProfileAndIdentityKey_AllOrNothing(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "pk-alice")
	seedUser(t, database, "pk-bob")

	err := database.UpdateUserProfileAndIdentityKey(ctx, uid, "pk-bob", nil, nil, nil, nil, nil, "key-one")
	if !db.IsUniqueConstraintError(err) {
		t.Fatalf("clash err = %v, want a unique constraint error", err)
	}
	u := mustGetUserByID(t, database, uid)
	if u.Username != "pk-alice" || u.IdentityPublicKey != nil {
		t.Fatalf("after the failed write: username %q, key %v; want unchanged and no key", u.Username, u.IdentityPublicKey)
	}

	mustDo(t, "UpdateUserProfileAndIdentityKey", database.UpdateUserProfileAndIdentityKey(ctx, uid, "pk-alice2", nil, nil, nil, nil, nil, "key-two"))
	u = mustGetUserByID(t, database, uid)
	if u.Username != "pk-alice2" || u.IdentityPublicKey == nil || *u.IdentityPublicKey != "key-two" {
		t.Fatalf("after the write: username %q, key %v; want both stored", u.Username, u.IdentityPublicKey)
	}

	if err := database.UpdateUserProfileAndIdentityKey(ctx, 999999, "ghost", nil, nil, nil, nil, nil, "k"); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("missing user err = %v, want ErrNotFound", err)
	}
}
