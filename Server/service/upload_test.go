package service

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// These tests pin the attachment-access policy at the service seam, where the
// upload family moved it: what makes a file unservable to everyone (Resolve)
// and who may read one that is still servable (Authorize). The REST surface
// keeps its own pins in api/upload_handler_test.go — the two describe the same
// rules from either side of the seam.

// newUploadFixture builds an UploadService over a migrated test database.
func newUploadFixture(t *testing.T) (*UploadService, *db.DB) {
	t.Helper()
	database := newTestDB(t)
	perms := NewPermissionService(database, permissions.NewChecker(database))
	return NewUploadService(database, perms), database
}

// seedAttachment inserts an attachment row directly, so a test can express the
// shapes the service's own Record cannot produce: a linked row, or a legacy row
// with no uploader.
func seedAttachment(t *testing.T, database *db.DB, id string, uploaderID, messageID *int64) {
	t.Helper()
	var uploader, msg any
	if uploaderID != nil {
		uploader = *uploaderID
	}
	if messageID != nil {
		msg = *messageID
	}
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id)
		 VALUES (?, ?, 'f.png', ?, 'image/png', 3, ?)`,
		id, msg, id, uploader,
	); err != nil {
		t.Fatalf("seedAttachment(%q): %v", id, err)
	}
}

// seedMessage inserts one message and returns its id.
func seedMessage(t *testing.T, database *db.DB, channelID, userID int64, deleted bool) int64 {
	t.Helper()
	flag := 0
	if deleted {
		flag = 1
	}
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO messages (channel_id, user_id, content, deleted) VALUES (?, ?, 'hi', ?)`,
		channelID, userID, flag,
	)
	if err != nil {
		t.Fatalf("seedMessage: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("seedMessage LastInsertId: %v", err)
	}
	return id
}

func TestUploadResolve_MissingAttachmentIsNotFound(t *testing.T) {
	uploads, _ := newUploadFixture(t)

	_, err := uploads.Resolve(context.Background(), "nope")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Resolve(missing) error = %v, want ErrNotFound", err)
	}
}

// A soft-deleted message's attachments stop being servable for everyone, which
// is why the check lives in Resolve rather than in Authorize: an administrator
// gets the same 404, because the tombstone applies to everyone.
func TestUploadResolve_TombstonedMessageHidesItsAttachments(t *testing.T) {
	uploads, database := newUploadFixture(t)
	seedUser(t, database, &db.User{ID: 1})
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general"})
	msgID := seedMessage(t, database, 10, 1, false)
	uploader := int64(1)
	seedAttachment(t, database, "live", &uploader, &msgID)

	if _, err := uploads.Resolve(context.Background(), "live"); err != nil {
		t.Fatalf("Resolve before the delete: %v", err)
	}

	if _, err := database.ExecContext(context.Background(),
		`UPDATE messages SET deleted = 1 WHERE id = ?`, msgID); err != nil {
		t.Fatalf("soft-deleting the message: %v", err)
	}

	_, err := uploads.Resolve(context.Background(), "live")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Resolve after the delete: error = %v, want ErrNotFound", err)
	}
}

