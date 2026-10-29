package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// UploadService owns what happens to an uploaded file once its bytes are on
// disk: the attachment row that records it, and the two questions asked before
// those bytes are served back — is this file still servable at all, and may
// this caller read it.
//
// The bytes themselves stay with the transport: the handler parses the
// multipart body, sniffs the type, measures the image and writes through the
// FileStore, because all of that is HTTP and filesystem work with no domain
// decision in it. What crosses into this service is every decision that
// outlives one request — who owns a file, when a file stops existing for
// readers, and who may read one.
type UploadService struct {
	st    Store
	perms *PermissionService
	// banners answers whether a file is some user's live profile banner. It is
	// a slice interface and not part of Store (the Store method ratchet); nil
	// means no banner is ever readable through the grant, which fails closed.
	banners BannerFileStore
	// quota is the per-user byte counter's in-process half; see
	// storage_quota.go.
	quota storageQuota
	// cloner is the storage a forward clones files in; guarded by
	// quota.mu. nil until the composition root installs it.
	cloner FileCloner
}

var _ BannerFileStore = (*db.DB)(nil)

// BannerFileStore is the one question the file route asks about profile
// banners: is this attachment named by some user's banner_id right now.
// *db.DB satisfies it.
type BannerFileStore interface {
	IsBannerFile(ctx context.Context, fileID string) (bool, error)
}

// NewUploadService creates an UploadService.
func NewUploadService(st Store, perms *PermissionService) *UploadService {
	return &UploadService{st: st, perms: perms}
}

// AttachmentRecord is the metadata of one already-stored file. The caller is
// responsible for having validated the bytes and written them through its
// store; this is the row that records the result.
type AttachmentRecord struct {
	// ID is both the attachment id and the name the bytes are stored under.
	ID string
	// UploaderID is who may read the file back while it is unlinked.
	UploaderID int64
	// Filename is the sanitized display name, not a path.
	Filename string
	// MimeType is the type sniffed from the file's own bytes, never the
	// client's Content-Type.
	MimeType string
	// Size is the byte count actually written to storage.
	Size int64
	// Width and Height are the image dimensions, nil for a non-image.
	Width, Height *int
	// DurationMs and Waveform are set only for a voice message: the
	// clip length in milliseconds and the canonical base64url (unpadded)
	// encoding of its amplitude bytes. Both nil, or both set.
	DurationMs *int
	Waveform   *string
}

// Record inserts the attachment row for a stored file. The row is unlinked
// (message_id NULL) until a message claims it, which is what makes it private
// to its uploader in the meantime (see Authorize).
//
// res is the reservation the bytes were written under. The row insert
// and the reservation's commit share one critical section, so a recount can
// never see the file both in the rows and in flight and double-count it;
// on failure the reservation is left for the caller's Settle to release.
//
// A failure here leaves the caller holding orphaned bytes; every caller
// deletes them from its store before reporting the error, because nothing
// else will — the orphan sweep only reclaims rows, and there is no row.
func (s *UploadService) Record(ctx context.Context, rec AttachmentRecord, res *StorageReservation) error {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	if err := s.st.CreateAttachmentVoice(ctx, rec.ID, rec.UploaderID, rec.Filename,
		rec.ID, rec.MimeType, rec.Size, rec.Width, rec.Height, rec.DurationMs, rec.Waveform); err != nil {
		return fmt.Errorf("%w: failed to save attachment: %w", ErrInternal, err)
	}
	if res != nil {
		res.commitLocked()
	}
	return nil
}

// Unrecord undoes Record for a file that never got used: it deletes the
// still-unlinked row and recounts the user's counter, so the row's charge is
// returned now instead of at the next orphan sweep. The caller deletes the
// stored bytes.
func (s *UploadService) Unrecord(ctx context.Context, fileID string, userID int64) error {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	if _, err := s.st.DeleteUnlinkedAttachment(ctx, fileID, userID); err != nil {
		return fmt.Errorf("%w: failed to remove attachment: %w", ErrInternal, err)
	}
	return s.recountLocked(ctx, userID)
}

