package db_test

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// eraseAccount runs EraseAccount for the rows that only care about the
// outcome, not the file journal.
func eraseAccount(ctx context.Context, database *db.DB, userID int64) error {
	_, err := database.EraseAccount(ctx, userID, "")
	return err
}

// ─── EraseAccount — last admin guard ────────────────────────────────────────

func TestEraseAccount_LastOwnerBlocked(t *testing.T) {
	database := openMigratedMemory(t)
	// Create a single owner (role_id=1). No other admins exist.
	ownerID := seedUser(t, database, "owner")
	setRole(t, database, ownerID, 1) // Owner

	err := eraseAccount(context.Background(), database, ownerID)
	if !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("EraseAccount(last owner) = %v, want ErrLastAdmin", err)
	}
}

func TestEraseAccount_LastAdminBlocked(t *testing.T) {
	database := openMigratedMemory(t)
	adminID := seedUser(t, database, "admin")
	setRole(t, database, adminID, 2) // Admin

	err := eraseAccount(context.Background(), database, adminID)
	if !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("EraseAccount(last admin) = %v, want ErrLastAdmin", err)
	}
}

func TestEraseAccount_AllowedWhenOtherAdminExists(t *testing.T) {
	database := openMigratedMemory(t)
	admin1 := seedUser(t, database, "admin1")
	admin2 := seedUser(t, database, "admin2")
	setRole(t, database, admin1, 2) // Admin
	setRole(t, database, admin2, 2) // Admin

	err := eraseAccount(context.Background(), database, admin1)
	if err != nil {
		t.Fatalf("EraseAccount with another admin present: %v", err)
	}
}

// TestEraseAccount_AllowedWhenOtherAdminHasLapsedTempBan locks the guard's
// "is there another usable admin left" count against the same lapsed-ban
// split notBannedClause documents elsewhere: an admin whose
// temporary ban has expired (banned=1, ban_expires in the past) is fully
// functional per auth.IsEffectivelyBanned, so the raw `banned = 0` filter
// must not make the guard blind to them.
func TestEraseAccount_AllowedWhenOtherAdminHasLapsedTempBan(t *testing.T) {
	database := openMigratedMemory(t)
	admin1 := seedUser(t, database, "admin1")
	admin2 := seedUser(t, database, "admin2")
	setRole(t, database, admin1, 2) // Admin
	setRole(t, database, admin2, 2) // Admin

	// admin2's temp ban has lapsed: banned stays 1 but ban_expires is in the
	// past, so admin2 logs in and administers normally.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET banned = 1, ban_expires = '2020-01-01 00:00:00' WHERE id = ?`, admin2,
	); err != nil {
		t.Fatalf("set lapsed temp ban: %v", err)
	}

	err := eraseAccount(context.Background(), database, admin1)
	if err != nil {
		t.Fatalf("EraseAccount with a lapsed-temp-ban admin present: %v", err)
	}
}

func TestEraseAccount_AdminAllowedWhenOwnerExists(t *testing.T) {
	database := openMigratedMemory(t)
	ownerID := seedUser(t, database, "owner")
	adminID := seedUser(t, database, "admin")
	setRole(t, database, ownerID, 1) // Owner
	setRole(t, database, adminID, 2) // Admin

	// Admin can delete because owner still exists.
	err := eraseAccount(context.Background(), database, adminID)
	if err != nil {
		t.Fatalf("EraseAccount(admin with owner present): %v", err)
	}
}

// ─── EraseAccount — member deletion ─────────────────────────────────────────

func TestEraseAccount_MemberSucceeds(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice") // default role_id=4

	err := eraseAccount(context.Background(), database, userID)
	if err != nil {
		t.Fatalf("EraseAccount(member): %v", err)
	}
}

// ─── EraseAccount — the row is gone ─────────────────────────────────────────

