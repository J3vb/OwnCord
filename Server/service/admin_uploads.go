package service

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/storage"
)

// AdminUploadStore is the slice of the database the admin Storage page reads and
// writes beyond Store: every member's uploads, their removal, and the per-member
// upload limit.
type AdminUploadStore interface {
	ListAllUploads(ctx context.Context, q db.AdminUploadQuery) ([]db.AdminUpload, error)
	UploadTotals(ctx context.Context) ([]db.UploadKindTotal, error)
	DeleteAttachmentByAdmin(ctx context.Context, id string) (removed db.AdminRemovedAttachment, found bool, err error)
	AttachmentInUse(ctx context.Context, id string) (inUse, exists bool, err error)
	UserStorageQuotaMB(ctx context.Context, userID int64) (*int64, error)
	SetUserStorageQuotaMB(ctx context.Context, userID int64, quotaMB *int64) (found bool, err error)
	ListMemberStorage(ctx context.Context, userIDs []int64) ([]db.MemberStorage, error)
	ReferencedStoredFiles(ctx context.Context, names []string) (map[string]bool, error)
}

var _ AdminUploadStore = (*db.DB)(nil)

// The Storage page's row types, named here so the admin transport reads them
// from the service rather than importing db.
type (
	UploadKindTotal    = db.UploadKindTotal
	MemberStorage      = db.MemberStorage
	AdminRemovedUpload = db.AdminRemovedAttachment
)

// Bounds of the admin Storage page.
const (
	// AdminRemoveMaxFiles is the most files one bulk delete takes.
	AdminRemoveMaxFiles = 100
	// MemberStorageMaxIDs is the most members one storage lookup reads.
	MemberStorageMaxIDs = 100
	// MemberQuotaMaxMB caps a per-member limit at about 10 TB, far above any disk,
	// so the byte figure never overflows.
	MemberQuotaMaxMB = 10_000_000
	// LeftoverMinAge is how old a file nothing names must be before the Storage
	// page counts or removes it, so an upload still in progress is never touched.
	LeftoverMinAge = 24 * time.Hour
	// LeftoverCleanupMax is the most leftover files one cleanup removes.
	LeftoverCleanupMax = 1000
)

// AdminUploadsRequest is one page of the Storage page's file list. OlderThanDays
// 0 means any age; Kind "" means every kind.
type AdminUploadsRequest struct {
	Sort          string
	Name          string
	Kind          string
	UploaderID    int64
	ChannelID     int64
	OlderThanDays int
	Cursor        string
	Limit         int
}

// AdminUploadsPage is one page of every member's uploads. NextCursor is "" on the
// last page.
type AdminUploadsPage struct {
	Items      []db.AdminUpload `json:"items"`
	NextCursor string           `json:"next_cursor,omitempty"`
}

// LeftoverScan is what the storage directory holds that no row names and is old
// enough to remove.
type LeftoverScan struct {
	Count int   `json:"count"`
	Bytes int64 `json:"bytes"`
}

func (s *UploadService) adminStore() (AdminUploadStore, error) {
	if s.admin == nil {
		return nil, fmt.Errorf("%w: the storage page is not available", ErrInternal)
	}
	return s.admin, nil
}

// effectiveQuotaLocked is userID's upload limit in bytes (0 is unlimited): their
// own limit when an admin set one, else the server-wide one. The caller holds
// quota.mu.
func (s *UploadService) effectiveQuotaLocked(ctx context.Context, userID int64) (int64, error) {
	base := s.quota.limits.UserQuotaBytes
	if s.admin == nil {
		return base, nil
	}
	mb, err := s.admin.UserStorageQuotaMB(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("%w: storage limit: %w", ErrInternal, err)
	}
	if mb == nil {
		return base, nil
	}
	return *mb << 20, nil
}

// ListAllUploads returns one page of every member's uploads, for the Storage page.
func (s *UploadService) ListAllUploads(ctx context.Context, in AdminUploadsRequest) (AdminUploadsPage, error) {
	st, err := s.adminStore()
	if err != nil {
		return AdminUploadsPage{}, err
	}
	q, limit, err := adminUploadQuery(in, time.Now())
	if err != nil {
		return AdminUploadsPage{}, err
	}
	items, err := st.ListAllUploads(ctx, q)
	if err != nil {
		return AdminUploadsPage{}, fmt.Errorf("%w: list uploads: %w", ErrInternal, err)
	}
	var page AdminUploadsPage
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		page.NextCursor = formatUploadCursor(q.Sort, last.UploadedAt, last.Attachment.Size, last.Attachment.ID)
	}
	page.Items = items
	return page, nil
}

