package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// GetEmoji returns the emoji with the given id, or (nil, nil) when no such row
// exists. A missing row is not an error: DELETE races and stale client ids are
// ordinary, and the caller turns the nil into a 404.
func (d *DB) GetEmoji(ctx context.Context, id int64) (*Emoji, error) {
	row, err := d.q.GetEmojiByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetEmoji: %w", err)
	}
	return &Emoji{
		ID:         row.ID,
		Shortcode:  row.Shortcode,
		StoredAs:   row.Filename,
		MimeType:   row.MimeType,
		UploadedBy: row.UploadedBy,
		CreatedAt:  row.CreatedAt,
	}, nil
}

// GetEmojiByShortcode returns the emoji owning `shortcode`, or (nil, nil).
// Shortcodes are stored lowercase, so the caller must normalize before calling
// -- this is the uniqueness check behind CreateEmoji.
func (d *DB) GetEmojiByShortcode(ctx context.Context, shortcode string) (*Emoji, error) {
	row, err := d.q.GetEmojiByShortcode(ctx, shortcode)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetEmojiByShortcode: %w", err)
	}
	return &Emoji{
		ID:         row.ID,
		Shortcode:  row.Shortcode,
		StoredAs:   row.Filename,
		MimeType:   row.MimeType,
		UploadedBy: row.UploadedBy,
		CreatedAt:  row.CreatedAt,
	}, nil
}

// ListEmoji returns every custom emoji, ordered by shortcode.
func (d *DB) ListEmoji(ctx context.Context) ([]*Emoji, error) {
	rows, err := d.q.ListEmoji(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListEmoji: %w", err)
	}
	out := make([]*Emoji, 0, len(rows))
	for _, row := range rows {
		out = append(out, &Emoji{
			ID:         row.ID,
			Shortcode:  row.Shortcode,
			StoredAs:   row.Filename,
			MimeType:   row.MimeType,
			UploadedBy: row.UploadedBy,
			CreatedAt:  row.CreatedAt,
		})
	}
	return out, nil
}

// CreateEmoji inserts a custom emoji and returns the stored row. storedAs is
// the storage-layer UUID the bytes were written under; mimeType is the type
// sniffed from those bytes, never a client-supplied header.
func (d *DB) CreateEmoji(ctx context.Context, shortcode, storedAs, mimeType string, uploadedBy int64) (*Emoji, error) {
	row, err := d.q.CreateEmoji(ctx, dbgen.CreateEmojiParams{
		Shortcode:  shortcode,
		Filename:   storedAs,
		MimeType:   mimeType,
		UploadedBy: uploadedBy,
	})
	if err != nil {
		return nil, fmt.Errorf("CreateEmoji: %w", err)
	}
	return &Emoji{
		ID:         row.ID,
		Shortcode:  row.Shortcode,
		StoredAs:   row.Filename,
		MimeType:   row.MimeType,
		UploadedBy: row.UploadedBy,
		CreatedAt:  row.CreatedAt,
	}, nil
}

// DeleteEmoji removes the emoji row and reports whether a row was actually
// deleted, so a concurrent double-delete answers 404 rather than pretending to
// have removed the same emoji twice.
func (d *DB) DeleteEmoji(ctx context.Context, id int64) (bool, error) {
	res, err := d.q.DeleteEmoji(ctx, id)
	if err != nil {
		return false, fmt.Errorf("DeleteEmoji: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("DeleteEmoji rows affected: %w", err)
	}
	return n > 0, nil
}
