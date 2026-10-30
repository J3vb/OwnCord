package service

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"unicode"

	"github.com/J3vb/OwnCord/Server/db"
)

// StickerStore is the slice of the database the sticker routes and send use beyond
// Store. *db.DB satisfies it; declared here so Store, whose size is pinned, does
// not grow.
type StickerStore interface {
	db.Auditor
	ListStickers(ctx context.Context) ([]*db.Sticker, error)
	GetSticker(ctx context.Context, id int64) (*db.Sticker, error)
	GetStickerByName(ctx context.Context, name string) (*db.Sticker, error)
	CountStickers(ctx context.Context) (int64, error)
	CreateSticker(ctx context.Context, name string, emoji *string, storedAs, mimeType string, uploadedBy int64) (*db.Sticker, error)
	UpdateSticker(ctx context.Context, id int64, name string, emoji *string) (*db.Sticker, error)
	DeleteSticker(ctx context.Context, id int64) (bool, error)
	GetMessageSticker(ctx context.Context, messageID int64) (*db.MessageStickerInfo, error)
}

var _ StickerStore = (*db.DB)(nil)

// Sticker is a custom sticker row; the ws layer builds sticker_update from it.
type Sticker = db.Sticker

// MessageStickerInfo is the sticker block a chat_message frame carries.
type MessageStickerInfo = db.MessageStickerInfo

// StickerService owns the server-wide custom sticker set: who may change it, what
// a name may look like, and the uniqueness and count rules. Stickers are gated on
// MANAGE_SERVER through the emoji service's gate, like custom emoji, so one place
// answers "who may change server-wide branding" and no new permission bit exists.
// Reading is ungated.
type StickerService struct {
	st   StickerStore
	gate func(ctx context.Context, actorID int64) error
}

// NewStickerService creates a StickerService whose manage gate is emoji's.
func NewStickerService(st StickerStore, emoji *EmojiService) *StickerService {
	return &StickerService{st: st, gate: emoji.RequireManage}
}

const (
	// MinStickerNameLen and MaxStickerNameLen bound a sticker name, in bytes (ASCII).
	MinStickerNameLen = 2
	// MaxStickerNameLen is the upper bound on a sticker name's length.
	MaxStickerNameLen = 30
	// MaxStickerCount bounds the set; every client holds the whole list and
	// re-receives it on every sticker_update.
	MaxStickerCount = 60
	// MaxStickerEmojiBytes bounds the optional related emoji or shortcode.
	MaxStickerEmojiBytes = 64
)

// StickerImageURL is the server-relative path a sticker's bytes are served from,
// defined once because REST, sticker_update and the message block must agree.
func StickerImageURL(id int64) string { return db.StickerImageURL(id) }

// stickerNameRe is the exact spelling of a sticker name: ASCII letters, digits,
// space, underscore and hyphen. ASCII only, so the column's NOCASE collation
// (ASCII-only folding) makes uniqueness fully case-insensitive.
var stickerNameRe = regexp.MustCompile(`^[A-Za-z0-9 _-]{2,30}$`)

// stickerShortcodeRe is a custom-emoji shortcode as a sticker's related emoji.
var stickerShortcodeRe = regexp.MustCompile(`^:[a-z0-9_]{2,32}:$`)

// ValidateStickerName trims a name and checks it, returning the stored form.
// The case the uploader typed is kept.
func ValidateStickerName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if !stickerNameRe.MatchString(name) {
		return "", fmt.Errorf(
			"%w: sticker name must be %d-%d characters of letters, digits, space, underscore or hyphen",
			ErrBadRequest, MinStickerNameLen, MaxStickerNameLen)
	}
	return name, nil
}

// ValidateStickerEmoji checks the optional related emoji: empty for none, a
// custom-emoji shortcode like :wave:, or a single emoji. Returns the stored form,
// nil for none.
func ValidateStickerEmoji(raw string) (*string, error) {
	e := strings.TrimSpace(raw)
	if e == "" {
		return nil, nil
	}
	if len(e) > MaxStickerEmojiBytes {
		return nil, fmt.Errorf("%w: sticker emoji is longer than %d bytes", ErrBadRequest, MaxStickerEmojiBytes)
	}
	if stickerShortcodeRe.MatchString(strings.ToLower(e)) {
		e = strings.ToLower(e)
		return &e, nil
	}
	if err := validateEmoji(e); err != nil {
		return nil, err
	}
	nonASCII := false
	for _, r := range e {
		if unicode.IsSpace(r) {
			return nil, fmt.Errorf("%w: sticker emoji must be a single emoji or a custom emoji shortcode", ErrBadRequest)
		}
		if r > unicode.MaxASCII {
			nonASCII = true
		}
	}
	if !nonASCII {
		return nil, fmt.Errorf("%w: sticker emoji must be a single emoji or a custom emoji shortcode", ErrBadRequest)
	}
	return &e, nil
}