// A row whose message is gone entirely is unlinked-shaped, not tombstoned:
// Resolve hands it on and the ownership rules in Authorize decide.
func TestUploadResolve_MissingMessageRowFallsThroughToTheACL(t *testing.T) {
	uploads, database := newUploadFixture(t)
	uploader := int64(1)
	seedUser(t, database, &db.User{ID: 1})
	ghost := int64(4242)
	if _, err := database.ExecContext(context.Background(), `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disabling foreign keys: %v", err)
	}
	seedAttachment(t, database, "ghost", &uploader, &ghost)

	aa, err := uploads.Resolve(context.Background(), "ghost")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if aa == nil || aa.ID != "ghost" {
		t.Fatalf("Resolve returned %+v, want the attachment row", aa)
	}
}

func TestUploadAuthorize_UnlinkedIsPrivateToItsUploader(t *testing.T) {
	uploads, database := newUploadFixture(t)
	seedUser(t, database, &db.User{ID: 1})
	seedUser(t, database, &db.User{ID: 2})
	if err := uploads.Record(context.Background(), AttachmentRecord{
		ID: "priv", UploaderID: 1, Filename: "f.png", MimeType: "image/png", Size: 3,
	}, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}
	aa, err := uploads.Resolve(context.Background(), "priv")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 1}, nil); err != nil {
		t.Errorf("uploader was refused its own file: %v", err)
	}
	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 2}, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("stranger error = %v, want ErrForbidden", err)
	}
	if err := uploads.Authorize(context.Background(), aa, nil, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("unauthenticated error = %v, want ErrForbidden", err)
	}
}

// An avatar is public exactly while it is in use: the check is by the exact URL
// the column holds, so replacing the avatar takes the file private again in the
// same instant.
func TestUploadAuthorize_AvatarIsPublicOnlyWhileInUse(t *testing.T) {
	uploads, database := newUploadFixture(t)
	url := AvatarFileURL("face")
	seedUser(t, database, &db.User{ID: 1, Avatar: &url})
	seedUser(t, database, &db.User{ID: 2})
	uploader := int64(1)
	seedAttachment(t, database, "face", &uploader, nil)
	aa, err := uploads.Resolve(context.Background(), "face")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 2}, nil); err != nil {
		t.Errorf("avatar in use was refused to another member: %v", err)
	}

	other := AvatarFileURL("newface")
	seedUser(t, database, &db.User{ID: 1, Avatar: &other})
	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 2}, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("replaced avatar: error = %v, want ErrForbidden", err)
	}
}

// M-2: a legacy row with no uploader is denied rather than served to any
// authenticated caller.
func TestUploadAuthorize_LegacyRowWithNoUploaderIsDenied(t *testing.T) {
	uploads, database := newUploadFixture(t)
	seedUser(t, database, &db.User{ID: 1})
	seedAttachment(t, database, "legacy", nil, nil)
	aa, err := uploads.Resolve(context.Background(), "legacy")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 1}, nil); !errors.Is(err, ErrForbidden) {
		t.Errorf("legacy row error = %v, want ErrForbidden", err)
	}
}

// OC-0112: DM participation is required of everyone, administrators included —
// the admin bypass must not reach a DM the administrator is not in.
func TestUploadAuthorize_DMParticipationBindsAdministratorsToo(t *testing.T) {
	uploads, database := newUploadFixture(t)
	admin := &db.Role{ID: 1, Name: "admin", Permissions: permissions.AllPerms, Position: 100}
	seedRole(t, database, admin)
	seedUser(t, database, &db.User{ID: 1})
	seedUser(t, database, &db.User{ID: 2})
	seedUser(t, database, &db.User{ID: 3})
	seedChannel(t, database, &db.Channel{ID: 20, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 20, 1)
	seedDMParticipant(t, database, 20, 2)
	msgID := seedMessage(t, database, 20, 1, false)
	uploader := int64(1)
	seedAttachment(t, database, "dmfile", &uploader, &msgID)
	aa, err := uploads.Resolve(context.Background(), "dmfile")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 2}, nil); err != nil {
		t.Errorf("the other participant was refused: %v", err)
	}
	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 3}, admin); !errors.Is(err, ErrForbidden) {
		t.Errorf("administrator outside the DM: error = %v, want ErrForbidden", err)
	}
}

// A linked attachment in a guild channel needs READ_MESSAGES there, and an
// administrator reads it without one.
func TestUploadAuthorize_GuildChannelNeedsReadMessages(t *testing.T) {
	uploads, database := newUploadFixture(t)
	admin := &db.Role{ID: 1, Name: "admin", Permissions: permissions.AllPerms, Position: 100}
	reader := &db.Role{ID: 5, Name: "reader", Permissions: permissions.ReadMessages, Position: 10}
	mute := &db.Role{ID: 6, Name: "mute", Permissions: 0, Position: 5}
	seedRole(t, database, admin)
	seedRole(t, database, reader)
	seedRole(t, database, mute)
	seedUser(t, database, &db.User{ID: 1})
	seedUserRole(t, database, 1, 5)
	seedUser(t, database, &db.User{ID: 2})
	seedUserRole(t, database, 2, 6)
	seedUser(t, database, &db.User{ID: 3})
	seedUserRole(t, database, 3, 1)
	seedChannel(t, database, &db.Channel{ID: 30, Name: "general"})
	msgID := seedMessage(t, database, 30, 1, false)
	uploader := int64(1)
	seedAttachment(t, database, "guildfile", &uploader, &msgID)
	aa, err := uploads.Resolve(context.Background(), "guildfile")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 1}, reader); err != nil {
		t.Errorf("a reader was refused: %v", err)
	}
	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 2}, mute); !errors.Is(err, ErrForbidden) {
		t.Errorf("no READ_MESSAGES: error = %v, want ErrForbidden", err)
	}
	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 3}, admin); err != nil {
		t.Errorf("administrator was refused: %v", err)
	}
}

// Every refusal answers with the same message, so a caller cannot tell a file
// it may not read from one that does not exist.
func TestUploadAuthorize_RefusalsAreIndistinguishable(t *testing.T) {
	uploads, database := newUploadFixture(t)
	seedUser(t, database, &db.User{ID: 1})
	seedUser(t, database, &db.User{ID: 2})
	seedAttachment(t, database, "legacy", nil, nil)
	uploader := int64(1)
	seedAttachment(t, database, "priv", &uploader, nil)

	legacy, err := uploads.Resolve(context.Background(), "legacy")
	if err != nil {
		t.Fatalf("Resolve(legacy): %v", err)
	}
	priv, err := uploads.Resolve(context.Background(), "priv")
	if err != nil {
		t.Fatalf("Resolve(priv): %v", err)
	}

	legacyErr := uploads.Authorize(context.Background(), legacy, &db.User{ID: 2}, nil)
	privErr := uploads.Authorize(context.Background(), priv, &db.User{ID: 2}, nil)
	if legacyErr == nil || privErr == nil {
		t.Fatalf("both must refuse: legacy=%v priv=%v", legacyErr, privErr)
	}
	if legacyErr.Error() != privErr.Error() {
		t.Errorf("refusals differ: %q vs %q", legacyErr.Error(), privErr.Error())
	}
	// Prefix-free, because the handler echoes this text verbatim.
	if got := privErr.Error(); got != "you do not have access to this file" {
		t.Errorf("refusal message = %q, want the bare sentence", got)
	}
}

func TestUploadRecord_WritesAnUnlinkedRowOwnedByItsUploader(t *testing.T) {
	uploads, database := newUploadFixture(t)
	seedUser(t, database, &db.User{ID: 7})
	w, h := 16, 32

	if err := uploads.Record(context.Background(), AttachmentRecord{
		ID: "rec", UploaderID: 7, Filename: "shot.png", MimeType: "image/png",
		Size: 99, Width: &w, Height: &h,
	}, nil); err != nil {
		t.Fatalf("Record: %v", err)
	}

	got, err := database.GetAttachmentByID(context.Background(), "rec")
	if err != nil || got == nil {
		t.Fatalf("GetAttachmentByID: %v, %+v", err, got)
	}
	switch {
	case got.MessageID != nil:
		t.Errorf("MessageID = %v, want nil (unlinked until a message claims it)", *got.MessageID)
	case got.UploaderID == nil || *got.UploaderID != 7:
		t.Errorf("UploaderID = %v, want 7", got.UploaderID)
	case got.StoredAs != "rec":
		t.Errorf("StoredAs = %q, want the file id", got.StoredAs)
	case got.Filename != "shot.png" || got.MimeType != "image/png" || got.Size != 99:
		t.Errorf("row = %+v, want the record's metadata", got)
	}
}

// TestUploadAuthorize_NonMemberGetsTheSameRefusalLabelledOrNot is P2-6: a
// non-member (no READ_MESSAGES) probing an attachment URL must not be able
// to tell a labelled channel from an unlabelled one by the error it gets
// back — ordinary visibility is checked before NSFW consent, so both cases
// answer with the same ErrForbidden.
func TestUploadAuthorize_NonMemberGetsTheSameRefusalLabelledOrNot(t *testing.T) {
	uploads, database := newUploadFixture(t)
	seedUser(t, database, &db.User{ID: 1})
	nonMember := &db.Role{ID: 6, Name: "non-member", Permissions: 0, Position: 5}
	seedRole(t, database, nonMember)
	seedUser(t, database, &db.User{ID: 2})
	seedUserRole(t, database, 2, 6)

	seedChannel(t, database, &db.Channel{ID: 40, Name: "plain"})
	plainMsg := seedMessage(t, database, 40, 1, false)
	uploader := int64(1)
	seedAttachment(t, database, "plainfile", &uploader, &plainMsg)
	plainAA, err := uploads.Resolve(context.Background(), "plainfile")
	if err != nil {
		t.Fatalf("Resolve(plain): %v", err)
	}

	seedChannel(t, database, &db.Channel{ID: 41, Name: "labelled"})
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET nsfw = 1 WHERE id = ?`, 41); err != nil {
		t.Fatalf("labelling channel 41: %v", err)
	}
	labelledMsg := seedMessage(t, database, 41, 1, false)
	seedAttachment(t, database, "labelledfile", &uploader, &labelledMsg)
	labelledAA, err := uploads.Resolve(context.Background(), "labelledfile")
	if err != nil {
		t.Fatalf("Resolve(labelled): %v", err)
	}

	plainErr := uploads.Authorize(context.Background(), plainAA, &db.User{ID: 2}, nonMember)
	labelledErr := uploads.Authorize(context.Background(), labelledAA, &db.User{ID: 2}, nonMember)

	if !errors.Is(plainErr, ErrForbidden) {
		t.Fatalf("non-member on plain channel: error = %v, want ErrForbidden", plainErr)
	}
	if !errors.Is(labelledErr, ErrForbidden) {
		t.Fatalf("non-member on labelled channel: error = %v, want ErrForbidden — "+
			"got a different code (e.g. NSFW_ACKNOWLEDGEMENT_REQUIRED), which leaks the label to a non-viewer", labelledErr)
	}
	if plainErr.Error() != labelledErr.Error() {
		t.Errorf("refusals differ: plain=%q labelled=%q — a non-member must not be able to "+
			"tell a labelled channel from an unlabelled one", plainErr.Error(), labelledErr.Error())
	}
}