func TestEraseAccount_RemovesTheUserRow(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "alice")
	database.ExecContext(context.Background(), "UPDATE users SET avatar = 'pic.png', totp_secret = 'SECRET', display_name = 'A', about = 'bio', custom_status = 'busy', identity_public_key = 'key' WHERE id = ?", userID) //nolint:errcheck

	job, err := database.EraseAccount(context.Background(), userID, "")
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if job == nil || job.UserID != userID || job.State != db.ErasureStateDBDone {
		t.Fatalf("job = %+v, want db_done for user %d", job, userID)
	}

	user, err := database.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatalf("GetUserByID after erasure: %v", err)
	}
	if user != nil {
		t.Errorf("user row survived the erasure: %+v", user)
	}
	// The username is free again: erasure leaves no marker row.
	if _, err := database.CreateUser(context.Background(), "alice", "hash", 4); err != nil {
		t.Errorf("re-registering the erased name: %v", err)
	}
}

// ─── EraseAccount — related data cleanup ────────────────────────────────────

func TestEraseAccount_DeletesSessions(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "eve")

	// Insert a session directly.
	database.ExecContext(context.Background(),
		"INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'tok123', datetime('now', '+1 day'))",
		userID,
	) //nolint:errcheck

	eraseAccount(context.Background(), database, userID) //nolint:errcheck

	var count int
	database.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM sessions WHERE user_id = ?", userID).Scan(&count) //nolint:errcheck
	if count != 0 {
		t.Errorf("sessions count = %d, want 0", count)
	}
}

func TestEraseAccount_HardDeletesMessages(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "frank")
	chID := seedChannel(t, database, "general")

	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "hello unique-needle world", nil)
	if n := countFTS(t, database, "needle"); n != 1 {
		t.Fatalf("precondition: FTS hits = %d, want 1", n)
	}

	if _, err := database.EraseAccount(context.Background(), userID, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	msg, err := database.GetMessage(context.Background(), msgID)
	if err == nil && msg != nil {
		t.Errorf("message row survived the erasure: %+v", msg)
	}
	if n := countFTS(t, database, "needle"); n != 0 {
		t.Errorf("FTS hits after erasure = %d, want 0", n)
	}
}

