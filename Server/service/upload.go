package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

type uploadStore interface {
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
	HasNSFWAcknowledgement(ctx context.Context, userID, channelID int64) (bool, error)
	CreateAttachmentVoice(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height, durationMs *int, waveform *string) error
	GetAttachmentWithChannel(ctx context.Context, id string) (*db.AttachmentAccess, error)
	DeleteUnlinkedAttachment(ctx context.Context, id string, userID int64) (bool, error)
	DiscardUnlinkedAttachment(ctx context.Context, id string, userID int64) (storedAs string, found bool, err error)
	// IsMessageDeleted backs the tombstone half of attachment access; the avatar check backs "public exactly
	// while in use".
	IsMessageDeleted(ctx context.Context, id int64) (deleted, found bool, err error)
	IsAvatarFileURL(ctx context.Context, url string) (bool, error)
	IsGroupDMIconForUser(ctx context.Context, fileID string, userID int64) (bool, error)
	// The per-user upload byte counter: charged before a store write, released on a failed one, recounted on the
	// maintenance tick.
	ChargeUserStorage(ctx context.Context, userID, bytes, quota int64) (bool, error)
	ReleaseUserStorage(ctx context.Context, userID, bytes int64) error
	UserStorageUsed(ctx context.Context, userID int64) (int64, error)
	ListUserStorageIDs(ctx context.Context) ([]int64, error)
	RecountUserStorage(ctx context.Context, userID int64) error
	GetSetting(ctx context.Context, key string) (string, error)
}

// UploadService owns what happens to an uploaded file once its bytes are on disk: the attachment row, and the
// questions before serving it back (still servable, may this caller read it). Bytes, type sniffing and
// FileStore writes stay with the transport.
type UploadService struct {
	st    uploadStore
	perms *PermissionService
	// banners answers whether a file is some user's live profile banner; nil means no banner is readable via the
	// grant (fails closed).
	banners BannerFileStore
	quota   storageQuota
	// cloner is the storage a forward clones files in; guarded by quota.mu, nil until installed.
	cloner FileCloner
	// own backs the signed-in user's own upload list and removal (user_uploads.go); nil when the store cannot
	// serve it.
	own OwnUploadStore
	// admin backs the admin Storage page and per-member upload limit; nil means every member follows the
	// server-wide limit.
	admin AdminUploadStore
}

var _ BannerFileStore = (*db.DB)(nil)

// StagedUploadLifetime is how long an upload no message names is kept before the maintenance sweep deletes it
// (a draft can sit through a sleep or reconnect); the uploader's quota stays charged. Clients learn it from
// auth_ok's upload_policy.
const StagedUploadLifetime = 24 * time.Hour

// BannerFileStore answers whether an attachment is named by some user's banner_id right now.
type BannerFileStore interface {
	IsBannerFile(ctx context.Context, fileID string) (bool, error)
}

// NewUploadService creates an UploadService.
func NewUploadService(st uploadStore, perms *PermissionService) *UploadService {
	own, _ := st.(OwnUploadStore)
	admin, _ := st.(AdminUploadStore)
	return &UploadService{st: st, perms: perms, own: own, admin: admin}
}

// AttachmentRecord is the metadata of one stored file whose bytes the caller has validated and written.
type AttachmentRecord struct {
	ID            string
	UploaderID    int64
	Filename      string
	MimeType      string
	Size          int64
	Width, Height *int
	// DurationMs and Waveform are set only for a voice message (clip length in ms, unpadded base64url amplitude
	// bytes); both nil, or both set.
	DurationMs *int
	Waveform   *string
}

// Record inserts the attachment row for a stored file. It stays unlinked (message_id NULL) until a message
// claims it, private to its uploader meanwhile (see Authorize). The insert and res's commit share one
// critical section so a recount never sees the file in both rows and in flight; on failure the caller's
// Settle releases it. A failure leaves orphaned bytes the caller must delete: the orphan sweep reclaims only
// rows.
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

// Unrecord undoes Record for an unused file: deletes the unlinked row and recounts. The caller deletes the
// bytes.
func (s *UploadService) Unrecord(ctx context.Context, fileID string, userID int64) error {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	if _, err := s.st.DeleteUnlinkedAttachment(ctx, fileID, userID); err != nil {
		return fmt.Errorf("%w: failed to remove attachment: %w", ErrInternal, err)
	}
	return s.recountLocked(ctx, userID)
}

// Discard withdraws a file userID uploaded and never sent: deletes the unlinked row (never a live avatar) and
// recounts. Returns the stored name for the caller to delete, or ErrNotFound when there is no such file, it
// is someone else's, or a message holds it.
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

// Resolve looks up the attachment behind fileID and applies the checks that make it unservable for everyone.
// A soft-deleted message's attachments stop being servable at once (else the file stays reachable by URL
// forever, as no sweep reclaims a linked row); it is here, not in Authorize, so it covers administrators too.
// A linked attachment whose message row is gone is left to Authorize, which sees it as unlinked-shaped.
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

// Authorize decides whether actor may read aa; actor and role may be nil, which denies everything an
// unauthenticated caller could reach. Rules:   - DM participation is required of everyone, administrators
// included, checked ahead of the admin branch so     it cannot skip it.   - A linked attachment in a guild
// channel needs READ_MESSAGES (administrators exempt).   - An unlinked attachment is private to its uploader,
// administrators included, except while some user's     avatar column points at exactly its URL (so it stops
// being public the instant the avatar is replaced); a     legacy row with NULL uploader_id is denied.   - A
// labelled channel's attachment needs the caller's own NSFW acknowledgement, administrators included
// (checkNSFWConsent). Refusals stay distinguishable: missing 404, permission 403, unacknowledged label 403
// NSFW_ACKNOWLEDGEMENT_REQUIRED (api/upload_handler.go).
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

	if aa.ChannelPending {
		return fmt.Errorf("attachment not found%.0w", ErrNotFound)
	}

	isAdmin := role != nil && permissions.HasAdmin(role.Permissions)

	// Channel visibility runs BEFORE the NSFW consent check: a non-viewer must get the same FORBIDDEN whether or
	// not the channel is labelled, or a different code only for labelled channels would disclose the label. The
	// admin exemption is unchanged.
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

// checkNSFWConsent is Authorize's consent gate: an administrator without a row is refused like anyone else.
// DMs cannot be labelled, so it applies only to a linked non-DM channel.
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

// authorizeUnlinked is Authorize's branch for an attachment no message claims: the uploader may read it;
// everyone may while it is somebody's avatar or profile banner; group DM members may while it is the group's
// live icon.
func (s *UploadService) authorizeUnlinked(ctx context.Context, aa *db.AttachmentAccess, actor *db.User) error {
	// A failed lookup is neither grant nor refusal: it falls through to the ownership check.
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

// isLiveBanner reports whether the attachment is some user's current banner (the grant lasts exactly while
// banner_id names it); a failed lookup is not a grant.
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

// isGroupIconFor reports whether the attachment is the live icon of a group the actor belongs to; a failed
// lookup is not a grant.
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

// errFileForbidden is the single refusal every access check answers with, so no branch leaks which rule
// refused.
func errFileForbidden() error {
	return fmt.Errorf("you do not have access to this file%.0w", ErrForbidden)
}