// TestUploadAuthorize_AdministratorStillNeedsConsentForALabelledChannel
// pins decision 13 alongside P2-6's reorder: moving the visibility check
// earlier must not accidentally let an administrator skip the NSFW consent
// check too — an admin is exempt from ordinary visibility but not from
// consent.
func TestUploadAuthorize_AdministratorStillNeedsConsentForALabelledChannel(t *testing.T) {
	uploads, database := newUploadFixture(t)
	admin := &db.Role{ID: 1, Name: "admin", Permissions: permissions.AllPerms, Position: 100}
	seedRole(t, database, admin)
	seedUser(t, database, &db.User{ID: 1})
	seedUser(t, database, &db.User{ID: 3})
	seedUserRole(t, database, 3, 1)

	seedChannel(t, database, &db.Channel{ID: 42, Name: "labelled-for-admin"})
	if _, err := database.ExecContext(context.Background(),
		`UPDATE channels SET nsfw = 1 WHERE id = ?`, 42); err != nil {
		t.Fatalf("labelling channel: %v", err)
	}
	msgID := seedMessage(t, database, 42, 1, false)
	uploader := int64(1)
	seedAttachment(t, database, "adminfile", &uploader, &msgID)
	aa, err := uploads.Resolve(context.Background(), "adminfile")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	err = uploads.Authorize(context.Background(), aa, &db.User{ID: 3}, admin)
	if !errors.Is(err, permissions.ErrNSFWUnacknowledged) {
		t.Fatalf("administrator without an acknowledgement: error = %v, want ErrNSFWUnacknowledged", err)
	}

	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?)`, 3, 42); err != nil {
		t.Fatalf("seeding acknowledgement: %v", err)
	}
	if err := uploads.Authorize(context.Background(), aa, &db.User{ID: 3}, admin); err != nil {
		t.Errorf("administrator with an acknowledgement was refused: %v", err)
	}
}