// Discard withdraws a file userID uploaded and never sent: it deletes the
// unlinked row (never a live avatar) and recounts the user's counter, so the
// quota is free for the next upload at once instead of at the orphan sweep.
// It returns the stored file name for the caller to delete, or ErrNotFound
// when there is no such file, it is someone else's, or a message already
// holds it.
func (s *UploadService) Discard(ctx context.Context, fileID string, userID int64) (string, error) {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	storedAs, found, err := s.st.DiscardUnlinkedAttachment(ctx, fileID, userID)
	if err != nil {
		return "", fmt.Errorf("%w: failed to discard attachment: %w", ErrInternal, err)
	}
	if !found {
		return "", fmt.Errorf("upload not found%.0w", ErrNotFound)
	}
	if rcErr := s.recountLocked(ctx, userID); rcErr != nil {
		return storedAs, fmt.Errorf("discard recount: %w", rcErr)
	}
	return storedAs, nil
}

// Resolve looks up the attachment behind fileID and applies the checks that
// make a file unservable regardless of who is asking.
//
// A soft-deleted message's attachments stop being servable the moment the
// message is deleted — the client shows a tombstone, but without this check the
// file stays reachable by URL forever (no sweep can ever reclaim a linked row
// either, since the only reaper requires message_id IS NULL). It is checked
// here rather than in Authorize so it also covers administrators, matching the
// tombstone applying to everyone.
//
// A linked attachment whose message row is gone entirely is left to Authorize,
// which by then sees it as unlinked-shaped.
func (s *UploadService) Resolve(ctx context.Context, fileID string) (*db.AttachmentAccess, error) {
	aa, err := s.st.GetAttachmentWithChannel(ctx, fileID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to look up attachment: %w", ErrInternal, err)
	}
	if aa == nil {
		return nil, fmt.Errorf("attachment not found%.0w", ErrNotFound)
	}
	if aa.MessageID != nil {
		deleted, found, delErr := s.st.IsMessageDeleted(ctx, *aa.MessageID)
		switch {
		case delErr != nil:
			return nil, fmt.Errorf("%w: failed to look up message for attachment: %w", ErrInternal, delErr)
		case found && deleted:
			return nil, fmt.Errorf("attachment not found%.0w", ErrNotFound)
		}
	}
	return aa, nil
}

// Authorize decides whether actor may read aa. actor and role are the caller's
// resolved identity; both may be nil, which denies everything an unauthenticated
// caller could otherwise reach.
//
// The rules, in the order they are applied:
//
//   - DM participation is required of everyone, administrators included. This
//     matches every other DM read gate in the codebase (requireChannelRead,
//     checkSendPermission), none of which have an admin bypass, and it is
//     checked ahead of the admin branch so that branch cannot skip it.
//   - A linked attachment in a guild channel needs READ_MESSAGES there, which
//     an administrator is exempt from.
//   - An unlinked attachment is private to its uploader, administrators
//     included (once its message or channel is deleted there is
//     no label left to check consent against), except while some
//     user's avatar column points at exactly its URL: an avatar has to be
//     visible to the people who see the messages it sits next to, and the check
//     being by exact URL is what makes the file stop being public the instant
//     the avatar is replaced. A legacy row with no uploader (NULL uploader_id)
//     is denied rather than served to any authenticated caller.
//   - A labelled channel's attachment needs the caller's own NSFW
//     acknowledgement, administrators included (checkNSFWConsent).
//
// Refusals stay distinguishable, so a caller can tell "not yours" from "not
// there": a missing attachment answers 404, a permission failure 403, and an
// unacknowledged NSFW label 403 with its own NSFW_ACKNOWLEDGEMENT_REQUIRED
// code (api/upload_handler.go).
func (s *UploadService) Authorize(ctx context.Context, aa *db.AttachmentAccess, actor *db.User, role *db.Role) error {
	if aa == nil {
		return fmt.Errorf("attachment not found%.0w", ErrNotFound)
	}

	if aa.ChannelID != nil && aa.ChannelType == "dm" {
		if actor == nil {
			return errFileForbidden()
		}
		ok, dmErr := s.st.IsDMParticipant(ctx, actor.ID, *aa.ChannelID)
		if dmErr != nil || !ok {
			return errFileForbidden()
		}
	}

	isAdmin := role != nil && permissions.HasAdmin(role.Permissions)

	// Ordinary channel visibility runs BEFORE the NSFW consent check
	// (previously reversed). A non-viewer without READ_MESSAGES must get the
	// exact same refusal (FORBIDDEN, via errFileForbidden) whether or not the
	// channel happens to be labelled — checking consent first would answer a
	// non-viewer with a DIFFERENT code (NSFW_ACKNOWLEDGEMENT_REQUIRED) only
	// for a labelled channel, disclosing the label's existence to someone who
	// cannot see the channel at all. Same admin exemption this gate always
	// had; the admin-refusing consent check still runs next.
	if aa.ChannelID != nil && aa.ChannelType != "dm" && !isAdmin {
		if actor == nil || !s.perms.HasChannelPerm(ctx, actor.ID, *aa.ChannelID, permissions.ReadMessages) {
			return errFileForbidden()
		}
	}

	if aa.ChannelID == nil {
		return s.authorizeUnlinked(ctx, aa, actor)
	}
	return s.checkNSFWConsent(ctx, aa, actor)
}

