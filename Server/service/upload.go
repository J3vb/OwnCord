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
	// quota is the per-user byte counter's in-process half (B5-2); see
	// storage_quota.go.
	quota storageQuota
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
}

// Record inserts the attachment row for a stored file. The row is unlinked
// (message_id NULL) until a message claims it, which is what makes it private
// to its uploader in the meantime (see Authorize).
//
// res is the reservation the bytes were written under (B5-2). The row insert
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
	if err := s.st.CreateAttachment(ctx, rec.ID, rec.UploaderID, rec.Filename,
		rec.ID, rec.MimeType, rec.Size, rec.Width, rec.Height); err != nil {
		return fmt.Errorf("%w: failed to save attachment: %w", ErrInternal, err)
	}
	if res != nil {
		res.commitLocked()
	}
	return nil
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
//     PermissionService.RequireChannelAccess, checkSendPermission), none of
//     which have an admin bypass, and it is checked ahead of the admin branch
//     so that branch cannot skip it.
//   - An administrator may read anything else.
//   - An unlinked attachment is private to its uploader, except while some
//     user's avatar column points at exactly its URL: an avatar has to be
//     visible to the people who see the messages it sits next to, and the check
//     being by exact URL is what makes the file stop being public the instant
//     the avatar is replaced. A legacy row with no uploader (NULL uploader_id)
//     is denied rather than served to any authenticated caller (M-2).
//   - A linked attachment in a guild channel needs READ_MESSAGES there.
//
// Every refusal answers with one message, so a caller cannot tell an
// attachment it may not read from one that does not exist.
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

	if role != nil && permissions.HasAdmin(role.Permissions) {
		return nil
	}

	if aa.ChannelID == nil {
		return s.authorizeUnlinked(ctx, aa, actor)
	}
	if aa.ChannelType != "dm" {
		if actor == nil || !s.perms.HasChannelPerm(ctx, actor.ID, *aa.ChannelID, permissions.ReadMessages) {
			return errFileForbidden()
		}
	}
	return nil
}

// authorizeUnlinked is Authorize's branch for an attachment no message claims:
// the uploader may read it, and so may everyone while it is somebody's avatar.
func (s *UploadService) authorizeUnlinked(ctx context.Context, aa *db.AttachmentAccess, actor *db.User) error {
	// A failed lookup is not a grant and not a refusal: it falls through to
	// the ownership check below, which is the answer this file would have had
	// before any avatar pointed at it.
	isAvatar, avatarErr := s.st.IsAvatarFileURL(ctx, AvatarFileURL(aa.ID))
	if avatarErr != nil {
		slog.Error("failed to check avatar file", "id", aa.ID, "error", avatarErr)
	}
	switch {
	case isAvatar:
		return nil
	case aa.UploaderID == nil:
		slog.Warn("legacy attachment access denied (NULL uploader_id)", "id", aa.ID)
		return errFileForbidden()
	case actor == nil || *aa.UploaderID != actor.ID:
		return errFileForbidden()
	}
	return nil
}

// errFileForbidden is the single refusal every access check answers with, so
// no branch can leak which rule refused it.
func errFileForbidden() error {
	return fmt.Errorf("you do not have access to this file%.0w", ErrForbidden)
}
