package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// GetMemberGrants returns everything the permission formula needs about one
// member across every channel: the OR of their roles' masks, the per-channel
// overrides, and, where the member holds two or more roles and at least one has
// an override, the per-role breakdown. It is the single fetch behind every
// "what can this member do here" site, so the role and user layers cannot be
// loaded by one site and forgotten by another. Three batch reads, never per
// channel. A member with no role yields zero grants.
//
// Composition (permissions.MemberChannelPerms): each held role is resolved with
// its own override, the results are OR'd, then the member layer applies. A
// one-role member, or a channel where no held role has an override, is
// described by Overrides alone.
// described by Overrides alone, exactly as before several roles existed.
func (d *DB) GetMemberGrants(ctx context.Context, userID int64) (permissions.MemberGrants, error) {
	roles, err := d.q.ListUserRoles(ctx, userID)
	if err != nil {
		return permissions.MemberGrants{}, fmt.Errorf("GetMemberGrants roles: %w", err)
	}
	var grants permissions.MemberGrants
	for _, r := range roles {
		grants.Perms |= r.Permissions
		grants.RoleIDs = append(grants.RoleIDs, r.ID)
	}
	rows, err := d.q.ListHeldRoleChannelOverrides(ctx, userID)
	if err != nil {
		return permissions.MemberGrants{}, fmt.Errorf("GetMemberGrants role overrides: %w", err)
	}
	userOv, err := d.GetAllChannelPermissionsForUser(ctx, userID)
	if err != nil {
		return permissions.MemberGrants{}, fmt.Errorf("GetMemberGrants: %w", err)
	}

	type roleOverride struct{ allow, deny int64 }
	byChannel := make(map[int64]map[int64]roleOverride)
	for _, r := range rows {
		m := byChannel[r.ChannelID]
		if m == nil {
			m = make(map[int64]roleOverride)
			byChannel[r.ChannelID] = m
		}
		m[r.RoleID] = roleOverride{allow: r.Allow, deny: r.Deny}
	}

	grants.Overrides = make(map[int64]permissions.ChannelOverride, len(byChannel)+len(userOv))
	for chID, ov := range byChannel {
		if len(roles) == 1 {
			o := ov[roles[0].ID]
			grants.Overrides[chID] = permissions.ChannelOverride{Allow: o.allow, Deny: o.deny}
			continue
		}
		// Two or more roles with an override here: each role is resolved with
		// its own override, so the breakdown is carried per held role.
		layers := make([]permissions.RoleGrant, 0, len(roles))
		for _, r := range roles {
			o := ov[r.ID]
			layers = append(layers, permissions.RoleGrant{RoleID: r.ID, Perms: r.Permissions, Allow: o.allow, Deny: o.deny})
		}
		if grants.Layers == nil {
			grants.Layers = make(map[int64][]permissions.RoleGrant)
		}
		grants.Layers[chID] = layers
	}
	for chID, o := range userOv {
		existing := grants.Overrides[chID]
		existing.UserAllow = o.UserAllow
		existing.UserDeny = o.UserDeny
		grants.Overrides[chID] = existing
	}
	return grants, nil
}
