package linkpreview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// DirName is the folder under the server data folder that holds the thumbnails.
const DirName = "link-previews"

const (
	// CardReuse is how long a fetched card is reused before its page is fetched again, and the
	// least time a card nothing names is kept.
	CardReuse = 7 * 24 * time.Hour
	// FailureReuse is how long a failed fetch is remembered.
	FailureReuse = time.Hour

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

// Preview is one stored link card, keyed by the hash of its normalised URL.
type Preview = dbgen.LinkPreview

// Image is one stored thumbnail's row; the file on disk is named by its hash.
type Image = dbgen.LinkPreviewImage

// Card is one card a message shows, with its thumbnail's size when it has one.
type Card = dbgen.ListMessageLinkPreviewsRow

// ImageRef names a thumbnail and its size, as the sweep lists them.
type ImageRef = dbgen.ListOldestLinkPreviewImagesRow

// Repo is what the Store needs from the database.
type Repo interface {
	GetLinkPreview(ctx context.Context, urlHash string) (Preview, error)
	UpsertLinkPreview(ctx context.Context, p Preview) error
	TouchLinkPreview(ctx context.Context, urlHash, lastUsedAt string) error
	GetLinkPreviewImage(ctx context.Context, hash string) (Image, error)
	LinkPreviewImageExists(ctx context.Context, hash string) (bool, error)
	InsertLinkPreviewImage(ctx context.Context, img Image) error
	TouchLinkPreviewImage(ctx context.Context, hash, lastUsedAt string) error
	ListMessageLinkPreviews(ctx context.Context, messageID int64) ([]Card, error)
	ListLinkPreviewsForMessages(ctx context.Context, messageIDs []int64) ([]Card, error)
	ReplaceMessageLinkPreviews(ctx context.Context, messageID int64, contentVersion, content, unfurledAt string, urlHashes []string) (bool, error)
	SumLinkPreviewImageBytes(ctx context.Context) (int64, error)
	ListOldestLinkPreviewImages(ctx context.Context, limit int) ([]ImageRef, error)
	ListLinkPreviewImagesUnusedBefore(ctx context.Context, cutoff string, limit int) ([]ImageRef, error)
	ListUnreferencedLinkPreviewImages(ctx context.Context, cutoff string, limit int) ([]ImageRef, error)
	DeleteLinkPreviewImage(ctx context.Context, hash string) (bool, error)
	TouchLinkPreviews(ctx context.Context, urlHashes []string, lastUsedAt string) error
	TouchLinkPreviewImages(ctx context.Context, hashes []string, lastUsedAt string) error
	DeleteUnreferencedLinkPreviews(ctx context.Context, cutoff string) (int64, error)
}

// Store keeps link cards in the database and thumbnails on disk. Build one per data folder
// and share it: the mutex that orders a thumbnail's rename and insert against Sweep is the
// Store's own.
type Store struct {
	db  Repo
	dir string
	now func() time.Time

	// mu covers a thumbnail's rename and row insert, Sweep's row trimming and each stray
	// file's re-check and removal, so Sweep never removes a file whose row is on its way.
	mu syncutil.Mutex
}

// NewStore opens the store over repo, keeping thumbnails under dir (created if missing).
func NewStore(repo Repo, dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("creating link preview dir %s: %w", dir, err)
	}
	return &Store{db: repo, dir: dir, now: time.Now}, nil
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
// so a row never names a missing file. The same bytes twice are one file and one row. A
// caller that goes on to store a card naming the image uses PutCard, which keeps Sweep from
// running between the two writes.
func (s *Store) PutImage(ctx context.Context, data []byte, mime string, width, height int) (string, error) {
	st, err := s.stageImage(data, mime, width, height)
	if err != nil {
		return "", err
	}
	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		_ = os.Remove(st.tmp)
		return "", fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	return s.publishLocked(ctx, st)
}

// NewImage is a thumbnail PutCard stores with its card.
type NewImage struct {
	Data          []byte
	MIME          string
	Width, Height int
}

// PutCard stores a card and, when img is set, its thumbnail, with the store mutex held across
// both writes so no Sweep runs between them: the image row a card names cannot be removed
// before the card is written. The card's ImageHash is set from img and any value in p is
// ignored. The card is stored without an image when img is nil, when imageCapBytes is 0 (keep
// no thumbnails), when the image alone is larger than the cap, or when the store refuses it.
func (s *Store) PutCard(ctx context.Context, p Preview, img *NewImage, imageCapBytes int64) error {
	p.ImageHash = nil
	var st *staged
	if img != nil && imageCapBytes > 0 && int64(len(img.Data)) <= imageCapBytes {
		var err error
		if st, err = s.stageImage(img.Data, img.MIME, img.Width, img.Height); err != nil {
			st = nil
		}
	}
	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		if st != nil {
			_ = os.Remove(st.tmp)
		}
		return fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	if st != nil {
		hash, err := s.publishLocked(ctx, st)
		if err != nil {
			return err
		}
		p.ImageHash = &hash
	}
	if err := s.db.UpsertLinkPreview(ctx, p); err != nil {
		return fmt.Errorf("storing link preview: %w", err)
	}
	return nil
}

type staged struct {
	tmp, hash, shard, mime string
	size                   int
	width, height          int
}

func (s *Store) stageImage(data []byte, mime string, width, height int) (*staged, error) {
	if len(data) == 0 || len(data) > MaxImageBytes {
		return nil, fmt.Errorf("%w: size %d", ErrInvalidImage, len(data))
	}
	if mime == "" || width <= 0 || height <= 0 {
		return nil, fmt.Errorf("%w: mime %q size %dx%d", ErrInvalidImage, mime, width, height)
	}
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	shard := s.shardDir(hash)
	if err := os.MkdirAll(shard, 0o750); err != nil {
		return nil, fmt.Errorf("creating thumbnail shard: %w", err)
	}
	tmp, err := writeTemp(shard, data)
	if err != nil {
		return nil, err
	}
	return &staged{tmp: tmp, hash: hash, shard: shard, mime: mime, size: len(data), width: width, height: height}, nil
}

// publishLocked renames a staged file to its hash and inserts the row. The caller holds mu. A
// file already there holds the same bytes, so the temporary file is dropped and the rename
// skipped, which also avoids replacing a file that is open on Windows.
func (s *Store) publishLocked(ctx context.Context, st *staged) (string, error) {
	final := filepath.Join(st.shard, st.hash)
	if _, err := os.Stat(final); err == nil {
		_ = os.Remove(st.tmp)
	} else if err := os.Rename(st.tmp, final); err != nil {
		_ = os.Remove(st.tmp)
		return "", fmt.Errorf("publishing thumbnail: %w", err)
	} else {
		syncDir(st.shard)
	}
	stamp := FormatTime(s.now())
	err := s.db.InsertLinkPreviewImage(ctx, Image{
		Hash: st.hash, MimeType: st.mime, Size: int64(st.size), Width: int64(st.width), Height: int64(st.height),
		CreatedAt: stamp, LastUsedAt: stamp,
	})
	if err != nil {
		// The file stays; with no row it is removed by the next Sweep.
		return "", fmt.Errorf("recording thumbnail: %w", err)
	}
	return st.hash, nil
}

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
	path := filepath.Clean(filepath.Join(s.shardDir(hash), hash))
	if !strings.HasPrefix(path, filepath.Clean(s.dir)+string(filepath.Separator)) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidHash, hash)
	}
	f, err := os.Open(path) //nolint:gosec // hash validated as hex and the path kept inside the store
	if err != nil {
		return nil, fmt.Errorf("opening thumbnail: %w", err)
	}
	return f, nil
}