// adminUploadQuery checks a list request and turns it into the database query,
// asking for one row past the page so the caller knows whether more follow.
func adminUploadQuery(in AdminUploadsRequest, now time.Time) (db.AdminUploadQuery, int, error) {
	q := db.AdminUploadQuery{Sort: in.Sort, Kind: in.Kind, UploaderID: in.UploaderID, ChannelID: in.ChannelID}
	switch q.Sort {
	case "":
		q.Sort = db.UploadSortLargest
	case db.UploadSortNewest, db.UploadSortLargest:
	default:
		return q, 0, fmt.Errorf("%w: sort must be newest or largest", ErrBadRequest)
	}
	switch q.Kind {
	case "", db.UploadKindImage, db.UploadKindVideo, db.UploadKindAudio, db.UploadKindOther:
	default:
		return q, 0, fmt.Errorf("%w: kind must be image, video, audio or other", ErrBadRequest)
	}
	if in.UploaderID < 0 || in.ChannelID < 0 {
		return q, 0, fmt.Errorf("%w: uploader and channel must be ids", ErrBadRequest)
	}
	if in.OlderThanDays < 0 || in.OlderThanDays > 36500 {
		return q, 0, fmt.Errorf("%w: older_than_days must be between 0 and 36500", ErrBadRequest)
	}
	if in.OlderThanDays > 0 {
		q.Before = now.UTC().AddDate(0, 0, -in.OlderThanDays).Format(dbtime.SQLiteLayout)
	}
	q.Name = strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(q.Name) > OwnUploadNameMaxLen {
		return q, 0, fmt.Errorf("%w: q is at most %d characters", ErrBadRequest, OwnUploadNameMaxLen)
	}
	if in.Cursor != "" {
		cur, err := parseOwnUploadCursor(q.Sort, in.Cursor)
		if err != nil {
			return q, 0, err
		}
		q.Cursor = cur
	}
	limit := in.Limit
	if limit <= 0 {
		limit = OwnUploadsDefaultLimit
	}
	limit = min(limit, OwnUploadsMaxLimit)
	q.Limit = limit + 1
	return q, limit, nil
}

// UploadTotals reports how many files of each kind the server holds and their
// bytes.
func (s *UploadService) UploadTotals(ctx context.Context) ([]UploadKindTotal, error) {
	st, err := s.adminStore()
	if err != nil {
		return nil, err
	}
	totals, err := st.UploadTotals(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: upload totals: %w", ErrInternal, err)
	}
	return totals, nil
}

// RemoveUploadAsAdmin deletes one file whoever uploaded it, with the same rules
// as RemoveOwnUpload: a live avatar, banner or group icon is ErrUploadInUse, an
// unknown or already removed file is ErrNotFound. The delete and the uploader's
// recount share the quota lock with a member's own removal and with uploads, so
// when an admin and the member remove the same file at once exactly one gets the
// row and the bytes are given back once. A removal is audited against the
// uploader.
func (s *UploadService) RemoveUploadAsAdmin(ctx context.Context, actorID int64, fileID string) (AdminRemovedUpload, error) {
	st, err := s.adminStore()
	if err != nil {
		return AdminRemovedUpload{}, err
	}
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	removed, found, err := st.DeleteAttachmentByAdmin(ctx, fileID)
	if err != nil {
		return AdminRemovedUpload{}, fmt.Errorf("%w: failed to remove upload: %w", ErrInternal, err)
	}
	if !found {
		inUse, exists, lookupErr := st.AttachmentInUse(ctx, fileID)
		if lookupErr != nil {
			return AdminRemovedUpload{}, fmt.Errorf("%w: failed to look up upload: %w", ErrInternal, lookupErr)
		}
		if exists && inUse {
			return AdminRemovedUpload{}, ErrUploadInUse
		}
		return AdminRemovedUpload{}, fmt.Errorf("upload not found%.0w", ErrNotFound)
	}
	if removed.UploaderID != nil {
		if rcErr := s.recountLocked(context.WithoutCancel(ctx), *removed.UploaderID); rcErr != nil {
			slog.Warn("upload removed by an admin; storage recount failed, the next recount will fix the counter", "user_id", *removed.UploaderID, "error", rcErr)
		}
	}
	var target int64
	if removed.UploaderID != nil {
		target = *removed.UploaderID
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "upload_delete", "user", target,
		fmt.Sprintf("deleted file %q (%d bytes)", removed.Filename, removed.Size))
	return removed, nil
}

