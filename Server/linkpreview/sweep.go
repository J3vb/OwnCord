package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// SweepResult counts what one Sweep removed.
type SweepResult struct {
	Images     int
	ImageBytes int64
	Strays     int
	Temps      int
}

// Sweep trims the thumbnails. It drops those unused for unusedFor and those no card names
// (past a grace), then the least recently used until the total is at most capBytes, each
// row first and its file second, with the store mutex held. It then walks the folder without
// the mutex, removing temporary files older than a few minutes and files with no row; for a
// file with no row it takes the mutex, checks the row again and removes the file.
func (s *Store) Sweep(ctx context.Context, capBytes int64, unusedFor time.Duration) (SweepResult, error) {
	var res SweepResult
	now := s.now()
	if err := s.trim(ctx, &res, now, max(capBytes, 0), unusedFor); err != nil {
		return res, err
	}
	if err := s.removeStrays(ctx, &res, now); err != nil {
		return res, err
	}
	return res, nil
}

// trim drops rows and files by age, then by cap, under the store mutex.
func (s *Store) trim(ctx context.Context, res *SweepResult, now time.Time, capBytes int64, unusedFor time.Duration) error {
	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		return fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	if err := s.dropRows(ctx, res, func() ([]ImageRef, error) {
		return s.db.ListLinkPreviewImagesUnusedBefore(ctx, FormatTime(now.Add(-unusedFor)), sweepBatch)
	}); err != nil {
		return err
	}
	if err := s.dropRows(ctx, res, func() ([]ImageRef, error) {
		return s.db.ListUnreferencedLinkPreviewImages(ctx, FormatTime(now.Add(-unreferencedGrace)), sweepBatch)
	}); err != nil {
		return err
	}
	return s.trimToCap(ctx, res, capBytes)
}

// dropRows deletes the batches list returns until it returns none or a batch removes no row.
func (s *Store) dropRows(ctx context.Context, res *SweepResult, list func() ([]ImageRef, error)) error {
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("thumbnail sweep: %w", err)
		}
		batch, err := list()
		if err != nil {
			return fmt.Errorf("listing thumbnails to drop: %w", err)
		}
		removed := 0
		for _, ref := range batch {
			ok, err := s.dropImage(ctx, ref)
			if err != nil {
				return err
			}
			if ok {
				removed++
				res.Images++
				res.ImageBytes += ref.Size
			}
		}
		if removed == 0 || len(batch) < sweepBatch {
			return nil
		}
	}
}

// trimToCap drops the least recently used thumbnails until the total fits capBytes.
func (s *Store) trimToCap(ctx context.Context, res *SweepResult, capBytes int64) error {
	total, err := s.db.SumLinkPreviewImageBytes(ctx)
	if err != nil {
		return fmt.Errorf("measuring thumbnails: %w", err)
	}
	for total > capBytes {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("thumbnail sweep: %w", err)
		}
		batch, err := s.db.ListOldestLinkPreviewImages(ctx, sweepBatch)
		if err != nil {
			return fmt.Errorf("listing oldest thumbnails: %w", err)
		}
		if len(batch) == 0 {
			return nil
		}
		for _, ref := range batch {
			if total <= capBytes {
				return nil
			}
			ok, err := s.dropImage(ctx, ref)
			if err != nil {
				return err
			}
			if ok {
				total -= ref.Size
				res.Images++
				res.ImageBytes += ref.Size
			}
		}
	}
	return nil
}

// dropImage deletes the row, then the file. It reports whether a row was deleted. A file
// that cannot be removed is left with no row, which removeStrays retries.
func (s *Store) dropImage(ctx context.Context, ref ImageRef) (bool, error) {
	ok, err := s.db.DeleteLinkPreviewImage(ctx, ref.Hash)
	if err != nil {
		return false, fmt.Errorf("deleting thumbnail row: %w", err)
	}
	if !ValidHash(ref.Hash) {
		return ok, nil
	}
	if rmErr := os.Remove(filepath.Join(s.shardDir(ref.Hash), ref.Hash)); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
		slog.Warn("failed to remove link preview file", "hash", ref.Hash, "error", rmErr)
	}
	return ok, nil
}

// removeStrays walks the shards without the store mutex and removes stale temporary files
// and files with no row. A folder or file the store did not write is left alone.
func (s *Store) removeStrays(ctx context.Context, res *SweepResult, now time.Time) error {
	shards, err := os.ReadDir(s.dir)
	if err != nil {
		return fmt.Errorf("reading link preview dir: %w", err)
	}
	for _, sh := range shards {
		if !sh.IsDir() || len(sh.Name()) != 2 {
			continue
		}
		shardPath := filepath.Join(s.dir, sh.Name())
		files, err := os.ReadDir(shardPath)
		if err != nil {
			return fmt.Errorf("reading thumbnail shard: %w", err)
		}
		for _, f := range files {
			if err := ctx.Err(); err != nil {
				return fmt.Errorf("thumbnail sweep: %w", err)
			}
			if f.IsDir() {
				continue
			}
			if err := s.sweepFile(ctx, res, now, shardPath, sh.Name(), f); err != nil {
				return err
			}
		}
	}
	return nil
}

// sweepFile removes one file of a shard if it is a stale temporary or has no row.
func (s *Store) sweepFile(ctx context.Context, res *SweepResult, now time.Time, shardPath, shardName string, f fs.DirEntry) error {
	name := f.Name()
	path := filepath.Join(shardPath, name)
	if strings.HasPrefix(name, tempPrefix) {
		info, err := f.Info()
		if err != nil {
			return nil //nolint:nilerr // the file vanished between listing and stat
		}
		if now.Sub(info.ModTime()) > tempMaxAge && removeFile(path) {
			res.Temps++
		}
		return nil
	}
	if !ValidHash(name) || name[:2] != shardName {
		return nil
	}
	exists, err := s.db.LinkPreviewImageExists(ctx, name)
	if err != nil {
		return fmt.Errorf("checking thumbnail row: %w", err)
	}
	if exists {
		return nil
	}
	return s.removeStray(ctx, res, name, path)
}

// removeStray takes the store mutex and checks the row again before removing the file: a
// PutImage that renamed it a moment ago inserts its row under the same mutex.
func (s *Store) removeStray(ctx context.Context, res *SweepResult, name, path string) error {
	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		return fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	exists, err := s.db.LinkPreviewImageExists(ctx, name)
	if err != nil {
		return fmt.Errorf("checking thumbnail row: %w", err)
	}
	if !exists && removeFile(path) {
		res.Strays++
	}
	return nil
}

func removeFile(path string) bool {
	if err := os.Remove(path); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("failed to remove link preview file", "path", path, "error", err)
		}
		return false
	}
	return true
}
