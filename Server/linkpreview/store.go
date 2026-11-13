package linkpreview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// DirName is the folder under the server data folder that holds the thumbnails.
const DirName = "link-previews"

const (
	hashLen = 64
	// tempPrefix starts the name of a thumbnail being written; Sweep removes one older than tempMaxAge.
	tempPrefix = ".tmp-"
	tempMaxAge = 5 * time.Minute
	// unreferencedGrace is how long a thumbnail no card names is kept, so one stored a moment
	// before its card is written is not swept.
	unreferencedGrace = time.Hour
	// sweepBatch bounds the rows one sweep query reads.
	sweepBatch = 200
	// MaxImageBytes caps the size of one thumbnail PutImage accepts.
	MaxImageBytes = 4 << 20
)

var (
	// ErrInvalidHash marks a thumbnail name that is not 64 lower-case hex characters.
	ErrInvalidHash = errors.New("invalid thumbnail hash")
	// ErrInvalidImage marks thumbnail input PutImage refuses.
	ErrInvalidImage = errors.New("invalid thumbnail")
)

// Store keeps link cards in the database and thumbnails on disk. One Store per data folder:
// the mutex that orders a thumbnail's rename and insert against Sweep is the Store's own.
type Store struct {
	db  *db.DB
	dir string
	now func() time.Time

	// mu is held across PutImage's rename and row insert and across the whole of Sweep, so
	// Sweep never sees a thumbnail file whose row is about to be inserted.
	mu syncutil.Mutex
}

// NewStore opens the store over database, keeping thumbnails under dir (created if missing).
func NewStore(database *db.DB, dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("creating link preview dir %s: %w", dir, err)
	}
	return &Store{db: database, dir: dir, now: time.Now}, nil
}