func countFTS(t *testing.T, database *db.DB, term string) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?`, term).Scan(&n); err != nil {
		t.Fatalf("FTS count: %v", err)
	}
	return n
}

// TestEraseAccount_ReversesMentionCounts locks OC-0294: EraseAccount
// hard-deletes every message the departing user wrote, but unlike
// DeleteMessage and PurgeMessages (OC-0275) it never calls
// DecrementMentionCounts. The live unread count excludes deleted rows, but
// read_states.mention_count is a stored counter -- so a mention badge from a
// message that no longer exists must be reversed here too, or it survives
// forever on a channel with nothing unread.
func TestEraseAccount_ReversesMentionCounts(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice-mention")
	bob := seedUser(t, database, "bob-mention")
	chID := seedChannel(t, database, "general-mention")

	msg, err := database.CreateMessageWithMentions(ctx, chID, alice, "hi @bob", nil, []int64{bob}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, chID, msg.ID, []int64{bob}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}
	if n, _ := database.GetMentionCount(ctx, bob, chID); n != 1 {
		t.Fatalf("precondition: bob mention_count = %d, want 1", n)
	}

	if err := eraseAccount(ctx, database, alice); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	if n, _ := database.GetMentionCount(ctx, bob, chID); n != 0 {
		t.Errorf("bob mention_count = %d after alice's account deletion, want 0 (phantom badge on a channel with nothing unread)", n)
	}
}

// TestEraseAccount_MentionCounts_PreservesOthersContribution is the control
// for the fix above: it must reverse only the departing user's own mentions,
// not blanket-zero the recipient's mention_count. Bob has two independent
// mention badges in the same channel; deleting alice's account must leave
// carol's genuine, unrelated badge standing.
func TestEraseAccount_MentionCounts_PreservesOthersContribution(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	alice := seedUser(t, database, "alice-mention2")
	carol := seedUser(t, database, "carol-mention2")
	bob := seedUser(t, database, "bob-mention2")
	chID := seedChannel(t, database, "general-mention2")

	msgAlice, err := database.CreateMessageWithMentions(ctx, chID, alice, "hi @bob", nil, []int64{bob}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions(alice): %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, chID, msgAlice.ID, []int64{bob}); err != nil {
		t.Fatalf("IncrementMentionCounts(alice): %v", err)
	}

	msgCarol, err := database.CreateMessageWithMentions(ctx, chID, carol, "hey @bob too", nil, []int64{bob}, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions(carol): %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, chID, msgCarol.ID, []int64{bob}); err != nil {
		t.Fatalf("IncrementMentionCounts(carol): %v", err)
	}

	if n, _ := database.GetMentionCount(ctx, bob, chID); n != 2 {
		t.Fatalf("precondition: bob mention_count = %d, want 2", n)
	}

	if err := eraseAccount(ctx, database, alice); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	if n, _ := database.GetMentionCount(ctx, bob, chID); n != 1 {
		t.Errorf("bob mention_count = %d after alice's account deletion, want 1 (carol's genuine mention must survive)", n)
	}
}

func TestEraseAccount_NonexistentUser(t *testing.T) {
	database := openMigratedMemory(t)

	_, err := database.EraseAccount(context.Background(), 999999, "")
	if !errors.Is(err, db.ErrNotFound) {
		t.Errorf("EraseAccount(nonexistent) = %v, want ErrNotFound", err)
	}
}

// ─── EraseAccount — canonical admin criterion, tokens, DM cleanup ───────────

func TestEraseAccount_LastAdminGuard_SurvivesRoleRename(t *testing.T) {
	database := openMigratedMemory(t)
	// The Owner can rename the seeded Admin role (id=2); the guard must key
	// on the canonical role IDs, not the display name.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE roles SET name = 'Staff' WHERE id = 2`); err != nil {
		t.Fatalf("rename admin role: %v", err)
	}
	adminID := seedUser(t, database, "renamedadmin")
	setRole(t, database, adminID, 2)

	err := eraseAccount(context.Background(), database, adminID)
	if !errors.Is(err, db.ErrLastAdmin) {
		t.Errorf("EraseAccount(last holder of renamed admin role) = %v, want ErrLastAdmin", err)
	}
}

func TestEraseAccount_DeletesAPITokenRows(t *testing.T) {
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "tokenuser")

	tokenHash := "testhash-tokenuser"
	if _, err := database.CreateAPIToken(context.Background(), uid, tokenHash, "ci", nil); err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	if _, err := database.EraseAccount(context.Background(), uid, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	if tok, _ := database.GetActiveAPIToken(context.Background(), tokenHash); tok != nil {
		t.Error("API token still active after erasure")
	}
	var rows int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, uid).Scan(&rows); err != nil {
		t.Fatalf("count api_tokens: %v", err)
	}
	if rows != 0 {
		t.Errorf("api_tokens rows = %d after erasure, want 0 (class 3 keeps no labels or hashes)", rows)
	}
}

