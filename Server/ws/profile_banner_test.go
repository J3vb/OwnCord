package ws_test

import (
	"context"
	"testing"
)

// A ready roster carries banner and banner_color only for members who set one,
// and a banner-only edit refreshes the cached roster.
func TestBuildReady_BannerOmittedWhenUnset(t *testing.T) {
	hub, database := newTestHub(t)
	viewer := seedOwnerUser(t, database, "viewer")
	other := seedMemberUser(t, database, "other")
	reader := &countingReader{DB: database}

	members := buildReadyMembers(t, hub, reader, viewer.ID)
	for id, m := range members {
		for _, k := range []string{"banner", "banner_color"} {
			if _, ok := m[k]; ok {
				t.Errorf("member %d carries %q with no banner", id, k)
			}
		}
	}

	if _, err := database.ExecContext(context.Background(), `INSERT INTO attachments (id, uploader_id, filename, stored_as, mime_type, size) VALUES ('ban-1', ?, 'b.png', 's', 'image/png', 1)`, other.ID); err != nil {
		t.Fatalf("attachment: %v", err)
	}
	id, color := "ban-1", "#abcdef"
	if err := database.UpdateUserProfile(context.Background(), other.ID, other.Username, nil, nil, nil, &id, &color); err != nil {
		t.Fatalf("UpdateUserProfile: %v", err)
	}
	members = buildReadyMembers(t, hub, reader, viewer.ID)
	if got := members[other.ID]["banner"]; got != "/api/v1/files/ban-1" {
		t.Errorf("banner after a banner-only edit = %v (stale roster cache?)", got)
	}
	if got := members[other.ID]["banner_color"]; got != "#abcdef" {
		t.Errorf("banner_color = %v", got)
	}
	if _, ok := members[viewer.ID]["banner"]; ok {
		t.Errorf("the viewer, who set no banner, carries one")
	}
}