// SetMemberQuota sets userID's own upload limit in MB: nil returns them to the
// server-wide limit, 0 lifts the limit for them. An unknown user is ErrNotFound.
// The change is audited.
func (s *UploadService) SetMemberQuota(ctx context.Context, actorID, userID int64, quotaMB *int64) error {
	st, err := s.adminStore()
	if err != nil {
		return err
	}
	if quotaMB != nil && (*quotaMB < 0 || *quotaMB > MemberQuotaMaxMB) {
		return fmt.Errorf("%w: quota_mb must be between 0 and %d", ErrBadRequest, MemberQuotaMaxMB)
	}
	found, err := st.SetUserStorageQuotaMB(ctx, userID, quotaMB)
	if err != nil {
		return fmt.Errorf("%w: set storage limit: %w", ErrInternal, err)
	}
	if !found {
		return fmt.Errorf("user not found%.0w", ErrNotFound)
	}
	detail := "upload limit set to the server default"
	switch {
	case quotaMB == nil:
	case *quotaMB == 0:
		detail = "upload limit removed"
	default:
		detail = fmt.Sprintf("upload limit set to %d MB", *quotaMB)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "upload_limit_change", "user", userID, detail)
	return nil
}

// AuditLeftoverCleanup records that actorID removed n leftover files.
func (s *UploadService) AuditLeftoverCleanup(ctx context.Context, actorID int64, n int) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "storage_cleanup", "server", 0,
		fmt.Sprintf("removed %d leftover files", n))
}

// MemberStorage reads the counted bytes and own limit of up to
// MemberStorageMaxIDs members. A member missing from the answer has uploaded
// nothing and follows the server-wide limit.
func (s *UploadService) MemberStorage(ctx context.Context, userIDs []int64) ([]MemberStorage, error) {
	st, err := s.adminStore()
	if err != nil {
		return nil, err
	}
	if len(userIDs) > MemberStorageMaxIDs {
		return nil, fmt.Errorf("%w: at most %d ids", ErrBadRequest, MemberStorageMaxIDs)
	}
	rows, err := st.ListMemberStorage(ctx, userIDs)
	if err != nil {
		return nil, fmt.Errorf("%w: member storage: %w", ErrInternal, err)
	}
	return rows, nil
}

// LeftoverStore is the upload directory a leftover cleanup lists and deletes
// from; *storage.Storage satisfies it.
type LeftoverStore interface {
	StorageLister
	Delete(name string) error
}

// leftovers lists the files in the storage directory that no attachment, emoji
// or sticker row names and that are older than cutoff.
func (s *UploadService) leftovers(ctx context.Context, lister StorageLister, cutoff time.Time) ([]storage.Entry, error) {
	st, err := s.adminStore()
	if err != nil {
		return nil, err
	}
	if lister == nil {
		return nil, nil
	}
	entries, err := lister.List()
	if err != nil {
		return nil, fmt.Errorf("%w: list storage: %w", ErrInternal, err)
	}
	old := make([]storage.Entry, 0, len(entries))
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.ModTime.Before(cutoff) {
			old = append(old, e)
			names = append(names, e.Name)
		}
	}
	if len(names) == 0 {
		return nil, nil
	}
	referenced, err := st.ReferencedStoredFiles(ctx, names)
	if err != nil {
		return nil, fmt.Errorf("%w: stored names: %w", ErrInternal, err)
	}
	out := old[:0]
	for _, e := range old {
		if !referenced[e.Name] {
			out = append(out, e)
		}
	}
	return out, nil
}

// ScanLeftovers counts the leftover files older than cutoff and their bytes.
func (s *UploadService) ScanLeftovers(ctx context.Context, lister StorageLister, cutoff time.Time) (LeftoverScan, error) {
	files, err := s.leftovers(ctx, lister, cutoff)
	if err != nil {
		return LeftoverScan{}, err
	}
	var scan LeftoverScan
	for _, e := range files {
		scan.Count++
		scan.Bytes += e.Size
	}
	return scan, nil
}

// CleanLeftovers deletes up to limit leftover files older than cutoff and
// reports how many went. A file that will not delete is skipped and stays in
// the next scan. The age floor keeps an upload whose row is not written yet out
// of reach; a file named again after the scan is checked once more just before
// its delete.
func (s *UploadService) CleanLeftovers(ctx context.Context, files LeftoverStore, cutoff time.Time, limit int) (int, error) {
	if files == nil || limit <= 0 {
		return 0, nil
	}
	list, err := s.leftovers(ctx, files, cutoff)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, e := range list {
		if removed >= limit {
			break
		}
		if err := ctx.Err(); err != nil {
			return removed, err
		}
		if named, err := s.admin.ReferencedStoredFiles(ctx, []string{e.Name}); err != nil || named[e.Name] {
			continue
		}
		if err := files.Delete(e.Name); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("storage page: a leftover file could not be removed", "error", err)
			continue
		}
		removed++
	}
	return removed, nil
}