// FormatTime is how the store writes a time: UTC, whole seconds, fixed width, so text
// order is time order.
func FormatTime(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

// ValidHash reports whether h is 64 lower-case hex characters.
func ValidHash(h string) bool {
	if len(h) != hashLen {
		return false
	}
	for i := 0; i < len(h); i++ {
		c := h[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func (s *Store) shardDir(hash string) string {
	return filepath.Join(s.dir, hash[:2])
}

// PutImage stores thumbnail bytes and returns their hash. The bytes go to a temporary file in
// the final folder, are synced and renamed to the hash, and only then is the row inserted,
// so a row never names a missing file. The same bytes twice are one file and one row.
func (s *Store) PutImage(ctx context.Context, data []byte, mime string, width, height int) (string, error) {
	if len(data) == 0 || len(data) > MaxImageBytes {
		return "", fmt.Errorf("%w: size %d", ErrInvalidImage, len(data))
	}
	if mime == "" || width <= 0 || height <= 0 {
		return "", fmt.Errorf("%w: mime %q size %dx%d", ErrInvalidImage, mime, width, height)
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	shard := s.shardDir(hash)
	if err := os.MkdirAll(shard, 0o750); err != nil {
		return "", fmt.Errorf("creating thumbnail shard: %w", err)
	}
	tmp, err := writeTemp(shard, data)
	if err != nil {
		return "", err
	}

	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	if err := os.Rename(tmp, filepath.Join(shard, hash)); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("publishing thumbnail: %w", err)
	}
	syncDir(shard)
	stamp := FormatTime(s.now())
	err = s.db.InsertLinkPreviewImage(ctx, db.LinkPreviewImage{
		Hash: hash, MimeType: mime, Size: int64(len(data)), Width: int64(width), Height: int64(height),
		CreatedAt: stamp, LastUsedAt: stamp,
	})
	if err != nil {
		// The file stays; with no row it is removed by the next Sweep.
		return "", fmt.Errorf("recording thumbnail: %w", err)
	}
	return hash, nil
}

// writeTemp writes data to a new synced file in dir and returns its path.
func writeTemp(dir string, data []byte) (path string, err error) {
	f, err := os.CreateTemp(dir, tempPrefix+"*")
	if err != nil {
		return "", fmt.Errorf("creating thumbnail temp file: %w", err)
	}
	name := f.Name()
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(name)
		return "", fmt.Errorf("writing thumbnail temp file: %w", err)
	}
	return name, nil
}

// syncDir flushes a folder's entries. A failure is ignored: some filesystems refuse it.
func syncDir(dir string) {
	d, err := os.Open(dir) //nolint:gosec // dir is the store's own shard folder
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}

// OpenImage opens the thumbnail file named hash. A name that is not 64 lower-case hex
// characters is ErrInvalidHash, rejected before the filesystem is touched.
func (s *Store) OpenImage(hash string) (*os.File, error) {
	if !ValidHash(hash) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidHash, hash)
	}
	f, err := os.Open(filepath.Join(s.shardDir(hash), hash)) //nolint:gosec // hash validated as hex above
	if err != nil {
		return nil, fmt.Errorf("opening thumbnail: %w", err)
	}
	return f, nil
}

// Image returns the row of the thumbnail named hash (db.ErrNotFound when none).
func (s *Store) Image(ctx context.Context, hash string) (db.LinkPreviewImage, error) {
	if !ValidHash(hash) {
		return db.LinkPreviewImage{}, fmt.Errorf("%w: %q", ErrInvalidHash, hash)
	}
	img, err := s.db.GetLinkPreviewImage(ctx, hash)
	if err != nil {
		return db.LinkPreviewImage{}, fmt.Errorf("reading thumbnail row: %w", err)
	}
	return img, nil
}

// Preview returns the card stored for urlHash (db.ErrNotFound when none).
func (s *Store) Preview(ctx context.Context, urlHash string) (db.LinkPreview, error) {
	p, err := s.db.GetLinkPreview(ctx, urlHash)
	if err != nil {
		return db.LinkPreview{}, fmt.Errorf("reading link preview: %w", err)
	}
	return p, nil
}

// PutPreview stores a card, replacing one under the same hash. Its image, if it names one,
// must have been stored with PutImage.
func (s *Store) PutPreview(ctx context.Context, p db.LinkPreview) error {
	if err := s.db.UpsertLinkPreview(ctx, p); err != nil {
		return fmt.Errorf("storing link preview: %w", err)
	}
	return nil
}

// Touch records that a card and its thumbnail were just shown.
func (s *Store) Touch(ctx context.Context, urlHash string, imageHash *string) error {
	stamp := FormatTime(s.now())
	if err := s.db.TouchLinkPreview(ctx, urlHash, stamp); err != nil {
		return fmt.Errorf("touching link preview: %w", err)
	}
	if imageHash != nil {
		if err := s.db.TouchLinkPreviewImage(ctx, *imageHash, stamp); err != nil {
			return fmt.Errorf("touching thumbnail: %w", err)
		}
	}
	return nil
}

func (s *Store) MessagePreviews(ctx context.Context, messageID int64) ([]db.LinkPreviewCard, error) {
	rows, err := s.db.ListMessageLinkPreviews(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("listing message previews: %w", err)
	}
	return rows, nil
}

// PreviewsForMessages lists the cards of many messages, ordered by message then link order.
func (s *Store) PreviewsForMessages(ctx context.Context, messageIDs []int64) ([]db.LinkPreviewCard, error) {
	rows, err := s.db.ListLinkPreviewsForMessages(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("listing previews for messages: %w", err)
	}
	return rows, nil
}

// ReplaceMessagePreviews makes urlHashes the message's links and records the unfurl, in
// one transaction, only when the message still exists, is not deleted and still has the
// version (edited_at, else timestamp) the caller read. It reports whether it applied; on
// false nothing was written and the caller drops its result.
func (s *Store) ReplaceMessagePreviews(ctx context.Context, messageID int64, contentVersion string, urlHashes []string) (bool, error) {
	applied, err := s.db.ReplaceMessageLinkPreviews(ctx, messageID, contentVersion, FormatTime(s.now()), urlHashes)
	if err != nil {
		return false, fmt.Errorf("replacing message previews: %w", err)
	}
	return applied, nil
}

// SweepResult counts what one Sweep removed.
type SweepResult struct {
	Images     int
	ImageBytes int64
	Strays     int
	Temps      int
}

// Sweep trims the thumbnails. It drops those unused for unusedFor and those no card names
// (past a grace), then the least recently used until the total is at most capBytes, each
// row first and its file second. It then removes files that have no row and temporary
// files older than a few minutes. It holds the store mutex throughout.
func (s *Store) Sweep(ctx context.Context, capBytes int64, unusedFor time.Duration) (SweepResult, error) {
	var res SweepResult
	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		return res, fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	now := s.now()
	capBytes = max(capBytes, 0)

	if err := s.dropRows(ctx, &res, func() ([]db.LinkPreviewImageRef, error) {
		return s.db.ListLinkPreviewImagesUnusedBefore(ctx, FormatTime(now.Add(-unusedFor)), sweepBatch)
	}); err != nil {
		return res, err
	}
	if err := s.dropRows(ctx, &res, func() ([]db.LinkPreviewImageRef, error) {
		return s.db.ListUnreferencedLinkPreviewImages(ctx, FormatTime(now.Add(-unreferencedGrace)), sweepBatch)
	}); err != nil {
		return res, err
	}
	if err := s.trimToCap(ctx, &res, capBytes); err != nil {
		return res, err
	}
	if err := s.removeStrays(ctx, &res, now); err != nil {
		return res, err
	}
	return res, nil
}

func (s *Store) dropRows(ctx context.Context, res *SweepResult, list func() ([]db.LinkPreviewImageRef, error)) error {
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
func (s *Store) dropImage(ctx context.Context, ref db.LinkPreviewImageRef) (bool, error) {
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

// removeStrays deletes files with no row and temporary files older than tempMaxAge. A
// folder or file the store did not write is left alone.
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
	_, err := s.db.GetLinkPreviewImage(ctx, name)
	if err == nil {
		return nil
	}
	if !errors.Is(err, db.ErrNotFound) {
		return fmt.Errorf("checking thumbnail row: %w", err)
	}
	if removeFile(path) {
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
