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

// MemberSummary is a lightweight user shape for the ready payload.
type MemberSummary struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Status   string  `json:"status"`
	Role     string  `json:"role"`
	// IdentityPublicKey is the user's long-term E2EE identity public key
	// (base64), pinned by peers on first sight (F3 TOFU). Omitted when the
	// user has not published one.
	IdentityPublicKey *string `json:"identity_public_key,omitempty"`
	// DisplayName is the nickname to render instead of Username. Null when
	// unset; clients fall back to Username.
	DisplayName *string `json:"display_name"`
	// About is the profile bio (About Me). Null when unset.
	About *string `json:"about"`
	// CreatedAt is the account creation instant, "2006-01-02T15:04:05Z".
	CreatedAt string `json:"created_at"`
	// MemberBanner is nil for a member with no banner, which omits both keys,
	// so a roster of such members is no larger than before (WP 6.11b). It is an
	// embedded pointer to keep MemberSummary under the range-copy size limit.
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
	// A connected-but-invisible member collapses to "offline" above, but their
	// custom_status is a separate column BroadcastStatus never touches. Left
	// alone, a viewer sees {status:"offline", custom_status:"<text>"} for that
	// member while every genuinely disconnected member is
	// {status:"offline", custom_status:null} — the surviving text is a tell
	// that the member is actually online. Blank it at the same choke point
	// that collapses the status so no other caller has to remember to.
	if m.ID != viewerID && m.Status == StatusOffline {
		m.CustomStatus = nil
	}
	return m
}

// ListMembers returns non-banned users as lightweight summaries.
// M-12: Limited to 1000 rows to prevent unbounded result sets on large servers.
func (d *DB) ListMembers(ctx context.Context) ([]MemberSummary, error) {
	rows, err := d.q.ListMembers(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListMembers: %w", err)
	}
	members := make([]MemberSummary, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		members = append(members, MemberSummary{
			ID:                r.ID,
			Username:          r.Username,
			Avatar:            r.Avatar,
			Status:            r.Status,
			Role:              r.Lower,
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
