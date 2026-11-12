package permissions

import (
	"context"
	"errors"
	"slices"
)

// ErrNotDMParticipant is returned when a user is not a participant in a DM channel.
var ErrNotDMParticipant = errors.New("not a participant in this DM")

// ErrPermissionDenied is returned when a user lacks the required permission.
var ErrPermissionDenied = errors.New("permission denied")

// ChannelOverride holds both override layers for a channel: Allow/Deny are the
// role layer, UserAllow/UserDeny the per-member layer applied on top. The zero
// value means no override.
type ChannelOverride struct {
	Allow     int64
	Deny      int64
	UserAllow int64
	UserDeny  int64
}

// ChannelRef is the channel description VisibleChannelIDs needs.
type ChannelRef struct {
	ID       int64
	Type     string
	Archived bool
	// NSFW is consulted only by CanReadContent; always false for a DM.
	NSFW bool
	// AuthorityID is a thread's parent, whose overrides apply; 0 means the
	// channel is its own authority. A thread's Archived and NSFW are already its parent's.
	AuthorityID int64
	// ThreadLocked is a locked thread: only MANAGE_MESSAGES may post or react.
	ThreadLocked bool
}

// OverrideKey is the channel id whose overrides govern this channel.
func (c ChannelRef) OverrideKey() int64 {
	if c.AuthorityID != 0 {
		return c.AuthorityID
	}
	return c.ID
}

// DB is the minimal database interface the Checker needs.
type DB interface {
	GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error)
	GetUserChannelPermissions(ctx context.Context, channelID, userID int64) (allow, deny int64, err error)
	// HasActiveTimeout is a live, uncached lookup feeding Subject.TimedOut.
	HasActiveTimeout(ctx context.Context, userID int64) (bool, error)
}

// Checker consolidates channel permission checks; it holds no mutable state and is goroutine-safe.
type Checker struct {
	db DB
}

// NewChecker creates a Checker over db.
func NewChecker(db DB) *Checker {
	return &Checker{db: db}
}

// MemberGrants is a member's pre-fetched permission state for every channel.
// Overrides holds the single role's layer plus the member layer (only the
// member layer where Layers is set); Layers is the per-role breakdown for
// channels where a multi-role member has an override. A missing entry means
// no override. Build it with db.GetMemberGrants.
type MemberGrants struct {
	Perms int64
	// RoleIDs are the held roles the grants were read for, top first, so a caller
	// can notice a role change that landed between reads.
	RoleIDs   []int64
	Overrides map[int64]ChannelOverride
	Layers    map[int64][]RoleGrant
}

// Subject returns the subject for channelID; the channel's flags and DM state are the caller's.
func (g MemberGrants) Subject(channelID int64) Subject {
	// Cloned so a caller cannot write through into a cached MemberGrants.
	return Subject{RolePerms: g.Perms, Override: g.Overrides[channelID], Layers: slices.Clone(g.Layers[channelID])}
}

// HasChannelPerm reports whether the member has all the given bits on the
// channel; a lookup failure is false. Administrator in any held role bypasses.
// Overrides are fetched per call; userID 0 skips the per-user layer.
func (ck *Checker) HasChannelPerm(ctx context.Context, held []RoleGrant, userID, channelID, perm int64) bool {
	s, err := ck.Subject(ctx, held, userID, channelID)
	if err != nil {
		return false
	}
	return s.Has(perm)
}

// Subject resolves the held roles' and the user's overrides live from the
// database. held carries each role's id and mask (Allow/Deny are ignored); the
// channel's flags and DM state are the caller's to fill in. Administrator skips
// the fetch. A lookup failure is returned, not collapsed, so callers can tell a
// transient read failure from a denial.
func (ck *Checker) Subject(ctx context.Context, held []RoleGrant, userID, channelID int64) (Subject, error) {
	var rolePerms int64
	for _, g := range held {
		rolePerms |= g.Perms
	}
	s := Subject{RolePerms: rolePerms}
	if HasAdmin(rolePerms) {
		return s, nil
	}
	if userID != 0 {
		timedOut, err := ck.db.HasActiveTimeout(ctx, userID)
		if err != nil {
			return Subject{}, err
		}
		s.TimedOut = timedOut
	}
	layers := make([]RoleGrant, 0, len(held))
	anyOverride := false
	for _, g := range held {
		allow, deny, err := ck.db.GetChannelPermissions(ctx, channelID, g.RoleID)
		if err != nil {
			return Subject{}, err
		}
		anyOverride = anyOverride || allow != 0 || deny != 0
		layers = append(layers, RoleGrant{RoleID: g.RoleID, Perms: g.Perms, Allow: allow, Deny: deny})
	}
	switch {
	case len(layers) > 1 && anyOverride:
		// Each role is resolved with its own override.
		s.Layers = layers
	case len(layers) == 1:
		s.Override = ChannelOverride{Allow: layers[0].Allow, Deny: layers[0].Deny}
	}
	if userID != 0 {
		uAllow, uDeny, uErr := ck.db.GetUserChannelPermissions(ctx, channelID, userID)
		if uErr != nil {
			return Subject{}, uErr
		}
		s.Override.UserAllow, s.Override.UserDeny = uAllow, uDeny
	}
	return s, nil
}

// HasChannelPermBatch is HasChannelPerm over pre-fetched grants, avoiding N+1
// queries. Grants are keyed by override authority, so resolve a thread's id to
// its parent's first.
func (ck *Checker) HasChannelPermBatch(grants MemberGrants, channelID, perm int64) bool {
	return grants.Subject(channelID).Has(perm)
}

// VisibleChannelIDs returns the non-DM channel IDs the member may READ, the
// single predicate behind every "which channels does this member see" site.
// DMs are skipped: their visibility is membership-based, layered on by the caller.
func (ck *Checker) VisibleChannelIDs(grants MemberGrants, channels []ChannelRef) map[int64]bool {
	visible := make(map[int64]bool)
	for _, ch := range channels {
		if ch.Type == "dm" {
			continue
		}
		// CanViewChannel hides archived channels from every client surface,
		// admins included; the admin panel lists them without this predicate.
		sub := grants.Subject(ch.OverrideKey())
		sub.Channel = ch
		if CanViewChannel(sub) == nil {
			visible[ch.ID] = true
		}
	}
	return visible
}
