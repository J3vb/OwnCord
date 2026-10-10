package db

import (
	"context"
	"errors"
	"fmt"
)

// MaxGIFFavorites is the per-user cap on saved GIFs (migration 059).
const MaxGIFFavorites = 250

// ErrGIFFavoritesFull is returned when adding a new favorite would exceed MaxGIFFavorites.
var ErrGIFFavoritesFull = errors.New("gif favorites full")

// GIFFavorite is one saved GIF: provider URLs and a title, never bytes.
type GIFFavorite struct {
	URL        string
	PreviewURL string
	Title      string
}

// AddGIFFavorite saves f for userID. Re-adding an existing URL is a no-op,
// even at the cap. The count check and the insert share one writer
// transaction so concurrent adds cannot overshoot the cap.
func (d *DB) AddGIFFavorite(ctx context.Context, userID int64, f GIFFavorite) error {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("AddGIFFavorite begin: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	var n int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM gif_favorites WHERE user_id = ? AND url <> ?`, userID, f.URL).Scan(&n); err != nil {
		return fmt.Errorf("AddGIFFavorite count: %w", err)
	}
	if n >= MaxGIFFavorites {
		return ErrGIFFavoritesFull
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO gif_favorites (user_id, url, preview_url, title) VALUES (?, ?, ?, ?)`,
		userID, f.URL, f.PreviewURL, f.Title); err != nil {
		return fmt.Errorf("AddGIFFavorite insert: %w", err)
	}
	return tx.Commit()
}

// RemoveGIFFavorite deletes userID's favorite for url; a missing row is not an error.
func (d *DB) RemoveGIFFavorite(ctx context.Context, userID int64, url string) error {
	if _, err := d.writer.ExecContext(ctx,
		`DELETE FROM gif_favorites WHERE user_id = ? AND url = ?`, userID, url); err != nil {
		return fmt.Errorf("RemoveGIFFavorite: %w", err)
	}
	return nil
}

// ListGIFFavorites returns userID's favorites, newest first.
func (d *DB) ListGIFFavorites(ctx context.Context, userID int64) ([]GIFFavorite, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT url, preview_url, title FROM gif_favorites WHERE user_id = ? ORDER BY id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("ListGIFFavorites: %w", err)
	}
	defer rows.Close()
	out := []GIFFavorite{}
	for rows.Next() {
		var f GIFFavorite
		if err := rows.Scan(&f.URL, &f.PreviewURL, &f.Title); err != nil {
			return nil, fmt.Errorf("ListGIFFavorites scan: %w", err)
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
