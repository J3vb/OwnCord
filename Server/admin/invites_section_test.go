package admin_test

import (
	"regexp"
	"strings"
	"testing"
)

// O1: the setup wizard promises invites can be created later in the admin
// panel, but the panel had no invite page. The member API (/api/v1/invites,
// MANAGE_INVITES) is reached the way the Emoji section reaches /api/v1/emoji —
// the panel's session token authenticates there unchanged — plus a redemption
// history per invite so a leaked invite can be traced to its redeemer.
func TestAdminPanelInvitesAreWired(t *testing.T) {
	source := adminPanelSource(t)

	navRe := regexp.MustCompile(`\{id:'invites',[^}]*allowed:\(\)=>can\(PERM\.MANAGE_INVITES\)\}`)
	if !navRe.MatchString(source) {
		t.Error("no NAV entry for 'invites' gated on PERM.MANAGE_INVITES")
	}
	if !strings.Contains(source, "invites:renderInvites") {
		t.Error("renderContent dispatch map has no invites:renderInvites entry")
	}
	for _, fn := range []string{
		"async function renderInvites(",
		"async function createInvite(",
		"function revokeInvite(",
		"async function openInviteRedemptions(",
	} {
		if !strings.Contains(source, fn) {
			t.Errorf("missing %q", fn)
		}
	}
	// The permission mask the panel offers must include MANAGE_INVITES, or the
	// nav gate can never be true.
	if !strings.Contains(source, "MANAGE_INVITES:") {
		t.Error("PERM has no MANAGE_INVITES entry, so the invites nav can never show")
	}
	// The page works against the member API, called with the session token.
	for _, call := range []string{
		`inviteApi('GET','/')`,
		`inviteApi('POST','/',`,
		`inviteApi('DELETE','/'+code)`,
		`inviteApi('GET','/'+code+'/redemptions')`,
	} {
		if !strings.Contains(source, call) {
			t.Errorf("no caller for %s", call)
		}
	}
	// A redemption row that names nobody is an erased redeemer, not a blank.
	if !strings.Contains(source, "red.user_id") {
		t.Error("the redemption history never checks whether the redeemer still exists")
	}
	// The page must be reachable without an inline script (CSP script-src 'self').
	if !strings.Contains(source, `src="/admin/js/invites.js"`) {
		t.Error("index.html does not load js/invites.js")
	}
}
