package db

import (
	"context"
	"fmt"
)

// MemberBanner is the banner of a roster entry: image path and colour, either may be unset.
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

func memberBannerOf(bannerID, color *string) *MemberBanner {
	banner := BannerURL(bannerID)
	if banner == nil && color == nil {
		return nil
	}
	return &MemberBanner{Banner: banner, BannerColor: color}
}

// MemberRoleSet is a member's displayed role and every role they hold.
type MemberRoleSet struct {
	Role string `json:"role"`
	// RoleIDs is every held role, top role first; never nil from ListMembers.
	RoleIDs []int64 `json:"role_ids"`
}

// MemberSummary is a lightweight user shape for the ready payload.
type MemberSummary struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Status   string  `json:"status"`
	// MemberRoleSet carries role and role_ids, flat in the JSON. An embedded
	// pointer keeps MemberSummary under the range-copy size limit; ListMembers
	// always sets it, and a hand-built summary needs it before .Role or .RoleIDs is read.
	*MemberRoleSet
	// IdentityPublicKey is the user's long-term E2EE identity key (base64), pinned by
	// peers on first sight (TOFU); omitted when unpublished.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
	DisplayName       *string `json:"display_name"`
	About             *string `json:"about"`
	CreatedAt         string  `json:"created_at"`
	// MemberBanner is nil for a member with no banner, which omits both keys; an embedded
	// pointer keeps MemberSummary under the range-copy limit.
	*MemberBanner
	// CustomStatus is the free-text status line. It must stay the last field with
	// a value in the cached encoding (Mobile, omitted when false, follows it):
	// encodeRoster in package ws splices the per-viewer status and custom_status around it.
	CustomStatus *string `json:"custom_status"`
	// Mobile is the live "on the Android app" flag, set only by the ws ready
	// presentation (never read from the database). It follows CustomStatus so a
	// marshal puts it where writeReadyMembers splices it; encodeRoster encodes it false.
	Mobile bool `json:"mobile,omitempty"`
}

// ForViewer returns the summary as viewerID may see it: an invisible member is offline
// to others, decided here.
func (m MemberSummary) ForViewer(viewerID int64) MemberSummary {
	m.Status = StatusForViewer(m.Status, m.ID, viewerID)
	// An invisible member collapses to "offline", but custom_status is a separate
	// column BroadcastStatus never touches; left alone a viewer would see
	// {status:"offline", custom_status:"<text>"}, a tell that the member is online.
	if m.ID != viewerID && m.Status == StatusOffline {
		m.CustomStatus = nil
	}
	// An offline member is on no phone; a phone on an invisible member would give them
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

func memberRoleIDs(ids []int64) []int64 {
	if ids == nil {
		return []int64{}
	}
	return ids
}
