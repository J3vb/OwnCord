package admin_test

import (
	"regexp"
	"strings"
	"testing"
)

// The admin panel is hand-written JS inside static/index.html, so nothing
// compiles it and nothing else can fail when a shipped route has no caller.
// These tests pin the wiring the way emoji_section_test.go pins the Emoji
// section: the reachability of each B4 feature from the only operator
// surface the product ships, plus the row-level defects that made a shipped
// control lie about what it was showing.

// OC-0350: POST /api/v1/auth/login answers a TOTP account with 200 plus
// {partial_token, requires_2fa} and NO token. Without the second leg the
// panel stores the literal "undefined" and locks the operator out for good —
// and the account it locks out is the one holding B4-6's owner-assisted
// recovery.
func TestAdminPanelLoginCompletesTwoFactor(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, "requires_2fa") || !strings.Contains(source, "partial_token") {
		t.Error("the sign-in handler never looks at requires_2fa / partial_token")
	}
	if !strings.Contains(source, "'/api/v1/auth/verify-totp'") {
		t.Error("nothing calls POST /api/v1/auth/verify-totp, so a 2FA sign-in can never complete")
	}
	// The partial token authenticates verify-totp, exactly as
	// Client/src/lib/api.ts verifyTotp does.
	if !strings.Contains(source, "'Authorization':'Bearer '+state.partialToken") {
		t.Error("verify-totp is not authenticated with the partial token")
	}
	// A 200 with no token must not be stored: that is what wrote "undefined"
	// into localStorage and produced a false "session expired".
	if !strings.Contains(source, "if(!d.token)throw new Error") {
		t.Error("a token-less login response is still assigned to state.token")
	}
	for _, fn := range []string{
		"function showLoginTotp(",
		"function resetLoginSteps(",
	} {
		if !strings.Contains(source, fn) {
			t.Errorf("missing %q", fn)
		}
	}
	if !strings.Contains(source, `id="loginTotpStep"`) || !strings.Contains(source, `id="loginTotp"`) {
		t.Error("the login overlay has no second step to enter the code in")
	}
}

// OC-0390: DELETE /admin/api/users/{id} (B4-9 account erasure) is mounted
// behind ADMINISTRATOR and had no caller. The only user DELETE the panel
// made was the force-logout, which is the older path erasure replaces.
func TestAdminPanelEraseAccountIsReachable(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, `api('DELETE','/users/'+uid)`) {
		t.Error("nothing calls DELETE /admin/api/users/{id}, so account erasure is unreachable")
	}
	for _, fn := range []string{"function openEraseUser(", "async function confirmEraseUser("} {
		if !strings.Contains(source, fn) {
			t.Errorf("missing %q", fn)
		}
	}
	// Irreversible: the confirmation has to say so, and a slip must not be
	// able to reach it from the neighbouring force-logout button.
	if !strings.Contains(source, "This cannot be undone") {
		t.Error("the erase confirmation does not say the action cannot be undone")
	}
	if !strings.Contains(source, "eraseConfirm") {
		t.Error("erasure is not typed-confirmation guarded")
	}
	if !strings.Contains(source, "if(typed!==uname)") {
		t.Error("the typed confirmation is not checked against the username")
	}
}

// OC-0389: GET /retention, GET /retention/preview, PUT and DELETE
// /channels/{id}/retention are all mounted under MANAGE_SERVER and none of
// them had a caller, so a policy that continuously and irreversibly deletes
// message history could be neither set, inspected, overridden nor previewed.
func TestAdminPanelRetentionIsWired(t *testing.T) {
	source := adminPanelSource(t)

	navRe := regexp.MustCompile(`\{id:'retention',[^}]*allowed:\(\)=>can\(PERM\.MANAGE_SERVER\)\}`)
	if !navRe.MatchString(source) {
		t.Error("no NAV entry for 'retention' gated on PERM.MANAGE_SERVER")
	}
	if !strings.Contains(source, "retention:renderRetention") {
		t.Error("renderContent dispatch map has no retention:renderRetention entry")
	}
	for _, call := range []string{
		`api('GET','/retention')`,
		`api('GET','/retention/preview')`,
		`api('PUT','/channels/'+id+'/retention'`,
		`api('DELETE','/channels/'+id+'/retention')`,
	} {
		if !strings.Contains(source, call) {
			t.Errorf("no caller for %s", call)
		}
	}
	// The server-wide window is the retention_days setting; without it the
	// per-channel overrides have nothing to override.
	if !strings.Contains(source, "retention_days") {
		t.Error("the server-wide retention_days window has no control")
	}
	// The preview endpoint exists so the effect is visible BEFORE the policy
	// is applied — the apply path has to show it.
	if !strings.Contains(source, "would_delete") {
		t.Error("the effect preview's would_delete count is never rendered")
	}
}