// checkNSFWConsent is Authorize's NSFW consent gate: an administrator
// without a row is refused exactly like anyone else — no bit and no admin
// bypass skips this. DMs cannot be labelled, so this only ever applies to a
// non-DM linked channel.
func (s *UploadService) checkNSFWConsent(ctx context.Context, aa *db.AttachmentAccess, actor *db.User) error {
	if aa.ChannelID == nil || aa.ChannelType == "dm" || !aa.ChannelNSFW {
		return nil
	}
	if actor == nil {
		return errFileForbidden()
	}
	ok, ackErr := s.st.HasNSFWAcknowledgement(ctx, actor.ID, *aa.ChannelID)
	if ackErr != nil {
		slog.Error("failed to check NSFW acknowledgement", "attachment_id", aa.ID, "error", ackErr)
		return errFileForbidden()
	}
	if !ok {
		return fmt.Errorf("%w", permissions.ErrNSFWUnacknowledged)
	}
	return nil
}

// authorizeUnlinked is Authorize's branch for an attachment no message claims:
// the uploader may read it, everyone may while it is somebody's avatar or profile banner, and the
// members of a group DM may while it is that group's live icon.
func (s *UploadService) authorizeUnlinked(ctx context.Context, aa *db.AttachmentAccess, actor *db.User) error {
	// A failed lookup is not a grant and not a refusal: it falls through to
	// the ownership check below, which is the answer this file would have had
	// before any avatar pointed at it.
	isAvatar, avatarErr := s.st.IsAvatarFileURL(ctx, AvatarFileURL(aa.ID))
	if avatarErr != nil {
		slog.Error("failed to check avatar file", "id", aa.ID, "error", avatarErr)
	}
	if isAvatar {
		return nil
	}
	if s.isLiveBanner(ctx, aa.ID) {
		return nil
	}
	if s.isGroupIconFor(ctx, aa.ID, actor) {
		return nil
	}
	switch {
	case aa.UploaderID == nil:
		slog.Warn("legacy attachment access denied (NULL uploader_id)", "id", aa.ID)
		return errFileForbidden()
	case actor == nil || *aa.UploaderID != actor.ID:
		return errFileForbidden()
	}
	return nil
}

// isLiveBanner reports whether the attachment is some user's current profile
// banner. Like the avatar rule, the grant lasts exactly while banner_id names
// the file; a replaced or cleared banner is refused. A failed lookup is not a
// grant: it falls through to the uploader check.
func (s *UploadService) isLiveBanner(ctx context.Context, fileID string) bool {
	if s.banners == nil {
		return false
	}
	ok, err := s.banners.IsBannerFile(ctx, fileID)
	if err != nil {
		slog.Error("failed to check banner file", "id", fileID, "error", err)
		return false
	}
	return ok
}

// isGroupIconFor reports whether the attachment is the live icon of a group the
// actor is a member of. A failed lookup is not a grant: it falls through to the
// uploader check.
func (s *UploadService) isGroupIconFor(ctx context.Context, fileID string, actor *db.User) bool {
	if actor == nil {
		return false
	}
	ok, err := s.st.IsGroupDMIconForUser(ctx, fileID, actor.ID)
	if err != nil {
		slog.Error("failed to check group icon file", "id", fileID, "error", err)
		return false
	}
	return ok
}

// errFileForbidden is the single refusal every access check answers with, so
// no branch can leak which rule refused it.
func errFileForbidden() error {
	return fmt.Errorf("you do not have access to this file%.0w", ErrForbidden)
}
