package service

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
)

// OwnUploadStore is the slice of the database a user's own upload list reads and
// writes beyond Store.
type OwnUploadStore interface {
	ListOwnUploads(ctx context.Context, q db.OwnUploadQuery) ([]db.OwnUpload, error)
	DeleteOwnAttachment(ctx context.Context, id string, userID int64) (removed db.RemovedAttachment, found bool, err error)
	OwnAttachmentInUse(ctx context.Context, id string, userID int64) (inUse, exists bool, err error)
	AttachmentStoredNameInUse(ctx context.Context, storedAs string) (bool, error)
}

var _ OwnUploadStore = (*db.DB)(nil)

// Page bounds and the longest file name search of the own upload list.
const (
	OwnUploadsDefaultLimit = 50
	OwnUploadsMaxLimit     = 100
	OwnUploadNameMaxLen    = 100
	maxOwnUploadCursorLen  = 200
)

// uploadInUseError is ErrUploadInUse: a conflict the API answers with its own
// message.
type uploadInUseError struct{}

func (uploadInUseError) Error() string {
	return "this file is in use as a profile picture, banner or group icon; change that first"
}
func (uploadInUseError) Unwrap() error { return ErrConflict }

// ErrUploadInUse means the file is a live avatar, profile banner or group DM
// icon, so removing it would break that surface. It wraps ErrConflict.
var ErrUploadInUse error = uploadInUseError{}

// StorageSummary is what a user has uploaded against what they may. QuotaBytes 0
// means no limit.
type StorageSummary struct {
	UsedBytes  int64 `json:"used_bytes"`
	QuotaBytes int64 `json:"quota_bytes"`
}

// OwnUploadsRequest is one list call. Sort is db.UploadSortNewest (also for "")
// or db.UploadSortLargest. Cursor is a previous page's NextCursor.
type OwnUploadsRequest struct {
	Sort   string
	Name   string
	Cursor string
	Limit  int
}

// OwnUploadsPage is one page of a user's uploads. NextCursor is "" on the last
// page.
type OwnUploadsPage struct {
	Items      []db.OwnUpload `json:"items"`
	NextCursor string         `json:"next_cursor,omitempty"`
}

// QuotaBytes reports the per-user quota (0 means unlimited).
func (s *UploadService) QuotaBytes() int64 {
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	return s.quota.limits.UserQuotaBytes
}

// StorageSummary reports userID's counted bytes and the quota. A user who has
// never uploaded has no counter row and reads as 0.
func (s *UploadService) StorageSummary(ctx context.Context, userID int64) (StorageSummary, error) {
	used, err := s.StorageUsed(ctx, userID)
	if err != nil {
		return StorageSummary{}, fmt.Errorf("%w: storage used: %w", ErrInternal, err)
	}
	return StorageSummary{UsedBytes: used, QuotaBytes: s.QuotaBytes()}, nil
}

func (s *UploadService) ownStore() (OwnUploadStore, error) {
	if s.own == nil {
		return nil, fmt.Errorf("%w: the upload list is not available", ErrInternal)
	}
	return s.own, nil
}

// ListOwnUploads returns one page of the files userID uploaded, in any state.
func (s *UploadService) ListOwnUploads(ctx context.Context, userID int64, in OwnUploadsRequest) (OwnUploadsPage, error) {
	st, err := s.ownStore()
	if err != nil {
		return OwnUploadsPage{}, err
	}
	sort := in.Sort
	switch sort {
	case "":
		sort = db.UploadSortNewest
	case db.UploadSortNewest, db.UploadSortLargest:
	default:
		return OwnUploadsPage{}, fmt.Errorf("%w: sort must be newest or largest", ErrBadRequest)
	}
	name := strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(name) > OwnUploadNameMaxLen {
		return OwnUploadsPage{}, fmt.Errorf("%w: q is at most %d characters", ErrBadRequest, OwnUploadNameMaxLen)
	}
	q := db.OwnUploadQuery{UserID: userID, Sort: sort, Name: name}
	if in.Cursor != "" {
		cur, cerr := parseOwnUploadCursor(sort, in.Cursor)
		if cerr != nil {
			return OwnUploadsPage{}, cerr
		}
		q.Cursor = cur
	}
	limit := in.Limit
	if limit <= 0 {
		limit = OwnUploadsDefaultLimit
	}
	limit = min(limit, OwnUploadsMaxLimit)
	q.Limit = limit + 1

	items, err := st.ListOwnUploads(ctx, q)
	if err != nil {
		return OwnUploadsPage{}, fmt.Errorf("%w: list own uploads: %w", ErrInternal, err)
	}
	var page OwnUploadsPage
	if len(items) > limit {
		items = items[:limit]
		page.NextCursor = formatOwnUploadCursor(sort, items[limit-1])
	}
	page.Items = items
	return page, nil
}

