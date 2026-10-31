package db

import (
	"context"
	"fmt"
)

// MemberBanner is the banner part of a roster entry: the image path
// (/api/v1/files/<id>) and the colour. Either may be unset.
type MemberBanner struct {
	Banner      *string `json:"banner,omitempty"`
	BannerColor *string `json:"banner_color,omitempty"`
}

// BannerOf returns the member's banner image path and colour, nil when unset.
func (m *MemberSummary) BannerOf() (banner, color *string) {
	if m.MemberBanner == nil {
		return nil, nil
	}
	return m.Banner, m.BannerColor
}

// memberBannerOf builds the roster banner for a users row, nil when it has none.
func memberBannerOf(bannerID, color *string) *MemberBanner {
	banner := BannerURL(bannerID)
	if banner == nil && color == nil {
		return nil
	}
	return &MemberBanner{Banner: banner, BannerColor: color}
}

// MemberRoleSet is a member's displayed role and every role they hold.
type MemberRoleSet struct {
	// Role is the top role's lowercased name.
	Role string `json:"role"`
	// RoleIDs is every held role, top role first. Never nil from ListMembers:
	// a member holds at least one role, and the wire always carries an array.
	RoleIDs []int64 `json:"role_ids"`
}

// MemberSummary is a lightweight user shape for the ready payload.
type MemberSummary struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Status   string  `json:"status"`
	// MemberRoleSet carries role (the top role's lowercased name) and role_ids
	// (every role held, top first), flat in the JSON here. An embedded pointer
	// keeps MemberSummary under the range-copy size limit; ListMembers always sets
	// it, and a hand-built summary needs it before .Role or .RoleIDs is read.
	*MemberRoleSet
	// IdentityPublicKey is the user's long-term E2EE identity public key
	// (base64), pinned by peers on first sight (F3 TOFU). Omitted when the
	// user has not published one.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
	// DisplayName is the nickname to render instead of Username. Null when
	// unset; clients fall back to Username.
	DisplayName *string `json:"display_name"`
	// About is the profile bio (About Me). Null when unset.
	About *string `json:"about"`
	// Mobile is the live "on the Android app" flag, set only by the ws ready
	// presentation (never read from the database) and omitted when false. A
	// ready encodes it after custom_status, so encodeRoster's cached bytes do not
	// carry it.
	Mobile bool `json:"mobile,omitempty"`
	// CreatedAt is the account creation instant, "2006-01-02T15:04:05Z".
	CreatedAt string `json:"created_at"`
	// MemberBanner is nil for a member with no banner, which omits both keys. An
	// embedded pointer keeps MemberSummary under the range-copy size limit.
	*MemberBanner
	// CustomStatus is the free-text status line shown under the name. Null
	// when unset. It must stay the LAST field: encodeRoster in package ws
	// splices the per-viewer status and custom_status around it.
	CustomStatus *string `json:"custom_status"`
}

// ForViewer returns a copy of the summary as viewerID may see it: an invisible
// member is offline to everyone but themselves. Ready payloads go through this
// so "who is invisible" is decided in exactly one place.
func (m MemberSummary) ForViewer(viewerID int64) MemberSummary {
	m.Status = StatusForViewer(m.Status, m.ID, viewerID)
	// A connected-but-invisible member collapses to "offline" above, but
	// custom_status is a separate column BroadcastStatus never touches; left alone
	// a viewer would see {status:"offline", custom_status:"<text>"}, a tell that
	// the member is online. Blank it at the same choke point.
	if m.ID != viewerID && m.Status == StatusOffline {
		m.CustomStatus = nil
	}
	// An offline member is on no phone, and a phone on an invisible member would
	// give them away the same way.
	if m.Status == StatusOffline {
		m.Mobile = false
	}
	return m
}

// ListMembers returns non-banned users as lightweight summaries.
func (d *DB) ListMembers(ctx context.Context) ([]MemberSummary, error) {
	rows, err := d.q.ListMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListMembers: %w", err)
	}
	held, err := d.q.ListAllUserRoleIDs(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListMembers role ids: %w", err)
	}
	byUser := make(map[int64][]int64)
	for _, h := range held {
		byUser[h.UserID] = append(byUser[h.UserID], h.RoleID)
	}
	members := make([]MemberSummary, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		members = append(members, MemberSummary{
			ID:                r.ID,
			Username:          r.Username,
			Avatar:            r.Avatar,
			Status:            r.Status,
			MemberRoleSet:     &MemberRoleSet{Role: r.Lower, RoleIDs: memberRoleIDs(byUser[r.ID])},
			IdentityPublicKey: r.IdentityPublicKey,
			DisplayName:       r.DisplayName,
			About:             r.About,
			CreatedAt:         r.CreatedAt,
			MemberBanner:      memberBannerOf(r.BannerID, r.BannerColor),
			CustomStatus:      r.CustomStatus,
		})
	}
	return members, nil
}

// memberRoleIDs returns ids as a non-nil slice, so a roster entry always
// encodes role_ids as an array.
func memberRoleIDs(ids []int64) []int64 {
	if ids == nil {
		return []int64{}
	}
	return ids
}
