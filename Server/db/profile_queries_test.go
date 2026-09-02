package db_test

import (
	"context"
	"testing"
)

// ─── UpdateUserProfile tests ─────────────────────────────────────────────────

func TestUpdateUserProfile_UsernameAndAvatar(t *testing.T) {
	database := newTestDB(t)
	id, err := database.CreateUser(context.Background(), "profileuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	avatar := "https://example.com/avatar.png"
	if err := database.UpdateUserProfile(context.Background(), id, "newname", &avatar, nil, nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}

	user, err := database.GetUserByID(context.Background(), id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if user.Username != "newname" {
		t.Errorf("Username = %q, want %q", user.Username, "newname")
	}
	if user.Avatar == nil || *user.Avatar != avatar {
		t.Errorf("Avatar = %v, want %q", user.Avatar, avatar)
	}
}

func TestUpdateUserProfile_UsernameOnly(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "keepavatar", "hash", 4)

	if err := database.UpdateUserProfile(context.Background(), id, "renamed", nil, nil, nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}

	user, _ := database.GetUserByID(context.Background(), id)
	if user.Username != "renamed" {
		t.Errorf("Username = %q, want %q", user.Username, "renamed")
	}
	if user.Avatar != nil {
		t.Errorf("Avatar = %v, want nil", user.Avatar)
	}
}

func TestUpdateUserProfile_DuplicateUsername(t *testing.T) {
	database := newTestDB(t)
	database.CreateUser(context.Background(), "existing", "hash", 4)
	id2, _ := database.CreateUser(context.Background(), "changeme", "hash", 4)

	err := database.UpdateUserProfile(context.Background(), id2, "existing", nil, nil, nil)
	if err == nil {
		t.Error("UpdateUserProfile with duplicate username should return error")
	}
}

func TestUpdateUserProfile_NonExistentUser(t *testing.T) {
	database := newTestDB(t)
	err := database.UpdateUserProfile(context.Background(), 99999, "ghost", nil, nil, nil)
	if err == nil {
		t.Error("UpdateUserProfile for non-existent user should return error")
	}
}

// ─── UpdateUserPassword tests ────────────────────────────────────────────────

func TestUpdateUserPassword_Success(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser(context.Background(), "pwuser", "oldhash", 4)

	if err := database.UpdateUserPassword(context.Background(), id, "newhash"); err != nil {
		t.Fatalf("UpdateUserPassword: %v", err)
	}

	user, _ := database.GetUserByID(context.Background(), id)
	if user.PasswordHash != "newhash" {
		t.Errorf("PasswordHash = %q, want %q", user.PasswordHash, "newhash")
	}
}

// ─── ListUserSessions tests ─────────────────────────────────────────────────

func TestListUserSessions_ReturnsSessions(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "sessuser", "hash", 4)

	database.CreateSession(context.Background(), uid, "tok1", "Chrome", "1.2.3.4")
	database.CreateSession(context.Background(), uid, "tok2", "Firefox", "5.6.7.8")

	sessions, err := database.ListUserSessions(context.Background(), uid)
	if err != nil {
		t.Fatalf("ListUserSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("len(sessions) = %d, want 2", len(sessions))
	}
}

func TestListUserSessions_EmptyArray(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "nosess", "hash", 4)

	sessions, err := database.ListUserSessions(context.Background(), uid)
	if err != nil {
		t.Fatalf("ListUserSessions: %v", err)
	}
	if sessions == nil {
		t.Error("ListUserSessions should return empty slice, not nil")
	}
	if len(sessions) != 0 {
		t.Errorf("len(sessions) = %d, want 0", len(sessions))
	}
}

func TestListUserSessions_DoesNotReturnOtherUsers(t *testing.T) {
	database := newTestDB(t)
	uid1, _ := database.CreateUser(context.Background(), "user1", "hash", 4)
	uid2, _ := database.CreateUser(context.Background(), "user2", "hash", 4)

	database.CreateSession(context.Background(), uid1, "tok-u1", "Chrome", "1.2.3.4")
	database.CreateSession(context.Background(), uid2, "tok-u2", "Firefox", "5.6.7.8")

	sessions, _ := database.ListUserSessions(context.Background(), uid1)
	if len(sessions) != 1 {
		t.Errorf("len(sessions) = %d, want 1", len(sessions))
	}
}

// ─── DeleteUserSessions tests (B4-7, sign-out-everywhere) ────────────────────

func TestDeleteUserSessions_RemovesEveryOneOfTheUsersOnly(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	alice, _ := database.CreateUser(ctx, "alice-all", "hash", 4)
	bob, _ := database.CreateUser(ctx, "bob-all", "hash", 4)
	database.CreateSession(ctx, alice, "alice-a", "Chrome", "1.2.3.4")
	database.CreateSession(ctx, bob, "bob-a", "Firefox", "5.6.7.8")
	database.CreateSession(ctx, alice, "alice-b", "Phone", "9.9.9.9")

	n, err := database.DeleteUserSessions(ctx, alice)
	if err != nil {
		t.Fatalf("DeleteUserSessions: %v", err)
	}
	if n != 2 {
		t.Fatalf("revoked = %d, want 2", n)
	}
	if left, _ := database.ListUserSessions(ctx, alice); len(left) != 0 {
		t.Errorf("alice still has %d session(s)", len(left))
	}
	if left, _ := database.ListUserSessions(ctx, bob); len(left) != 1 {
		t.Errorf("bob has %d session(s), want 1 untouched", len(left))
	}

	// Nothing left to revoke is not an error, just zero.
	n, err = database.DeleteUserSessions(ctx, alice)
	if err != nil || n != 0 {
		t.Fatalf("second DeleteUserSessions = (%d, %v), want (0, nil)", n, err)
	}
}

// ─── DeleteSessionByID tests ─────────────────────────────────────────────────

func TestDeleteSessionByID_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser(context.Background(), "delsess", "hash", 4)
	sessID, _ := database.CreateSession(context.Background(), uid, "deltok", "Chrome", "1.2.3.4")

	err := database.DeleteSessionByID(context.Background(), sessID, uid)
	if err != nil {
		t.Fatalf("DeleteSessionByID: %v", err)
	}

	// Session should be gone.
	sess, _ := database.GetSessionByTokenHash(context.Background(), "deltok")
	if sess != nil {
		t.Error("session should have been deleted")
	}
}

func TestDeleteSessionByID_WrongOwner(t *testing.T) {
	database := newTestDB(t)
	uid1, _ := database.CreateUser(context.Background(), "owner1", "hash", 4)
	uid2, _ := database.CreateUser(context.Background(), "owner2", "hash", 4)
	sessID, _ := database.CreateSession(context.Background(), uid1, "ownertok", "Chrome", "1.2.3.4")

	err := database.DeleteSessionByID(context.Background(), sessID, uid2)
	if err == nil {
		t.Error("DeleteSessionByID should fail when user does not own the session")
	}
}

func TestDeleteSessionByID_NotFound(t *testing.T) {
	database := newTestDB(t)
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
	database := newTestDB(t)
	ctx := context.Background()
	uid, err := database.CreateUser(ctx, "seenuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	other, err := database.CreateUser(ctx, "otheruser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(other): %v", err)
	}
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
		if err != nil {
			t.Fatalf("ListUserSessions: %v", err)
		}
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
	if err != nil {
		t.Fatalf("MarkSessionsSeen(phone): %v", err)
	}
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
