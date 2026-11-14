package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// LinkPreview is one stored link card. Failure is nil for a fetched card.
type LinkPreview = dbgen.LinkPreview

// LinkPreviewImage is the row of one thumbnail file, named by its hash.
type LinkPreviewImage = dbgen.LinkPreviewImage

// LinkPreviewCard is a message's link card joined with its thumbnail row.
// The image fields are nil when the card has no thumbnail, or the sweep has
// deleted it.
type LinkPreviewCard = dbgen.ListMessageLinkPreviewsRow

// LinkPreviewImageRef names a thumbnail row and its size.
type LinkPreviewImageRef = dbgen.ListOldestLinkPreviewImagesRow

// GetLinkPreview returns the card stored under urlHash, or ErrNotFound.
func (d *DB) GetLinkPreview(ctx context.Context, urlHash string) (LinkPreview, error) {
	row, err := d.q.GetLinkPreview(ctx, urlHash)
	if errors.Is(err, sql.ErrNoRows) {
		return LinkPreview{}, fmt.Errorf("GetLinkPreview: %w", ErrNotFound)
	}
	if err != nil {
		return LinkPreview{}, fmt.Errorf("GetLinkPreview: %w", err)
	}
	return row, nil
}

// UpsertLinkPreview stores a card, replacing one fetched earlier under the same hash.
func (d *DB) UpsertLinkPreview(ctx context.Context, p LinkPreview) error {
	if err := d.q.UpsertLinkPreview(ctx, dbgen.UpsertLinkPreviewParams(p)); err != nil {
		return fmt.Errorf("UpsertLinkPreview: %w", err)
	}
	return nil
}

// TouchLinkPreview records that a card was shown at lastUsedAt.
func (d *DB) TouchLinkPreview(ctx context.Context, urlHash, lastUsedAt string) error {
	if err := d.q.TouchLinkPreview(ctx, dbgen.TouchLinkPreviewParams{LastUsedAt: lastUsedAt, UrlHash: urlHash}); err != nil {
		return fmt.Errorf("TouchLinkPreview: %w", err)
	}
	return nil
}

// GetLinkPreviewImage returns the thumbnail row under hash, or ErrNotFound.
func (d *DB) GetLinkPreviewImage(ctx context.Context, hash string) (LinkPreviewImage, error) {
	row, err := d.q.GetLinkPreviewImage(ctx, hash)
	if errors.Is(err, sql.ErrNoRows) {
		return LinkPreviewImage{}, fmt.Errorf("GetLinkPreviewImage: %w", ErrNotFound)
	}
	if err != nil {
		return LinkPreviewImage{}, fmt.Errorf("GetLinkPreviewImage: %w", err)
	}
	return row, nil
}

// LinkPreviewImageExists reports whether a thumbnail row is stored under hash.
func (d *DB) LinkPreviewImageExists(ctx context.Context, hash string) (bool, error) {
	ok, err := d.q.LinkPreviewImageExists(ctx, hash)
	if err != nil {
		return false, fmt.Errorf("LinkPreviewImageExists: %w", err)
	}
	return ok != 0, nil
}

// InsertLinkPreviewImage records a thumbnail. A hash already stored only has its
// last_used_at refreshed.
func (d *DB) InsertLinkPreviewImage(ctx context.Context, img LinkPreviewImage) error {
	if err := d.q.InsertLinkPreviewImage(ctx, dbgen.InsertLinkPreviewImageParams(img)); err != nil {
		return fmt.Errorf("InsertLinkPreviewImage: %w", err)
	}
	return nil
}

// TouchLinkPreviewImage records that a thumbnail was shown at lastUsedAt.
func (d *DB) TouchLinkPreviewImage(ctx context.Context, hash, lastUsedAt string) error {
	if err := d.q.TouchLinkPreviewImage(ctx, dbgen.TouchLinkPreviewImageParams{LastUsedAt: lastUsedAt, Hash: hash}); err != nil {
		return fmt.Errorf("TouchLinkPreviewImage: %w", err)
	}
	return nil
}

// ListMessageLinkPreviews returns the cards of one message in link order.
func (d *DB) ListMessageLinkPreviews(ctx context.Context, messageID int64) ([]LinkPreviewCard, error) {
	rows, err := d.q.ListMessageLinkPreviews(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("ListMessageLinkPreviews: %w", err)
	}
	return rows, nil
}

// ListLinkPreviewsForMessages returns the cards of many messages, ordered by
// message id then link order, for a page of history. No ids returns none.
func (d *DB) ListLinkPreviewsForMessages(ctx context.Context, messageIDs []int64) ([]LinkPreviewCard, error) {
	if len(messageIDs) == 0 {
		return []LinkPreviewCard{}, nil
	}
	rows, err := d.q.ListLinkPreviewsForMessages(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("ListLinkPreviewsForMessages: %w", err)
	}
	out := make([]LinkPreviewCard, len(rows))
	for i := range rows {
		out[i] = LinkPreviewCard(rows[i])
	}
	return out, nil
}