// Image returns the row of the thumbnail named hash (an error wrapping db.ErrNotFound when none).
func (s *Store) Image(ctx context.Context, hash string) (Image, error) {
	if !ValidHash(hash) {
		return Image{}, fmt.Errorf("%w: %q", ErrInvalidHash, hash)
	}
	img, err := s.db.GetLinkPreviewImage(ctx, hash)
	if err != nil {
		return Image{}, fmt.Errorf("reading thumbnail row: %w", err)
	}
	return img, nil
}

// Preview returns the card stored for urlHash (an error wrapping db.ErrNotFound when none).
func (s *Store) Preview(ctx context.Context, urlHash string) (Preview, error) {
	p, err := s.db.GetLinkPreview(ctx, urlHash)
	if err != nil {
		return Preview{}, fmt.Errorf("reading link preview: %w", err)
	}
	return p, nil
}

// PutPreview stores a card without a thumbnail, replacing one under the same hash. A card
// with a thumbnail goes through PutCard, which keeps Sweep out between the two writes.
func (s *Store) PutPreview(ctx context.Context, p Preview) error {
	if p.ImageHash != nil {
		return fmt.Errorf("%w: a card with a thumbnail is stored with PutCard", ErrInvalidImage)
	}
	if err := s.db.UpsertLinkPreview(ctx, p); err != nil {
		return fmt.Errorf("storing link preview: %w", err)
	}
	return nil
}

