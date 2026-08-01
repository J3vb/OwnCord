package service

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// EmojiService owns the server-wide custom emoji set: who may change it, what
// a shortcode is allowed to look like, and the uniqueness rule.
//
// Emoji are deliberately gated on MANAGE_SERVER rather than on a new bit.
// Adding a permission bit is a schema-visible, forever decision, and "who may
// change server-wide branding" is exactly what MANAGE_SERVER already answers
// for the server name, icon and settings. Reading is not gated at all: an
// emoji nobody can render is not an emoji, and the set is server-wide with no
// per-channel scope to leak.
type EmojiService struct {
	st    Store
	perms *PermissionService
}

// NewEmojiService creates an EmojiService.
func NewEmojiService(st Store, perms *PermissionService) *EmojiService {
	return &EmojiService{st: st, perms: perms}
}

const (
	// MinShortcodeLen / MaxShortcodeLen bound `:name:`. Two characters is the
	// shortest thing worth typing; 32 keeps a shortcode from dominating the
	// composer, the picker row and the reaction pill it ends up in.
	MinShortcodeLen = 2
	// MaxShortcodeLen is the upper bound on a shortcode's length.
	MaxShortcodeLen = 32
	// MaxEmojiCount bounds the set. Every connected client holds the whole list
	// in memory and re-receives it on every emoji_update, so this is the cap on
	// what one MANAGE_SERVER holder can push to every session at once.
	MaxEmojiCount = 200
)

// EmojiImageURL is the server-relative path the image bytes of an emoji are
// served from. Defined once here because three surfaces have to agree on it:
// the REST list response, the emoji_update broadcast, and the docs.
func EmojiImageURL(id int64) string {
	return fmt.Sprintf("/api/v1/emoji/%d/image", id)
}

// shortcodeRe is the exact spelling a shortcode may take. Lowercase only, so
// the table's plain UNIQUE index enforces case-insensitive uniqueness without
// a COLLATE change; no leading/trailing colon, because the colons are the
// delimiter and not part of the name.
var shortcodeRe = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

// NormalizeShortcode strips the optional surrounding colons and lowercases the
// result, so `:WAVE:`, `WAVE` and `wave` are all the same shortcode. It does
// not validate -- ValidateShortcode does that on the normalized form.
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

// RequireManage reports whether actorID may add or remove emoji. Handlers call
// it BEFORE reading an upload body, so a user without the bit is refused
// without first being allowed to spend the server's disk on a multipart parse.
func (s *EmojiService) RequireManage(ctx context.Context, actorID int64) error {
	if s.perms == nil {
		return fmt.Errorf("%w: permission service unavailable", ErrForbidden)
	}
	role, err := s.perms.GetRoleForUser(ctx, actorID)
	if err != nil || role == nil {
		return fmt.Errorf("%w: failed to load actor role", ErrForbidden)
	}
	if !permissions.HasServerPerm(role.Permissions, permissions.ManageServer) {
		return fmt.Errorf("%w: missing %s permission", ErrForbidden, permissions.Name(permissions.ManageServer))
	}
	return nil
}

// List returns every custom emoji, ordered by shortcode. Ungated.
func (s *EmojiService) List(ctx context.Context) ([]*db.Emoji, error) {
	list, err := s.st.ListEmoji(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list emoji: %v", ErrInternal, err)
	}
	return list, nil
}

// Create records an already-stored image as a custom emoji. The caller is
// responsible for having validated and stored the bytes; this owns the
// permission gate, the shortcode rules, the count cap and the audit entry.
//
// A shortcode collision is ErrConflict, not ErrBadRequest: the request was
// well-formed, the name is simply taken. Callers delete the orphaned file when
// this returns an error.
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
		return nil, fmt.Errorf("%w: failed to check shortcode: %v", ErrInternal, err)
	}
	if existing != nil {
		return nil, fmt.Errorf("%w: an emoji named :%s: already exists", ErrConflict, shortcode)
	}

	current, err := s.st.ListEmoji(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to count emoji: %v", ErrInternal, err)
	}
	if len(current) >= MaxEmojiCount {
		return nil, fmt.Errorf("%w: this server already has the maximum of %d emoji", ErrBadRequest, MaxEmojiCount)
	}

	created, err := s.st.CreateEmoji(ctx, shortcode, storedAs, mimeType, actorID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create emoji: %v", ErrInternal, err)
	}

	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "emoji_create", "emoji", created.ID,
		fmt.Sprintf("uploaded emoji :%s: (%s)", shortcode, mimeType))
	slog.Info("custom emoji created", "actor_id", actorID, "emoji_id", created.ID, "shortcode", shortcode)
	return created, nil
}

// Delete removes an emoji and returns the row that was removed, so the caller
// can unlink the stored file. The row is returned even though it no longer
// exists: the storage id is only knowable from it.
func (s *EmojiService) Delete(ctx context.Context, actorID, emojiID int64) (*db.Emoji, error) {
	if err := s.RequireManage(ctx, actorID); err != nil {
		return nil, err
	}
	existing, err := s.st.GetEmoji(ctx, emojiID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to load emoji: %v", ErrInternal, err)
	}
	if existing == nil {
		return nil, fmt.Errorf("%w: emoji not found", ErrNotFound)
	}
	deleted, err := s.st.DeleteEmoji(ctx, emojiID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to delete emoji: %v", ErrInternal, err)
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
		return nil, fmt.Errorf("%w: failed to load emoji: %v", ErrInternal, err)
	}
	if e == nil {
		return nil, fmt.Errorf("%w: emoji not found", ErrNotFound)
	}
	return e, nil
}