// formatOwnUploadCursor renders the last item's sort key and id as an opaque
// token: "n|<uploaded_at>|<id>" or "l|<size>|<id>", base64url encoded.
func formatOwnUploadCursor(sort string, last db.OwnUpload) string {
	raw := "n|" + last.UploadedAt + "|" + last.Attachment.ID
	if sort == db.UploadSortLargest {
		raw = "l|" + strconv.FormatInt(last.Attachment.Size, 10) + "|" + last.Attachment.ID
	}
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// parseOwnUploadCursor reads a next_cursor value back. A cursor made for the
// other sort order is refused: its key means something else here.
func parseOwnUploadCursor(sort, raw string) (db.OwnUploadCursor, error) {
	bad := fmt.Errorf("%w: cursor must be a next_cursor value from a previous page", ErrBadRequest)
	if len(raw) > maxOwnUploadCursorLen {
		return db.OwnUploadCursor{}, bad
	}
	dec, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return db.OwnUploadCursor{}, bad
	}
	parts := strings.Split(string(dec), "|")
	if len(parts) != 3 || !validCursorID(parts[2]) {
		return db.OwnUploadCursor{}, bad
	}
	cur := db.OwnUploadCursor{ID: parts[2]}
	switch {
	case sort == db.UploadSortNewest && parts[0] == "n":
		if !validUploadTimestamp(parts[1]) {
			return db.OwnUploadCursor{}, bad
		}
		cur.UploadedAt = parts[1]
	case sort == db.UploadSortLargest && parts[0] == "l":
		size, perr := strconv.ParseInt(parts[1], 10, 64)
		if perr != nil || size < 0 {
			return db.OwnUploadCursor{}, bad
		}
		cur.Size = size
	default:
		return db.OwnUploadCursor{}, bad
	}
	return cur, nil
}

// validCursorID reports whether id is non-empty and only letters, digits and
// dashes, the characters of an attachment id.
func validCursorID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if r != '-' && (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return false
		}
	}
	return true
}

// RemoveOwnUpload deletes a file userID uploaded, wherever it sits: unsent, in a
// message, or in a message since deleted. A live avatar, profile banner or group
// icon is refused with ErrUploadInUse; an unknown id, someone else's file or one
// already gone is ErrNotFound. It returns the removed row for the caller to act
// on: delete the bytes, and tell the message's readers.
//
// Like Discard, the delete and the recount share the quota lock. Only one of two
// callers racing on a row gets it back from the DELETE; the loser reads
// ErrNotFound and never recounts, and the counter is recomputed from the rows, so
// the bytes can never be released twice. A recount that fails leaves the counter
// high, the safe side, for the next sweep to lower; the row is gone, so the
// removal still reports success.
func (s *UploadService) RemoveOwnUpload(ctx context.Context, fileID string, userID int64) (db.RemovedAttachment, error) {
	st, err := s.ownStore()
	if err != nil {
		return db.RemovedAttachment{}, err
	}
	s.quota.mu.Lock()
	defer s.quota.mu.Unlock()
	removed, found, err := st.DeleteOwnAttachment(ctx, fileID, userID)
	if err != nil {
		return db.RemovedAttachment{}, fmt.Errorf("%w: failed to remove upload: %w", ErrInternal, err)
	}
	if !found {
		inUse, exists, lookupErr := st.OwnAttachmentInUse(ctx, fileID, userID)
		if lookupErr != nil {
			return db.RemovedAttachment{}, fmt.Errorf("%w: failed to look up upload: %w", ErrInternal, lookupErr)
		}
		if exists && inUse {
			return db.RemovedAttachment{}, ErrUploadInUse
		}
		return db.RemovedAttachment{}, fmt.Errorf("upload not found%.0w", ErrNotFound)
	}
	// Detached: the row is gone, so a caller that hung up must still see its
	// space back.
	if rcErr := s.recountLocked(context.WithoutCancel(ctx), userID); rcErr != nil {
		slog.Warn("own upload removed; storage recount failed, the next recount will fix the counter", "user_id", userID, "error", rcErr)
	}
	return removed, nil
}

// StoredFileShared reports whether another attachment row still names storedAs,
// in which case the bytes must stay. Forwards normally clone to a new name, so
// this is a guard against deleting a file something else still serves.
func (s *UploadService) StoredFileShared(ctx context.Context, storedAs string) (bool, error) {
	st, err := s.ownStore()
	if err != nil {
		return false, err
	}
	shared, err := st.AttachmentStoredNameInUse(ctx, storedAs)
	if err != nil {
		return false, fmt.Errorf("%w: stored name lookup: %w", ErrInternal, err)
	}
	return shared, nil
}

// validUploadTimestamp reports whether s looks like a stored upload time: digits
// and the separators SQLite and RFC 3339 use. The cursor only hands it back to
// SQL as a bound argument, so this guards the size and shape, not the date.
func validUploadTimestamp(s string) bool {
	if s == "" || len(s) > 40 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && !strings.ContainsRune("-: TZ.+", r) {
			return false
		}
	}
	return true
}
