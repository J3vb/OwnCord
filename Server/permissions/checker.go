package permissions

import (
	"context"
	"errors"
	"fmt"
)

// ─── Errors ─────────────────────────────────────────────────────────────────

// ErrNotDMParticipant is returned when a user is not a participant in a DM channel.
var ErrNotDMParticipant = errors.New("not a participant in this DM")

// ErrPermissionDenied is returned when a user lacks the required permission.
var ErrPermissionDenied = errors.New("permission denied")

// ─── DB interface ───────────────────────────────────────────────────────────

// ChannelOverride holds both override layers for a single channel: Allow/Deny
// are the ROLE layer (channel_overrides), UserAllow/UserDeny the per-member
// layer (channel_user_overrides) that is applied on top of it. The zero value
// means "no override at either layer", which is why a missing map entry is
// always the correct answer.
type ChannelOverride struct {
	Allow     int64
	Deny      int64
	UserAllow int64
	UserDeny  int64
}

// ChannelRef is the minimal channel description VisibleChannelIDs needs.
// Declared here (not imported from db) so the permissions package stays free
// of a db dependency; callers map their []db.Channel down to []ChannelRef.
type ChannelRef struct {
	ID       int64
	Type     string
	Archived bool
}

// DB is the minimal database interface the Checker needs.
// Defined at the consumer (per Go convention: accept interfaces, return structs).
type DB interface {
	GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error)
	GetUserChannelPermissions(ctx context.Context, channelID, userID int64) (allow, deny int64, err error)
	IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error)
}

// ─── Checker ────────────────────────────────────────────────────────────────

// Checker consolidates all channel permission checks into one reusable type.
// It is safe to share across goroutines because it holds no mutable state.
type Checker struct {
	db DB
}

// NewChecker creates a Checker backed by the given database interface.
func NewChecker(db DB) *Checker {
	return &Checker{db: db}
}

// HasChannelPerm reports whether the member (identified by rolePerms, roleID
// and userID) has all the given permission bits on the specified channel.
// Administrator roles bypass all checks. Both override layers — the role's and
// the user's — are fetched from the database per call and resolved by
// EffectiveChannelPerms.
//
// userID may be 0 for a check that is genuinely role-only (no member in hand);
// the per-user layer is then skipped rather than queried for a nonexistent id.
func (ck *Checker) HasChannelPerm(ctx context.Context, rolePerms int64, roleID, userID, channelID, perm int64) bool {
	if HasAdmin(rolePerms) {
		return true
	}
	allow, deny, err := ck.db.GetChannelPermissions(ctx, channelID, roleID)
	if err != nil {
		return false
	}
	o := ChannelOverride{Allow: allow, Deny: deny}
	if userID != 0 {
		uAllow, uDeny, uErr := ck.db.GetUserChannelPermissions(ctx, channelID, userID)
		if uErr != nil {
			return false
		}
		o.UserAllow, o.UserDeny = uAllow, uDeny
	}
	return EffectiveChannelPerms(rolePerms, o)&perm == perm
}

// HasChannelPermBatch reports whether the member has the given permission on
// the channel using a pre-fetched overrides map carrying BOTH layers (build it
// with db.GetChannelOverridesFor). This avoids N+1 queries when filtering many
// channels in bulk. The zero-value ChannelOverride (no entry in map) is correct
// -- it means no override exists at either layer.
func (ck *Checker) HasChannelPermBatch(rolePerms int64, overrides map[int64]ChannelOverride, channelID, perm int64) bool {
	if HasAdmin(rolePerms) {
		return true
	}
	o := overrides[channelID] // zero value when no override exists
	return EffectiveChannelPerms(rolePerms, o)&perm == perm
}

// VisibleChannelIDs returns the set of non-DM channel IDs the member
// (identified by rolePerms plus the two-layer overrides map) may READ, using a
// pre-fetched overrides map. It is the single
// predicate behind every "which channels does this role see" site (REST
// ListVisibleChannels, the ws ready payload, and reconnect replay filtering) so
// they can never drift apart. DM channels are skipped — their visibility is
// membership-based, layered on top by the caller. A nil/zero role yields an
// empty set naturally (no admin bypass, no base READ, and no override map
// entries to grant it).
func (ck *Checker) VisibleChannelIDs(rolePerms int64, channels []ChannelRef, overrides map[int64]ChannelOverride) map[int64]bool {
	visible := make(map[int64]bool)
	for _, ch := range channels {
		if ch.Type == "dm" {
			continue
		}
		// Archived channels are hidden from every client surface (admins
		// included) — they stay manageable from the admin panel, which lists
		// channels without this predicate.
		if ch.Archived {
			continue
		}
		if ck.HasChannelPermBatch(rolePerms, overrides, ch.ID, ReadMessages) {
			visible[ch.ID] = true
		}
	}
	return visible
}

// RequireChannelAccess checks whether the user can access the channel with the
// given permission. For DM channels (channelType == "dm"), it verifies
// participant membership via IsDMParticipant. For regular channels, it checks
// role-based permissions via HasChannelPerm.
//
// Returns nil on success, or a descriptive error on failure.
func (ck *Checker) RequireChannelAccess(ctx context.Context, userID, rolePerms, roleID int64, channelType string, channelID, perm int64) error {
	if channelType == "dm" {
		ok, err := ck.db.IsDMParticipant(ctx, userID, channelID)
		if err != nil {
			return fmt.Errorf("checking DM participation: %w", err)
		}
		if !ok {
			return ErrNotDMParticipant
		}
		return nil
	}

	if !ck.HasChannelPerm(ctx, rolePerms, roleID, userID, channelID, perm) {
		return ErrPermissionDenied
	}
	return nil
}
