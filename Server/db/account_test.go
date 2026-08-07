package db_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

	user, err := database.GetUserByID(context.Background(), userID)
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

	user, _ := database.GetUserByID(context.Background(), userID)
	if user.PasswordHash != "" {
		t.Errorf("PasswordHash = %q, want empty", user.PasswordHash)
	}
}

func TestDeleteAccount_ClearsAvatarAndTOTP(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "charlie")

	// Set avatar and TOTP before deletion.
	database.ExecContext(context.Background(), "UPDATE users SET avatar = 'pic.png', totp_secret = 'SECRET' WHERE id = ?", userID) //nolint:errcheck

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	user, _ := database.GetUserByID(context.Background(), userID)
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

	user, _ := database.GetUserByID(context.Background(), userID)
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
	database.ExecContext(context.Background(),
		"INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'tok123', datetime('now', '+1 day'))",
		userID,
	) //nolint:errcheck

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	var count int
	database.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM sessions WHERE user_id = ?", userID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("sessions count = %d, want 0", count)
	}
}

func TestDeleteAccount_SoftDeletesMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "frank")
	chID := seedChannel(t, database, "general")

	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hello world", nil)

	database.DeleteAccount(context.Background(), userID) //nolint:errcheck

	msg, err := database.GetMessage(context.Background(), msgID)
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

// TestDeleteAccount_SquattedAnonNameStillDeletes locks the erasure path against
// a targeted denial of service: users.username is UNIQUE COLLATE NOCASE, so an
// attacker who renamed themselves to the victim's "[deleted-<id>]" made the
// anonymising UPDATE fail, rolled the whole transaction back, and left the
// victim permanently unable to delete their own account. auth.ValidateUsername
// now reserves the namespace, but DeleteAccount must survive a squatted name on
// its own — including one already in the database from before the rule existed.
func TestDeleteAccount_SquattedAnonNameStillDeletes(t *testing.T) {
	database := openMigratedMemory(t)
	victimID := seedUser(t, database, "victim")
	squatterID := seedUser(t, database, "squatter")

	squatted := fmt.Sprintf("[deleted-%d]", victimID)
	if _, err := database.ExecContext(context.Background(),
		"UPDATE users SET username = ? WHERE id = ?", squatted, squatterID,
	); err != nil {
		t.Fatalf("squat username: %v", err)
	}

	if err := database.DeleteAccount(context.Background(), victimID); err != nil {
		t.Fatalf("DeleteAccount must not be blockable by a squatted name: %v", err)
	}

	victim, err := database.GetUserByID(context.Background(), victimID)
	if err != nil || victim == nil {
		t.Fatalf("GetUserByID after delete: %v", err)
	}
	if strings.EqualFold(victim.Username, squatted) {
		t.Fatalf("victim kept the squatted name %q", victim.Username)
	}
	if !strings.HasPrefix(victim.Username, fmt.Sprintf("[deleted-%d-", victimID)) {
		t.Errorf("Username = %q, want a suffixed [deleted-%d-…] fallback", victim.Username, victimID)
	}
	// The erasure itself must still have happened.
	if !victim.Banned || victim.PasswordHash != "" {
		t.Errorf("account not anonymised: banned=%v password=%q", victim.Banned, victim.PasswordHash)
	}
}

// ─── DeleteAccount — canonical admin criterion, tokens, DM cleanup ───────────

func TestDeleteAccount_LastAdminGuard_SurvivesRoleRename(t *testing.T) {
	database := openMigratedMemory(t)
	// The Owner can rename the seeded Admin role (id=2); the guard must key
	// on the canonical role IDs, not the display name.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET name = 'Staff' WHERE id = 2`); err != nil {
		t.Fatalf("rename admin role: %v", err)
	}
	adminID := seedUser(t, database, "renamedadmin")
	setRole(t, database, adminID, 2)

	err := database.DeleteAccount(context.Background(), adminID)
	if !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("DeleteAccount(last holder of renamed admin role) = %v, want ErrLastAdmin", err)
	}
}

