package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// The per-user upload byte counter (migration 044). The attachments rows
// (avatars included) are the truth; this table is the cached aggregate the
// upload path admits against, charged before every store write and recounted on
// the maintenance tick. Emoji are a deliberate exclusion (migration 044). See
// service.UploadService.Reserve for the ordering that keeps it safe.

// ChargeUserStorage adds bytes to userID's counter if the result stays within quota,
// creating the row on first use, and reports whether it was admitted. quota <= 0 is
// unlimited (the counter is still kept). Guard and increment are one UPDATE, so of N
// racing charges exactly those that fit are admitted.
func (d *DB) ChargeUserStorage(ctx context.Context, userID, bytes, quota int64) (bool, error) {
	if err := d.q.EnsureUserStorage(ctx, userID); err != nil {
		return false, fmt.Errorf("ChargeUserStorage ensure: %w", err)
	}
	if quota <= 0 {
		if err := d.q.ChargeUserStorageUnbounded(ctx, dbgen.ChargeUserStorageUnboundedParams{BytesUsed: bytes, UserID: userID}); err != nil {
			return false, fmt.Errorf("ChargeUserStorage: %w", err)
		}
		return true, nil
	}
	n, err := d.q.ChargeUserStorage(ctx, dbgen.ChargeUserStorageParams{Bytes: bytes, UserID: userID, Quota: quota})
	if err != nil {
		return false, fmt.Errorf("ChargeUserStorage: %w", err)
	}
	return n == 1, nil
}

// ReleaseUserStorage returns bytes to userID's counter, floored at zero.
func (d *DB) ReleaseUserStorage(ctx context.Context, userID, bytes int64) error {
	if err := d.q.ReleaseUserStorage(ctx, dbgen.ReleaseUserStorageParams{Bytes: bytes, UserID: userID}); err != nil {
		return fmt.Errorf("ReleaseUserStorage: %w", err)
	}
	return nil
}

// UserStorageUsed reports userID's counter; a user with no row holds nothing.
func (d *DB) UserStorageUsed(ctx context.Context, userID int64) (int64, error) {
	n, err := d.q.GetUserStorage(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("UserStorageUsed: %w", err)
	}
	return n, nil
}

// ListUserStorageIDs lists every user with a counter row, in id order: the recount's worklist.
func (d *DB) ListUserStorageIDs(ctx context.Context) ([]int64, error) {
	ids, err := d.q.ListUserStorageIDs(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListUserStorageIDs: %w", err)
	}
	return ids, nil
}

// RecountUserStorage sets userID's counter to the sum of the attachments rows naming
// the user, avatars included, emoji not; one statement per user, so an interrupted
// sweep leaves every finished user exact.
func (d *DB) RecountUserStorage(ctx context.Context, userID int64) error {
	if err := d.q.RecountUserStorage(ctx, userID); err != nil {
		return fmt.Errorf("RecountUserStorage: %w", err)
	}
	return nil
}

// TotalAttachmentBytes is the metrics storage figure: every attachments row, legacy
// NULL uploader_id included (a total, not a sum of counters; emoji are not in it).
// Cached for statsCacheTTL so a fast scraper does not re-aggregate; a failed query is
// not cached.
func (d *DB) TotalAttachmentBytes(ctx context.Context) (int64, error) {
	return d.attachmentBytesCache.Get(statsCacheTTL, func() (int64, error) {
		n, err := d.q.TotalAttachmentBytes(ctx)
		if err != nil {
			return 0, fmt.Errorf("TotalAttachmentBytes: %w", err)
		}
		return n, nil
	})
}
