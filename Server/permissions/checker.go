package permissions

import (
	"context"
	"errors"
	"slices"
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
	// NSFW is consulted only by CanReadContent; every other predicate
	// ignores it. Always false for a DM — DMs cannot be labelled.
	NSFW bool
	// AuthorityID is the parent of a thread, whose overrides are the
	// thread's; 0 means the channel is its own authority. A thread's Archived
	// and NSFW are already its parent's (the channel queries merge them).
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
// Defined at the consumer (per Go convention: accept interfaces, return structs).
type DB interface {
	GetChannelPermissions(ctx context.Context, channelID, roleID int64) (allow, deny int64, err error)
	GetUserChannelPermissions(ctx context.Context, channelID, userID int64) (allow, deny int64, err error)
	// HasActiveTimeout is the live, uncached timeout lookup: Subject.TimedOut is
	// filled from it on every Subject call, never from a cache.
	HasActiveTimeout(ctx context.Context, userID int64) (bool, error)
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

// MemberGrants is a member's pre-fetched permission state for every channel:
// Perms is the OR of all held role masks; Overrides carries the per-channel
// override (the single role's layer plus the member layer for a one-role
// member, only the member layer where Layers is set); Layers holds the
// per-held-role breakdown for the channels where the member holds two or more
// roles and at least one has an override. A missing map entry means "no
// override" and is always the correct answer. Build it with db.GetMemberGrants.
type MemberGrants struct {
	Perms int64
	// RoleIDs are the held roles the grants were read for, top role first. A
	// caller that also read the roles separately compares the two to notice a
	// role change that landed between the reads.
	RoleIDs   []int64
	Overrides map[int64]ChannelOverride
	Layers    map[int64][]RoleGrant
}

// Subject returns the value-taking subject for channelID with the role bits
// and layers resolved. The channel's flags and DM state are the caller's.
func (g MemberGrants) Subject(channelID int64) Subject {
	// Layers is cloned so a caller holding the Subject cannot write through
	// into a cached MemberGrants.
	return Subject{RolePerms: g.Perms, Override: g.Overrides[channelID], Layers: slices.Clone(g.Layers[channelID])}
}

// HasChannelPerm reports whether the member (identified by the roles they
// hold and userID) has all the given permission bits on the specified channel.
// Administrator in any held role bypasses all checks. Every held role's
// override and the user's are fetched from the database per call and composed
// as MemberChannelPerms does.
//
// userID may be 0 for a check that is genuinely role-only (no member in hand);
// the per-user layer is then skipped rather than queried for a nonexistent id.
func (ck *Checker) HasChannelPerm(ctx context.Context, held []RoleGrant, userID, channelID, perm int64) bool {
	s, err := ck.Subject(ctx, held, userID, channelID)
	if err != nil {
		return false
	}
	return s.Has(perm)
}

// Subject resolves every held role's override and the user's override for the
// member in channelID, live from the database, and returns them with the role
// bits as a Subject for the value-taking predicates (CanViewChannel and
// friends). held carries each held role's id and mask (Allow/Deny are ignored
// and read from the database). The channel's flags and any DM state are the
// caller's to fill in. Administrator skips the fetch — overrides never change
// its verdict. A lookup failure is returned, not collapsed, so error-aware
// callers (the voice sweep) can tell a transient read failure from a denial;
// HasChannelPerm collapses it to false.
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

// HasChannelPermBatch reports whether the member has the given permission on
// the channel using pre-fetched grants (build them with db.GetMemberGrants).
// The grants are keyed by override authority, so a thread's id must be resolved
// to its parent's first (service.PermissionService does). This avoids N+1
// queries when filtering many channels in bulk. A channel with no entry in
// grants is correct -- it means no override exists at either layer.
func (ck *Checker) HasChannelPermBatch(grants MemberGrants, channelID, perm int64) bool {
	return grants.Subject(channelID).Has(perm)
}

// VisibleChannelIDs returns the set of non-DM channel IDs the member
// (identified by their MemberGrants) may READ, using pre-fetched grants. It is
// the single predicate behind every "which channels does this member see" site
// (REST ListVisibleChannels, the ws ready payload, and reconnect replay
// filtering) so they can never drift apart. DM channels are skipped — their
// visibility is membership-based, layered on top by the caller. Zero grants
// yield an empty set naturally (no admin bypass, no base READ, and no entries
// to grant it).
func (ck *Checker) VisibleChannelIDs(grants MemberGrants, channels []ChannelRef) map[int64]bool {
	visible := make(map[int64]bool)
	for _, ch := range channels {
		if ch.Type == "dm" {
			continue
		}
		// CanViewChannel hides archived channels from every client surface
		// (admins included) — they stay manageable from the admin panel,
		// which lists channels without this predicate.
		sub := grants.Subject(ch.OverrideKey())
		sub.Channel = ch
		if CanViewChannel(sub) == nil {
			visible[ch.ID] = true
		}
	}
	return visible
}