func TestDeleteAccount_RevokesAPITokensAndPermanentBan(t *testing.T) {
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "tokenuser")

	tokenHash := "testhash-tokenuser"
	if _, err := database.CreateAPIToken(context.Background(), uid, tokenHash, "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}
	// A previously lapsed temp ban left ban_expires in the past; combined
	// with banned=1 that reads as NOT banned (TestIsEffectivelyBanned_*).
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET ban_expires = '2020-01-01 00:00:00' WHERE id = ?`, uid); err != nil {
		t.Fatalf("set stale ban_expires: %v", err)
	}

	if err := database.DeleteAccount(context.Background(), uid); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	if tok, _ := database.GetActiveAPIToken(context.Background(), tokenHash); tok != nil {
		t.Error("API token still active after account deletion; want revoked")
	}
	var banExpires *string
	if err := database.QueryRowContext(context.Background(),
		`SELECT ban_expires FROM users WHERE id = ?`, uid).Scan(&banExpires); err != nil {
		t.Fatalf("read ban_expires: %v", err)
	}
	if banExpires != nil {
		t.Errorf("ban_expires = %q after deletion, want NULL (permanent ban)", *banExpires)
	}
}

func TestDeleteAccount_LastGroupDMParticipant_RemovesChannel(t *testing.T) {
	database := openMigratedMemory(t)
	userA := seedUser(t, database, "dmlast-a")
	userB := seedUser(t, database, "dmlast-b")
	userC := seedUser(t, database, "dmlast-c")

	ch, err := database.CreateGroupDMChannel(context.Background(), "grp", []int64{userA, userB, userC})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	if _, err := database.LeaveGroupDM(context.Background(), userB, ch.ID); err != nil {
		t.Fatalf("LeaveGroupDM(userB): %v", err)
	}
	if _, err := database.LeaveGroupDM(context.Background(), userC, ch.ID); err != nil {
		t.Fatalf("LeaveGroupDM(userC): %v", err)
	}

	// userA is now the last participant; deleting the account must apply
	// LeaveGroupDM's invariant — a participant-less DM channel is an
	// unreachable, undeletable row and must not survive.
	if err := database.DeleteAccount(context.Background(), userA); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	var count int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM channels WHERE id = ?`, ch.ID).Scan(&count); err != nil {
		t.Fatalf("count channels: %v", err)
	}
	if count != 0 {
		t.Errorf("group DM channel survived deletion of its last participant; want removed")
	}
}

// TestDeleteAccount_ClearsProfileFields locks the erasure path against a
// regression that leaves user-authored free text (nickname, bio, status
// line) and the E2EE identity key sitting in the row after "deletion" —
// DeleteAccount documents that "all personal data is removed", and an admin
// unban would otherwise republish this text to every client.
func TestDeleteAccount_ClearsProfileFields(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "gina")

	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET display_name = ?, about = ?, custom_status = ?, identity_public_key = ? WHERE id = ?`,
		"Gina G.", "just a bio", "in a meeting", "base64keymaterial", userID,
	); err != nil {
		t.Fatalf("seed profile fields: %v", err)
	}

	if err := database.DeleteAccount(context.Background(), userID); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	var displayName, about, customStatus, identityKey *string
	if err := database.QueryRowContext(context.Background(),
		`SELECT display_name, about, custom_status, identity_public_key FROM users WHERE id = ?`, userID,
	).Scan(&displayName, &about, &customStatus, &identityKey); err != nil {
		t.Fatalf("read profile fields: %v", err)
	}
	if displayName != nil {
		t.Errorf("display_name = %q, want NULL", *displayName)
	}
	if about != nil {
		t.Errorf("about = %q, want NULL", *about)
	}
	if customStatus != nil {
		t.Errorf("custom_status = %q, want NULL", *customStatus)
	}
	if identityKey != nil {
		t.Errorf("identity_public_key = %q, want NULL", *identityKey)
	}
}

// TestDeleteAccount_OneOnOneDM_ClosesForSurvivor covers the partner of a 1:1
// DM whose other side deletes their account. Only the deleting user's own
// dm_participants/dm_open_state rows are removed by the generic purge, so
// without the extra cleanup the channel survives with a recipient nobody can
// resolve — a blank-named sidebar row the survivor could still open and send
// into. DeleteAccount must instead close the DM out of the survivor's
// sidebar, same as the survivor closing it themselves.
func TestDeleteAccount_OneOnOneDM_ClosesForSurvivor(t *testing.T) {
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "alice-dm")
	bob := seedUser(t, database, "bob-dm")

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	if err := database.DeleteAccount(context.Background(), bob); err != nil {
		t.Fatalf("DeleteAccount(bob): %v", err)
	}

	// The channel itself and Alice's participant row must survive — Alice is
	// still a real, undeleted DM participant.
	var channelCount int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM channels WHERE id = ?`, ch.ID).Scan(&channelCount); err != nil {
		t.Fatalf("count channels: %v", err)
	}
	if channelCount != 1 {
		t.Errorf("channel count = %d, want 1 (1:1 DM channel must not be hard-deleted while a real participant remains)", channelCount)
	}

	// But it must be gone from Alice's open-DM list, not linger as a blank
	// recipient she can still send into.
	dms, err := database.GetUserDMChannels(context.Background(), alice)
	if err != nil {
		t.Fatalf("GetUserDMChannels(alice): %v", err)
	}
	for _, dm := range dms {
		if dm.ChannelID == ch.ID {
			t.Errorf("channel %d still in alice's open DM list after bob's account deletion", ch.ID)
		}
	}
}

