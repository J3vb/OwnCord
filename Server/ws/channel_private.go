package ws

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// The channel-level private flag (3D-6): a guild channel is private when the
// default role (is_default) cannot READ_MESSAGES there once that channel's
// override for the role is applied (permissions.IsChannelPrivate). It is the
// same value for every recipient, so shared frames stay shared.

// readyPrivacy is the ready snapshot's private verdicts: the default role's
// base permissions plus its override on every channel, both read once. The
// zero value (no default role found) marks nothing private.
type readyPrivacy struct {
	defaultPerms int64
	overrides    map[int64]permissions.ChannelOverride
	hasDefault   bool
}

// private reports whether the channel is locked. A channel absent from the
// override map has no override; one deleted after the bulk read is simply never
// asked about, since callers iterate the channels they listed.
func (p readyPrivacy) private(channelID int64) bool {
	if !p.hasDefault {
		return false
	}
	return permissions.IsChannelPrivate(p.defaultPerms, p.overrides[channelID])
}

// readyChannelPrivacy resolves the default role from the already-listed roles
// and bulk-reads its overrides (one query, no N+1). Both belong to the same
// ready build, so an override edited meanwhile shows up in the next ready or
// the refresh frame, never as a half-applied state. No default role is not an
// error: nothing is private. A failed bulk read is returned; readReady logs it
// at debug and falls back to readyPrivacy{}, as the single-frame path does. Among several flagged roles the one GetDefaultRole
// picks wins (highest position, then lowest id).
func readyChannelPrivacy(ctx context.Context, database ReadySnapshotReader, roles []*service.Role) (readyPrivacy, error) {
	var def *service.Role
	for _, r := range roles {
		if r == nil || !r.IsDefault {
			continue
		}
		if def == nil || r.Position > def.Position || (r.Position == def.Position && r.ID < def.ID) {
			def = r
		}
	}
	if def == nil {
		return readyPrivacy{}, nil
	}
	raw, err := database.GetAllChannelPermissionsForRole(ctx, def.ID)
	if err != nil {
		return readyPrivacy{}, fmt.Errorf("buildReady GetAllChannelPermissionsForRole: %w", err)
	}
	overrides := make(map[int64]permissions.ChannelOverride, len(raw))
	for id, o := range raw {
		overrides[id] = permissions.ChannelOverride{Allow: o.Allow, Deny: o.Deny}
	}
	return readyPrivacy{defaultPerms: def.Permissions, overrides: overrides, hasDefault: true}, nil
}

// defaultRoleForPrivacy reads the default role once. A failed read or a
// missing role is nil, which marks every channel not private; a read failure is
// logged at debug and never fails a frame.
func (h *Hub) defaultRoleForPrivacy(ctx context.Context) *service.Role {
	if h.readers.Visibility == nil {
		return nil
	}
	role, err := h.readers.Visibility.GetDefaultRole(ctx)
	if err != nil {
		slog.Debug("hub: private flag could not read the default role", "err", err)
		return nil
	}
	return role
}

// channelIsPrivateFor is the per-channel half of channelIsPrivate: one read of
// the default role's override on the channel. A nil role or a DM is not private.
func (h *Hub) channelIsPrivateFor(ctx context.Context, role *service.Role, channelID int64, chanType string) bool {
	if role == nil || chanType == "dm" || h.readers.Visibility == nil {
		return false
	}
	allow, deny, err := h.readers.Visibility.GetChannelPermissions(ctx, channelID, role.ID)
	if err != nil {
		slog.Debug("hub: channelIsPrivate could not read the default role override", "channel_id", channelID, "err", err)
		return false
	}
	return permissions.IsChannelPrivate(role.Permissions, permissions.ChannelOverride{Allow: allow, Deny: deny})
}

// channelIsPrivate is the private flag for one guild channel frame. It costs
// one or two reads — the default role, then its override on the channel.
//
// A DM is never private. No default role, or a lookup that fails, reads as not
// private: the lock is a cosmetic hint, and a frame carrying private=false is
// still correct about everything else, so a read failure is logged at debug and
// never fails the frame. A read racing an override edit sees the old or the new
// row; the refresh frame that edit triggers corrects it.
func (h *Hub) channelIsPrivate(ctx context.Context, channelID int64, chanType string) bool {
	if chanType == "dm" {
		return false
	}
	return h.channelIsPrivateFor(ctx, h.defaultRoleForPrivacy(ctx), channelID, chanType)
}