// ReplaceMessageLinkPreviews makes urlHashes (in order) the links of messageID and
// records the unfurl, in one transaction, only while the message still exists, is not
// deleted, its version (edited_at, else timestamp) equals contentVersion and its text
// equals content, the text the caller parsed. It reports whether it applied; false writes
// nothing. Every hash must already have a stored card.
func (d *DB) ReplaceMessageLinkPreviews(ctx context.Context, messageID int64, contentVersion, content, unfurledAt string, urlHashes []string) (bool, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("ReplaceMessageLinkPreviews begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck
	q := d.q.WithTx(tx)

	// The guarded marker write comes first: it is the transaction's first statement, so
	// the version check and the writes after it see one state of the message.
	n, err := q.UpsertMessageUnfurlIfCurrent(ctx, dbgen.UpsertMessageUnfurlIfCurrentParams{
		UnfurledAt: unfurledAt, ContentVersion: contentVersion, Content: content, MessageID: messageID,
	})
	if err != nil {
		return false, fmt.Errorf("ReplaceMessageLinkPreviews marker: %w", err)
	}
	if n == 0 {
		return false, nil
	}
	if err := q.DeleteMessageLinkPreviews(ctx, messageID); err != nil {
		return false, fmt.Errorf("ReplaceMessageLinkPreviews clear: %w", err)
	}
	for i, h := range urlHashes {
		if err := q.InsertMessageLinkPreview(ctx, dbgen.InsertMessageLinkPreviewParams{
			MessageID: messageID, Position: int64(i), UrlHash: h,
		}); err != nil {
			return false, fmt.Errorf("ReplaceMessageLinkPreviews link %d: %w", i, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("ReplaceMessageLinkPreviews commit: %w", err)
	}
	return true, nil
}

// SumLinkPreviewImageBytes is the total size of every stored thumbnail.
func (d *DB) SumLinkPreviewImageBytes(ctx context.Context) (int64, error) {
	total, err := d.q.SumLinkPreviewImageBytes(ctx)
	if err != nil {
		return 0, fmt.Errorf("SumLinkPreviewImageBytes: %w", err)
	}
	return total, nil
}

// ListOldestLinkPreviewImages returns up to limit thumbnails, least recently used first.
func (d *DB) ListOldestLinkPreviewImages(ctx context.Context, limit int) ([]LinkPreviewImageRef, error) {
	rows, err := d.q.ListOldestLinkPreviewImages(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("ListOldestLinkPreviewImages: %w", err)
	}
	return rows, nil
}

// ListLinkPreviewImagesUnusedBefore returns up to limit thumbnails last used before cutoff.
func (d *DB) ListLinkPreviewImagesUnusedBefore(ctx context.Context, cutoff string, limit int) ([]LinkPreviewImageRef, error) {
	rows, err := d.q.ListLinkPreviewImagesUnusedBefore(ctx, dbgen.ListLinkPreviewImagesUnusedBeforeParams{LastUsedAt: cutoff, Limit: int64(limit)})
	if err != nil {
		return nil, fmt.Errorf("ListLinkPreviewImagesUnusedBefore: %w", err)
	}
	out := make([]LinkPreviewImageRef, len(rows))
	for i, r := range rows {
		out[i] = LinkPreviewImageRef(r)
	}
	return out, nil
}

// ListUnreferencedLinkPreviewImages returns up to limit thumbnails last stored or shown
// before cutoff that no stored card names.
func (d *DB) ListUnreferencedLinkPreviewImages(ctx context.Context, cutoff string, limit int) ([]LinkPreviewImageRef, error) {
	rows, err := d.q.ListUnreferencedLinkPreviewImages(ctx, dbgen.ListUnreferencedLinkPreviewImagesParams{LastUsedAt: cutoff, Limit: int64(limit)})
	if err != nil {
		return nil, fmt.Errorf("ListUnreferencedLinkPreviewImages: %w", err)
	}
	out := make([]LinkPreviewImageRef, len(rows))
	for i, r := range rows {
		out[i] = LinkPreviewImageRef(r)
	}
	return out, nil
}

// DeleteLinkPreviewImage removes a thumbnail row; a card that named it keeps its text
// and loses its image. It reports whether a row existed.
func (d *DB) DeleteLinkPreviewImage(ctx context.Context, hash string) (bool, error) {
	n, err := d.q.DeleteLinkPreviewImage(ctx, hash)
	if err != nil {
		return false, fmt.Errorf("DeleteLinkPreviewImage: %w", err)
	}
	return n > 0, nil
}

// TouchLinkPreviews records that the cards under urlHashes were shown at lastUsedAt, in one statement.
func (d *DB) TouchLinkPreviews(ctx context.Context, urlHashes []string, lastUsedAt string) error {
	if len(urlHashes) == 0 {
		return nil
	}
	if err := d.q.TouchLinkPreviewsByHash(ctx, dbgen.TouchLinkPreviewsByHashParams{LastUsedAt: lastUsedAt, UrlHashes: urlHashes}); err != nil {
		return fmt.Errorf("TouchLinkPreviews: %w", err)
	}
	return nil
}

// TouchLinkPreviewImages records that the thumbnails under hashes were shown at lastUsedAt, in one statement.
func (d *DB) TouchLinkPreviewImages(ctx context.Context, hashes []string, lastUsedAt string) error {
	if len(hashes) == 0 {
		return nil
	}
	if err := d.q.TouchLinkPreviewImagesByHash(ctx, dbgen.TouchLinkPreviewImagesByHashParams{LastUsedAt: lastUsedAt, Hashes: hashes}); err != nil {
		return fmt.Errorf("TouchLinkPreviewImages: %w", err)
	}
	return nil
}

// DeleteUnreferencedLinkPreviews removes the cards last used before cutoff that no message names
// and returns how many it removed.
func (d *DB) DeleteUnreferencedLinkPreviews(ctx context.Context, cutoff string) (int64, error) {
	n, err := d.q.DeleteUnreferencedLinkPreviews(ctx, cutoff)
	if err != nil {
		return 0, fmt.Errorf("DeleteUnreferencedLinkPreviews: %w", err)
	}
	return n, nil
}
