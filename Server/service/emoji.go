package service

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// EmojiStore is the data access the emoji service needs: the emoji table plus the
// audit write. *db.DB satisfies it; Store embeds it.
type EmojiStore interface {
	ListEmoji(ctx context.Context) ([]*db.Emoji, error)
	GetEmoji(ctx context.Context, id int64) (*db.Emoji, error)
	GetEmojiByShortcode(ctx context.Context, shortcode string) (*db.Emoji, error)
	CreateEmoji(ctx context.Context, shortcode, storedAs, mimeType string, uploadedBy int64) (*db.Emoji, error)
	DeleteEmoji(ctx context.Context, id int64) (bool, error)
	LogAudit(ctx context.Context, actorID int64, action, targetType string, targetID int64, detail string) error
}

// EmojiService owns the server-wide custom emoji set: who may change it, what a
// shortcode may look like, and uniqueness.
// Emoji are gated on MANAGE_SERVER rather than a new bit: adding a permission bit
// is a schema-visible, forever decision, and MANAGE_SERVER already answers "who
// may change server-wide branding". Reading is ungated: the set is server-wide
// with no per-channel scope to leak.
type EmojiService struct {
	st    EmojiStore
	perms *PermissionService
}

// NewEmojiService creates an EmojiService.
func NewEmojiService(st EmojiStore, perms *PermissionService) *EmojiService {
	return &EmojiService{st: st, perms: perms}
}

const (
	// MinShortcodeLen / MaxShortcodeLen bound `:name:`: two characters is the
	// shortest worth typing; 32 keeps a shortcode from dominating the composer,
	// picker and reaction pill.
	MinShortcodeLen = 2
	// MaxShortcodeLen is the upper bound on a shortcode's length.
	MaxShortcodeLen = 32
	// MaxEmojiCount bounds the set. Every client holds the whole list and re-receives
	// it on every emoji_update, so this caps what one MANAGE_SERVER holder can push to
	// every session.
	MaxEmojiCount = 200
)

// EmojiImageURL is the server-relative path an emoji's bytes are served from,
// defined once because the REST list, the emoji_update broadcast and the docs must
// agree.
func EmojiImageURL(id int64) string {
	return fmt.Sprintf("/api/v1/emoji/%d/image", id)
}

// shortcodeRe is the exact spelling a shortcode may take. Lowercase only, so the
// plain UNIQUE index enforces case-insensitive uniqueness without a COLLATE
// change; no colons, which are the delimiter.
var shortcodeRe = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

// NormalizeShortcode strips optional surrounding colons and lowercases, so
// `:WAVE:`, `WAVE` and `wave` are one shortcode. It does not validate.
func NormalizeShortcode(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, ":")
	s = strings.TrimSuffix(s, ":")
	return s
}

// ValidateShortcode normalizes and checks a shortcode, returning the canonical
// (lowercase, colon-free) form.
func ValidateShortcode(raw string) (string, error) {
	s := NormalizeShortcode(raw)
	if s == "" {
		return "", fmt.Errorf("%w: shortcode is required", ErrBadRequest)
	}
	if !shortcodeRe.MatchString(s) {
		return "", fmt.Errorf(
			"%w: shortcode must be %d-%d characters of a-z, 0-9 or underscore",
			ErrBadRequest, MinShortcodeLen, MaxShortcodeLen)
	}
	return s, nil
}

// RequireManage reports whether actorID may add or remove emoji. Handlers call it
// BEFORE reading an upload body, so a user without the bit cannot spend the
// server's disk on a multipart parse.
func (s *EmojiService) RequireManage(ctx context.Context, actorID int64) error {
	if s.perms == nil {
		return fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}
	if !permissions.HasServerPerm(role.Perms, permissions.ManageServer) {
		return fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(permissions.ManageServer))
	}
	return nil
}

// List returns every custom emoji, ordered by shortcode. Ungated.
func (s *EmojiService) List(ctx context.Context) ([]*db.Emoji, error) {
	list, err := s.st.ListEmoji(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list emoji: %w", ErrInternal, err)
	}
	return list, nil
}

// Create records an already-stored image as a custom emoji. The caller has
// validated and stored the bytes; this owns the permission gate, shortcode rules,
// count cap and audit entry. A shortcode collision is ErrConflict, not
// ErrBadRequest (well-formed, name taken). Callers delete the orphaned file when
// this errors.
func (s *EmojiService) Create(ctx context.Context, actorID int64, rawShortcode, storedAs, mimeType string) (*db.Emoji, error) {
	if err := s.RequireManage(ctx, actorID); err != nil {
		return nil, err
	}
	shortcode, err := ValidateShortcode(rawShortcode)
	if err != nil {
		return nil, err
	}

	existing, err := s.st.GetEmojiByShortcode(ctx, shortcode)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to check shortcode: %w", ErrInternal, err)
	}
	if existing != nil {
		return nil, fmt.Errorf("%w: an emoji named :%s: already exists", ErrConflict, shortcode)
	}

	current, err := s.st.ListEmoji(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to count emoji: %w", ErrInternal, err)
	}
	if len(current) >= MaxEmojiCount {
		return nil, fmt.Errorf("%w: this server already has the maximum of %d emoji", ErrBadRequest, MaxEmojiCount)
	}

	created, err := s.st.CreateEmoji(ctx, shortcode, storedAs, mimeType, actorID)
	if err != nil {
		if db.IsUniqueConstraintError(err) {
			// Lost a race with another Create: report the conflict, not a server fault.
			return nil, fmt.Errorf("%w: an emoji named :%s: already exists", ErrConflict, shortcode)
		}
		return nil, fmt.Errorf("%w: failed to create emoji: %w", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "emoji_create", "emoji", created.ID,
		fmt.Sprintf("uploaded emoji :%s: (%s)", shortcode, mimeType))
	slog.Info("custom emoji created", "actor_id", actorID, "emoji_id", created.ID, "shortcode", shortcode)
	return created, nil
}

// Delete removes an emoji and returns the removed row, the only source of the
// storage id the caller must unlink.
func (s *EmojiService) Delete(ctx context.Context, actorID, emojiID int64) (*db.Emoji, error) {
	if err := s.RequireManage(ctx, actorID); err != nil {
		return nil, err
	}
	existing, err := s.st.GetEmoji(ctx, emojiID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to load emoji: %w", ErrInternal, err)
	}
	if existing == nil {
		return nil, fmt.Errorf("%w: emoji not found", ErrNotFound)
	}
	deleted, err := s.st.DeleteEmoji(ctx, emojiID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to delete emoji: %w", ErrInternal, err)
	}
	if !deleted {
		// Lost a race with another delete -- report it as the 404 it now is.
		return nil, fmt.Errorf("%w: emoji not found", ErrNotFound)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "emoji_delete", "emoji", emojiID,
		fmt.Sprintf("deleted emoji :%s:", existing.Shortcode))
	slog.Info("custom emoji deleted", "actor_id", actorID, "emoji_id", emojiID, "shortcode", existing.Shortcode)
	return existing, nil
}

// Get returns one emoji by id, or ErrNotFound. Used by the image route.
func (s *EmojiService) Get(ctx context.Context, emojiID int64) (*db.Emoji, error) {
	e, err := s.st.GetEmoji(ctx, emojiID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to load emoji: %w", ErrInternal, err)
	}
	if e == nil {
		return nil, fmt.Errorf("%w: emoji not found", ErrNotFound)
	}
	return e, nil
}
