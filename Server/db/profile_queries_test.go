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