func TestEraseAccount_LastGroupDMParticipant_RemovesChannel(t *testing.T) {
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
	if err := eraseAccount(context.Background(), database, userA); err != nil {
		t.Fatalf("EraseAccount: %v", err)
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

// TestEraseAccount_OneOnOneDM_ClosesForSurvivor covers the partner of a 1:1
// DM whose other side deletes their account. Only the deleting user's own
// dm_participants/dm_open_state rows are removed by the generic purge, so
// without the extra cleanup the channel survives with a recipient nobody can
// resolve — a blank-named sidebar row the survivor could still open and send
// into. EraseAccount must instead close the DM out of the survivor's
// sidebar, same as the survivor closing it themselves.
func TestEraseAccount_OneOnOneDM_ClosesForSurvivor(t *testing.T) {
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "alice-dm")
	bob := seedUser(t, database, "bob-dm")

	ch, _, err := database.GetOrCreateDMChannel(context.Background(), alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	if err := eraseAccount(context.Background(), database, bob); err != nil {
		t.Fatalf("EraseAccount(bob): %v", err)
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

// TestEraseAccount_SurvivingDM_KeepsAttachmentsLinked is the other half of
// the unlink fix: the pre-delete "UPDATE attachments SET message_id = NULL"
// must fire ONLY for channels the purge actually emptied. A 1:1 DM whose
// other side is still a real participant keeps its channel row, so unlinking
// there would hand its attachments to the orphan sweep (message_id IS NULL,
// uploaded_at older than an hour) and silently destroy the survivor's files
// an hour later. The EXISTS guard on the UPDATE is what prevents that.
func TestEraseAccount_SurvivingDM_KeepsAttachmentsLinked(t *testing.T) {
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

	if err := eraseAccount(ctx, database, bob); err != nil {
		t.Fatalf("EraseAccount(bob): %v", err)
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

// TestEraseAccount_EmptiedDMChannel_PreservesOthersAttachmentsForReclaim
// covers the last member of a group DM erasing their account: the channel
// row is hard-deleted and, without unlinking first, the ON DELETE CASCADE
// from channels -> messages -> attachments (migrations/001) destroys the
// attachment rows too — the only handle the orphan sweep
// (DeleteOrphanedAttachments) has on the uploaded files, permanently
// stranding them on disk. The subject's own attachments are class 12 and go
// with the erasure, their files journaled; a departed member's attachments
// in the same channel must be unlinked before the channel delete so the row
// (and the sweep's ability to reclaim the file) survives.
func TestEraseAccount_EmptiedDMChannel_PreservesOthersAttachmentsForReclaim(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userA := seedUser(t, database, "dmatt-a")
	userB := seedUser(t, database, "dmatt-b")
	userC := seedUser(t, database, "dmatt-c")

	ch, err := database.CreateGroupDMChannel(ctx, "grp", []int64{userA, userB, userC})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}

	seedLinked := func(uploader int64, attID, storedAs string) {
		t.Helper()
		msgID, err := database.CreateMessage(ctx, ch.ID, uploader, "look at this", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		if _, err := database.ExecContext(ctx,
			`INSERT INTO attachments (id, filename, stored_as, mime_type, size, uploader_id)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			attID, "photo.png", storedAs, "image/png", 1024, uploader,
		); err != nil {
			t.Fatalf("seed attachment: %v", err)
		}
		if n, err := database.LinkAttachmentsToMessage(ctx, msgID, uploader, []string{attID}); err != nil || n != 1 {
			t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
		}
	}
	seedLinked(userA, "att-dm-a", "stored-a.png")
	seedLinked(userB, "att-dm-b", "stored-b.png")

	if _, err := database.LeaveGroupDM(ctx, userB, ch.ID); err != nil {
		t.Fatalf("LeaveGroupDM(userB): %v", err)
	}
	if _, err := database.LeaveGroupDM(ctx, userC, ch.ID); err != nil {
		t.Fatalf("LeaveGroupDM(userC): %v", err)
	}

	// userA is now the last participant; the erasure empties and
	// hard-deletes the channel.
	job, err := database.EraseAccount(ctx, userA, "")
	if err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}

	var channelCount int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE id = ?`, ch.ID).Scan(&channelCount); err != nil {
		t.Fatalf("count channels: %v", err)
	}
	if channelCount != 0 {
		t.Errorf("group DM channel survived the erasure of its last participant; want removed")
	}

	if att, _ := database.GetAttachmentByID(ctx, "att-dm-a"); att != nil {
		t.Errorf("the subject's own attachment row survived: %+v", att)
	}
	if len(job.Files) != 1 || job.Files[0] != "stored-a.png" {
		t.Errorf("job files = %v, want the subject's stored-a.png", job.Files)
	}

	att, err := database.GetAttachmentByID(ctx, "att-dm-b")
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att == nil {
		t.Fatal("the departed member's attachment row was destroyed by the channel-delete cascade; want it unlinked and preserved for the orphan sweep")
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