// KeepCard rewrites a card as it is, with its thumbnail reference, to change only when it was
// fetched. It is how a failed refresh leaves the old card in place.
func (s *Store) KeepCard(ctx context.Context, p Preview) error {
	if err := syncutil.LockContext(ctx, &s.mu); err != nil {
		return fmt.Errorf("waiting for the thumbnail store: %w", err)
	}
	defer s.mu.Unlock()
	if p.ImageHash != nil {
		if ok, err := s.db.LinkPreviewImageExists(ctx, *p.ImageHash); err != nil || !ok {
			p.ImageHash = nil
		}
	}
	if err := s.db.UpsertLinkPreview(ctx, p); err != nil {
		return fmt.Errorf("keeping link preview: %w", err)
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

// MessagePreviews lists the cards of one message in link order.
func (s *Store) MessagePreviews(ctx context.Context, messageID int64) ([]Card, error) {
	rows, err := s.db.ListMessageLinkPreviews(ctx, messageID)
	if err != nil {
		return nil, fmt.Errorf("listing message previews: %w", err)
	}
	return rows, nil
}

// PreviewsForMessages lists the cards of many messages, ordered by message then link order.
func (s *Store) PreviewsForMessages(ctx context.Context, messageIDs []int64) ([]Card, error) {
	rows, err := s.db.ListLinkPreviewsForMessages(ctx, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("listing previews for messages: %w", err)
	}
	return rows, nil
}

// ReplaceMessagePreviews makes urlHashes the message's links and records the unfurl, in
// one transaction, only when the message still exists, is not deleted and still has the
// version (edited_at, else timestamp) and the exact text the caller read. The text matters
// because the version has one-second resolution. It reports whether it applied; on false
// nothing was written and the caller drops its result.
func (s *Store) ReplaceMessagePreviews(ctx context.Context, messageID int64, contentVersion, content string, urlHashes []string) (bool, error) {
	applied, err := s.db.ReplaceMessageLinkPreviews(ctx, messageID, contentVersion, content, FormatTime(s.now()), urlHashes)
	if err != nil {
		return false, fmt.Errorf("replacing message previews: %w", err)
	}
	return applied, nil
}

// TouchMany records that cards and thumbnails were just shown, one statement for each kind.
func (s *Store) TouchMany(ctx context.Context, urlHashes, imageHashes []string) error {
	stamp := FormatTime(s.now())
	if err := s.db.TouchLinkPreviews(ctx, urlHashes, stamp); err != nil {
		return fmt.Errorf("touching link previews: %w", err)
	}
	if err := s.db.TouchLinkPreviewImages(ctx, imageHashes, stamp); err != nil {
		return fmt.Errorf("touching thumbnails: %w", err)
	}
	return nil
}

// PruneCards removes the cards no message names that were last used more than unusedFor ago,
// and returns how many it removed. A card is never removed within CardReuse of its last use,
// whatever unusedFor says, so a link posted again inside the reuse window still finds its card.
// A thumbnail they named is left to Sweep.
func (s *Store) PruneCards(ctx context.Context, unusedFor time.Duration) (int64, error) {
	unusedFor = max(unusedFor, CardReuse)
	n, err := s.db.DeleteUnreferencedLinkPreviews(ctx, FormatTime(s.now().Add(-unusedFor)))
	if err != nil {
		return 0, fmt.Errorf("pruning link preview cards: %w", err)
	}
	return n, nil
}