// OC-0331: api_tokens.created_at / last_used_at are SQLite datetime('now')
// strings — naive UTC with no zone — and new Date() reads that non-ISO form
// as LOCAL time. expires_at in the same row carries an explicit Z and was
// therefore right, so the table contradicted itself.
func TestAdminPanelTokenTimestampsParsedAsUTC(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, "function utcDate(") {
		t.Error("no helper normalising naive-UTC SQLite timestamps")
	}
	for _, raw := range []string{
		"new Date(t.created_at)",
		"new Date(t.last_used)",
	} {
		if strings.Contains(source, raw) {
			t.Errorf("%s is still parsed as local time", raw)
		}
	}
	for _, fixed := range []string{"utcDate(t.created_at)", "utcDate(t.last_used)"} {
		if !strings.Contains(source, fixed) {
			t.Errorf("missing %s", fixed)
		}
	}
}

// OC-0355: the global "/" hotkey called preventDefault whenever any
// .filter-search existed, including while the caret was inside that very
// field — so "/" could never be typed into the audit or log filter, and the
// login form inherited the swallow because #content keeps its markup.
func TestAdminPanelSlashHotkeyIgnoresTextFields(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, "t.isContentEditable") ||
		!strings.Contains(source, `/^(input|textarea|select)$/i.test(t.tagName)`) {
		t.Error(`the "/" hotkey still preventDefaults inside text fields`)
	}
}

// OC-0361: "has more" was `rows.length < PAGE_SIZE` on a page fetched with
// limit=PAGE_SIZE, so a full page was indistinguishable from a full page
// with nothing after it and the ">" button offered a phantom empty page.
// MessageService.GetMessages already asks for limit+1 for exactly this.
func TestAdminPanelPaginationOverfetches(t *testing.T) {
	source := adminPanelSource(t)

	for _, over := range []string{
		`'/users?limit='+(PAGE_SIZE+1)+'&offset='+offset`,
		`'/audit-log?limit='+(PAGE_SIZE+1)+'&offset='+offset`,
	} {
		if !strings.Contains(source, over) {
			t.Errorf("missing over-fetch %s", over)
		}
	}
	if strings.Contains(source, "users.length<PAGE_SIZE") || strings.Contains(source, "entries.length<PAGE_SIZE") {
		t.Error("the next-page button still derives hasMore from a full page")
	}
	if strings.Count(source, "hasMore") < 4 {
		t.Error("hasMore is not derived from the overflow row on both pages")
	}
}

// OC-0364: nothing clears users.banned when a temporary ban lapses — expiry
// is decided lazily by auth.IsEffectivelyBanned and the notBannedClause. The
// Users table read the raw column, so a fully active account showed as
// "Banned: Yes" for ever with only an Unban action.
func TestAdminPanelUsesEffectiveBanState(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, "function effectiveBan(") {
		t.Error("no helper deriving the effective ban from banned + ban_expires")
	}
	if !strings.Contains(source, "ban_expires") {
		t.Error("the Users table still ignores ban_expires")
	}
	if !strings.Contains(source, "const banned=effectiveBan(u)") {
		t.Error("the Users row still reads the raw banned column")
	}
}

// OC-0367: the create modal prefilled position = myPosition()-1 and always
// sent it, so the server's free-slot walk-down never ran and every role after
// the first was refused with "position N is already used by another role".
func TestAdminPanelCreateRolePicksFreePosition(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, "while(position>0&&taken[position])position--") {
		t.Error("Create Role does not walk down to a free position")
	}
	if strings.Contains(source, "const position=role?role.position:Math.max(0,myPosition()-1);") {
		t.Error("Create Role still prefills the occupied slot below the actor")
	}
}

// OC-0373: the action <select> was rebuilt from the current page only while
// state.auditActionFilter is global, so once the filtered action left the
// page no option carried `selected`, the control read "All Actions" with the
// filter still applied, and picking "All Actions" fired no change event.
func TestAdminPanelAuditFilterKeepsActiveOption(t *testing.T) {
	source := adminPanelSource(t)

	if !strings.Contains(source, "state.auditActionFilter!=='all'?[state.auditActionFilter]:[]") {
		t.Error("the active action filter is not kept in the option set")
	}
}