// RequireManage reports whether actorID may add, rename or remove stickers.
// Handlers call it BEFORE reading an upload body.
func (s *StickerService) RequireManage(ctx context.Context, actorID int64) error {
	return s.gate(ctx, actorID)
}

// List returns every sticker, ordered by name. Ungated.
func (s *StickerService) List(ctx context.Context) ([]*db.Sticker, error) {
	list, err := s.st.ListStickers(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list stickers: %w", ErrInternal, err)
	}
	return list, nil
}

// Get returns one sticker by id, or ErrNotFound. Used by the image route.
func (s *StickerService) Get(ctx context.Context, id int64) (*db.Sticker, error) {
	st, err := s.st.GetSticker(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to load sticker: %w", ErrInternal, err)
	}
	if st == nil {
		return nil, fmt.Errorf("%w: sticker not found", ErrNotFound)
	}
	return st, nil
}

// Create records an already-stored image as a sticker. The caller has validated and
// stored the bytes; this owns the permission gate, name and emoji rules, count cap
// and audit entry. A name collision is ErrConflict, not ErrBadRequest. Callers
// delete the orphaned file when this errors.
func (s *StickerService) Create(ctx context.Context, actorID int64, rawName, rawEmoji, storedAs, mimeType string) (*db.Sticker, error) {
	if err := s.gate(ctx, actorID); err != nil {
		return nil, err
	}
	name, err := ValidateStickerName(rawName)
	if err != nil {
		return nil, err
	}
	emoji, err := ValidateStickerEmoji(rawEmoji)
	if err != nil {
		return nil, err
	}
	existing, err := s.st.GetStickerByName(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check sticker name: %w", ErrInternal, err)
	}
	if existing != nil {
		return nil, errStickerNameTaken(name)
	}
	count, err := s.st.CountStickers(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to count stickers: %w", ErrInternal, err)
	}
	if count >= MaxStickerCount {
		return nil, fmt.Errorf("%w: this server already has the maximum of %d stickers", ErrBadRequest, MaxStickerCount)
	}
	created, err := s.st.CreateSticker(ctx, name, emoji, storedAs, mimeType, actorID)
	if err != nil {
		if db.IsUniqueConstraintError(err) {
			// Lost a race with another Create between the check and the INSERT.
			return nil, errStickerNameTaken(name)
		}
		return nil, fmt.Errorf("%w: failed to create sticker: %w", ErrInternal, err)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "sticker_create", "sticker", created.ID,
		fmt.Sprintf("uploaded sticker %q (%s)", name, mimeType))
	slog.Info("custom sticker created", "actor_id", actorID, "sticker_id", created.ID)
	return created, nil
}

// Update renames a sticker and sets its related emoji. The image never changes.
func (s *StickerService) Update(ctx context.Context, actorID, id int64, rawName, rawEmoji string) (*db.Sticker, error) {
	if err := s.gate(ctx, actorID); err != nil {
		return nil, err
	}
	name, err := ValidateStickerName(rawName)
	if err != nil {
		return nil, err
	}
	emoji, err := ValidateStickerEmoji(rawEmoji)
	if err != nil {
		return nil, err
	}
	if _, err := s.Get(ctx, id); err != nil {
		return nil, err
	}
	clash, err := s.st.GetStickerByName(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check sticker name: %w", ErrInternal, err)
	}
	if clash != nil && clash.ID != id {
		return nil, errStickerNameTaken(name)
	}
	updated, err := s.st.UpdateSticker(ctx, id, name, emoji)
	if err != nil {
		if db.IsUniqueConstraintError(err) {
			return nil, errStickerNameTaken(name)
		}
		return nil, fmt.Errorf("%w: failed to update sticker: %w", ErrInternal, err)
	}
	if updated == nil {
		return nil, fmt.Errorf("%w: sticker not found", ErrNotFound)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "sticker_update", "sticker", id,
		fmt.Sprintf("renamed sticker to %q", name))
	slog.Info("custom sticker updated", "actor_id", actorID, "sticker_id", id)
	return updated, nil
}

// Delete removes a sticker and returns the row that was removed, so the caller
// can unlink the stored file. Messages that used it keep their name.
func (s *StickerService) Delete(ctx context.Context, actorID, id int64) (*db.Sticker, error) {
	if err := s.gate(ctx, actorID); err != nil {
		return nil, err
	}
	existing, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	deleted, err := s.st.DeleteSticker(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to delete sticker: %w", ErrInternal, err)
	}
	if !deleted {
		return nil, fmt.Errorf("%w: sticker not found", ErrNotFound)
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "sticker_delete", "sticker", id,
		fmt.Sprintf("deleted sticker %q", existing.Name))
	slog.Info("custom sticker deleted", "actor_id", actorID, "sticker_id", id)
	return existing, nil
}

func errStickerNameTaken(name string) error {
	return fmt.Errorf("%w: a sticker named %q already exists", ErrConflict, name)
}
