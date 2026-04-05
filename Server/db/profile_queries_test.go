package db_test

import (
	"testing"
)

// ─── UpdateUserProfile tests ─────────────────────────────────────────────────

func TestUpdateUserProfile_UsernameAndAvatar(t *testing.T) {
	database := newTestDB(t)
	id, err := database.CreateUser("profileuser", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	avatar := "https://example.com/avatar.png"
	if err := database.UpdateUserProfile(id, "newname", &avatar); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}

	user, err := database.GetUserByID(id)
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
	id, _ := database.CreateUser("keepavatar", "hash", 4)

	if err := database.UpdateUserProfile(id, "renamed", nil); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}

	user, _ := database.GetUserByID(id)
	if user.Username != "renamed" {
		t.Errorf("Username = %q, want %q", user.Username, "renamed")
	}
	if user.Avatar != nil {
		t.Errorf("Avatar = %v, want nil", user.Avatar)
	}
}

func TestUpdateUserProfile_DuplicateUsername(t *testing.T) {
	database := newTestDB(t)
	database.CreateUser("existing", "hash", 4)
	id2, _ := database.CreateUser("changeme", "hash", 4)

	err := database.UpdateUserProfile(id2, "existing", nil)
	if err == nil {
		t.Error("UpdateUserProfile with duplicate username should return error")
	}
}

func TestUpdateUserProfile_NonExistentUser(t *testing.T) {
	database := newTestDB(t)
	err := database.UpdateUserProfile(99999, "ghost", nil)
	if err == nil {
		t.Error("UpdateUserProfile for non-existent user should return error")
	}
}

// ─── UpdateUserPassword tests ────────────────────────────────────────────────

func TestUpdateUserPassword_Success(t *testing.T) {
	database := newTestDB(t)
	id, _ := database.CreateUser("pwuser", "oldhash", 4)

	if err := database.UpdateUserPassword(id, "newhash"); err != nil {
		t.Fatalf("UpdateUserPassword: %v", err)
	}

	user, _ := database.GetUserByID(id)
	if user.PasswordHash != "newhash" {
		t.Errorf("PasswordHash = %q, want %q", user.PasswordHash, "newhash")
	}
}

// ─── ListUserSessions tests ─────────────────────────────────────────────────

func TestListUserSessions_ReturnsSessions(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("sessuser", "hash", 4)

	database.CreateSession(uid, "tok1", "Chrome", "1.2.3.4")
	database.CreateSession(uid, "tok2", "Firefox", "5.6.7.8")

	sessions, err := database.ListUserSessions(uid)
	if err != nil {
		t.Fatalf("ListUserSessions: %v", err)
	}
	if len(sessions) != 2 {
		t.Errorf("len(sessions) = %d, want 2", len(sessions))
	}
}

func TestListUserSessions_EmptyArray(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("nosess", "hash", 4)

	sessions, err := database.ListUserSessions(uid)
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
	uid1, _ := database.CreateUser("user1", "hash", 4)
	uid2, _ := database.CreateUser("user2", "hash", 4)

	database.CreateSession(uid1, "tok-u1", "Chrome", "1.2.3.4")
	database.CreateSession(uid2, "tok-u2", "Firefox", "5.6.7.8")

	sessions, _ := database.ListUserSessions(uid1)
	if len(sessions) != 1 {
		t.Errorf("len(sessions) = %d, want 1", len(sessions))
	}
}

// ─── DeleteSessionByID tests ─────────────────────────────────────────────────

func TestDeleteSessionByID_Success(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("delsess", "hash", 4)
	sessID, _ := database.CreateSession(uid, "deltok", "Chrome", "1.2.3.4")

	err := database.DeleteSessionByID(sessID, uid)
	if err != nil {
		t.Fatalf("DeleteSessionByID: %v", err)
	}

	// Session should be gone.
	sess, _ := database.GetSessionByTokenHash("deltok")
	if sess != nil {
		t.Error("session should have been deleted")
	}
}

func TestDeleteSessionByID_WrongOwner(t *testing.T) {
	database := newTestDB(t)
	uid1, _ := database.CreateUser("owner1", "hash", 4)
	uid2, _ := database.CreateUser("owner2", "hash", 4)
	sessID, _ := database.CreateSession(uid1, "ownertok", "Chrome", "1.2.3.4")

	err := database.DeleteSessionByID(sessID, uid2)
	if err == nil {
		t.Error("DeleteSessionByID should fail when user does not own the session")
	}
}

func TestDeleteSessionByID_NotFound(t *testing.T) {
	database := newTestDB(t)
	uid, _ := database.CreateUser("delnf", "hash", 4)

	err := database.DeleteSessionByID(99999, uid)
	if err == nil {
		t.Error("DeleteSessionByID should fail for non-existent session")
	}
}