// TestDeleteAccount_SurvivingDM_KeepsAttachmentsLinked is the other half of
// the unlink fix: the pre-delete "UPDATE attachments SET message_id = NULL"
// must fire ONLY for channels the purge actually emptied. A 1:1 DM whose
// other side is still a real participant keeps its channel row, so unlinking
// there would hand its attachments to the orphan sweep (message_id IS NULL,
// uploaded_at older than an hour) and silently destroy the survivor's files
// an hour later. The EXISTS guard on the UPDATE is what prevents that.
func TestDeleteAccount_SurvivingDM_KeepsAttachmentsLinked(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice-att")
	bob := seedUser(t, database, "bob-att")

	ch, _, err := database.GetOrCreateDMChannel(ctx, alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	// Alice's own message and attachment: they must outlive Bob's deletion.
	msgID, err := database.CreateMessage(ctx, ch.ID, alice, "here you go", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"att-survivor-1", "photo.png", "stored-survivor.png", "image/png", 512, alice,
	); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(ctx, msgID, alice, []string{"att-survivor-1"}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
	}

	if err := database.DeleteAccount(ctx, bob); err != nil {
		t.Fatalf("DeleteAccount(bob): %v", err)
	}

	att, err := database.GetAttachmentByID(ctx, "att-survivor-1")
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("attachment row disappeared although the DM channel still has a live participant")
	}
	if att.MessageID == nil || *att.MessageID != msgID {
		t.Errorf("attachment MessageID = %v, want %d (must stay linked; unlinking hands it to the orphan sweep)",
			att.MessageID, msgID)
	}
}

// TestDeleteAccount_EmptiedDMChannel_PreservesAttachmentsForReclaim covers
// the last member of a group DM deleting their account: the channel row is
// hard-deleted and, without unlinking first, the ON DELETE CASCADE from
// channels -> messages -> attachments (migrations/001) destroys the
// attachment rows too — the only handle the orphan sweep
// (DeleteOrphanedAttachments) has on the uploaded files, permanently
// stranding them on disk. DeleteAccount must unlink the attachments before
// the channel delete so the row (and the sweep's ability to reclaim the
// file) survives.
func TestDeleteAccount_EmptiedDMChannel_PreservesAttachmentsForReclaim(t *testing.T) {
	database := openMigratedMemory(t)
	userA := seedUser(t, database, "dmatt-a")
	userB := seedUser(t, database, "dmatt-b")
	userC := seedUser(t, database, "dmatt-c")

	ch, err := database.CreateGroupDMChannel(context.Background(), "grp", []int64{userA, userB, userC})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}

	msgID, err := database.CreateMessage(context.Background(), ch.ID, userA, "look at this", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"att-dm-1", "photo.png", "stored-photo.png", "image/png", 1024, userA,
	); err != nil {
		t.Fatalf("seed attachment: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(context.Background(), msgID, userA, []string{"att-dm-1"}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
	}

	if _, err := database.LeaveGroupDM(context.Background(), userB, ch.ID); err != nil {
		t.Fatalf("LeaveGroupDM(userB): %v", err)
	}
	if _, err := database.LeaveGroupDM(context.Background(), userC, ch.ID); err != nil {
		t.Fatalf("LeaveGroupDM(userC): %v", err)
	}

	// userA is now the last participant; deleting the account empties and
	// hard-deletes the channel.
	if err := database.DeleteAccount(context.Background(), userA); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}

	var channelCount int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM channels WHERE id = ?`, ch.ID).Scan(&channelCount); err != nil {
		t.Fatalf("count channels: %v", err)
	}
	if channelCount != 0 {
		t.Errorf("group DM channel survived deletion of its last participant; want removed")
	}

	att, err := database.GetAttachmentByID(context.Background(), "att-dm-1")
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("attachment row was destroyed by the channel-delete cascade; want it unlinked and preserved for the orphan sweep")
	}
	if att.MessageID != nil {
		t.Errorf("attachment MessageID = %v, want nil (unlinked ahead of the cascade)", *att.MessageID)
	}
}

// ─── Helper ──────────────────────────────────────────────────────────────────

func setRole(t *testing.T, database *db.DB, userID, roleID int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), "UPDATE users SET role_id = ? WHERE id = ?", roleID, userID); err != nil {
		t.Fatalf("setRole(%d, %d): %v", userID, roleID, err)
	}
}
