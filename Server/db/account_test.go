package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/owncord/server/db"
)

// ─── DeleteAccount — last admin guard ────────────────────────────────────────

func TestDeleteAccount_LastOwnerBlocked(t *testing.T) {
	database := openMigratedMemory(t)
	// Create a single owner (role_id=1). No other admins exist.
	ownerID := seedUser(t, database, "owner")
	setRole(t, database, ownerID, 1) // Owner

	err := database.DeleteAccount(context.Background(), ownerID)
	if !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("DeleteAccount(last owner) = %v, want ErrLastAdmin", err)
	}
}

func TestDeleteAccount_LastAdminBlocked(t *testing.T) {
	database := openMigratedMemory(t)
	adminID := seedUser(t, database, "admin")
	setRole(t, database, adminID, 2) // Admin

	err := database.DeleteAccount(context.Background(), adminID)
	if !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("DeleteAccount(last admin) = %v, want ErrLastAdmin", err)
	}
}

func TestDeleteAccount_AllowedWhenOtherAdminExists(t *testing.T) {
	database := openMigratedMemory(t)
	admin1 := seedUser(t, database, "admin1")
	admin2 := seedUser(t, database, "admin2")
	setRole(t, database, admin1, 2) // Admin
	setRole(t, database, admin2, 2) // Admin

	err := database.DeleteAccount(context.Background(), admin1)
	if err != nil {
		t.Fatalf("DeleteAccount with another admin present: %v", err)
	}
}

func TestDeleteAccount_AdminAllowedWhenOwnerExists(t *testing.T) {
	database := openMigratedMemory(t)
	ownerID := seedUser(t, database, "owner")
	adminID := seedUser(t, database, "admin")
	setRole(t, database, ownerID, 1) // Owner
	setRole(t, database, adminID, 2) // Admin

	// Admin can delete because owner still exists.
	err := database.DeleteAccount(context.Background(), adminID)
	if err != nil {
		t.Fatalf("DeleteAccount(admin with owner present): %v", err)
	}
}

// ─── DeleteAccount — member deletion ─────────────────────────────────────────

func TestDeleteAccount_MemberSucceeds(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice") // default role_id=4

	err := database.DeleteAccount(context.Background(), userID)
	if err != nil {
		t.Fatalf("DeleteAccount(member): %v", err)
	}
}

// ─── DeleteAccount — anonymisation ───────────────────────────────────────────

func TestDeleteAccount_AnonymisesUsername(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice")

	if err := database.DeleteAccount(context.Background(), userID); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	user, err := database.GetUserByID(userID)
	if err != nil {
		t.Fatalf("GetUserByID after delete: %v", err)
	}

	expected := fmt.Sprintf("[deleted-%d]", userID)
	if user.Username != expected {
		t.Errorf("Username = %q, want %q", user.Username, expected)
	}
}

func TestDeleteAccount_ClearsPassword(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "bob")

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	user, _ := database.GetUserByID(userID)
	if user.PasswordHash != "" {
		t.Errorf("PasswordHash = %q, want empty", user.PasswordHash)
	}
}

func TestDeleteAccount_ClearsAvatarAndTOTP(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "charlie")

	// Set avatar and TOTP before deletion.
	database.Exec("UPDATE users SET avatar = 'pic.png', totp_secret = 'SECRET' WHERE id = ?", userID) //nolint:errcheck

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	user, _ := database.GetUserByID(userID)
	if user.Avatar != nil {
		t.Errorf("Avatar = %v, want nil", user.Avatar)
	}
	if user.TOTPSecret != nil {
		t.Errorf("TOTPSecret = %v, want nil", user.TOTPSecret)
	}
}

func TestDeleteAccount_SetsBannedAndOffline(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "dave")

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	user, _ := database.GetUserByID(userID)
	if !user.Banned {
		t.Error("Banned should be true after deletion")
	}
	if user.Status != "offline" {
		t.Errorf("Status = %q, want 'offline'", user.Status)
	}
}

// ─── DeleteAccount — related data cleanup ────────────────────────────────────

func TestDeleteAccount_DeletesSessions(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "eve")

	// Insert a session directly.
	database.Exec(
		"INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'tok123', datetime('now', '+1 day'))",
		userID,
	) //nolint:errcheck

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	var count int
	database.QueryRow("SELECT COUNT(*) FROM sessions WHERE user_id = ?", userID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("sessions count = %d, want 0", count)
	}
}

func TestDeleteAccount_SoftDeletesMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "frank")
	chID := seedChannel(t, database, "general")

	msgID, _ := database.CreateMessage(chID, userID, "hello world", nil)

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	msg, err := database.GetMessage(msgID)
	if err != nil {
		t.Fatalf("GetMessage after delete: %v", err)
	}
	if !msg.Deleted {
		t.Error("message should be soft-deleted")
	}
	if msg.Content != "" {
		t.Errorf("message content = %q, want empty", msg.Content)
	}
}

func TestDeleteAccount_NonexistentUser(t *testing.T) {
	database := openMigratedMemory(t)

	err := database.DeleteAccount(context.Background(), 999999)
	if err == nil {
		t.Error("DeleteAccount(nonexistent) should return error")
	}
}

// ─── Helper ──────────────────────────────────────────────────────────────────

func setRole(t *testing.T, database *db.DB, userID, roleID int64) {
	t.Helper()
	if _, err := database.Exec("UPDATE users SET role_id = ? WHERE id = ?", roleID, userID); err != nil {
		t.Fatalf("setRole(%d, %d): %v", userID, roleID, err)
	}
}
