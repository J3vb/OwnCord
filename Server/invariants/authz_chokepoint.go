package invariants

import (
	"go/ast"
	"go/token"
	"path"
)

// authzChokepointID is the rule's stable id (a const for the same
// initialization-cycle reason as syncutilLocksID).
const authzChokepointID = "authz-chokepoint"

// permissionsImportPath is the package that owns every authorization decision.
const permissionsImportPath = "github.com/J3vb/OwnCord/Server/permissions"

// rawPermChecks are the raw bit helpers exported by permissions.go: the six
// call targets HP-2 question 5's residue grep treats as a raw check
// (HasPerm, HasAnyPerm, HasServerPerm, HasAdmin, EffectivePerms,
// EffectiveChannelPerms). They are the whole of that file's exported surface
// apart from Name, which formats a bit rather than deciding on one.
//
// Everything else in the package is a chokepoint rather than a raw check and
// is deliberately absent: the B2-5 predicates (CanViewChannel,
// CanAdmitSession, CanSendMessage, CanType, CanJoinVoice, CanModerateVoice),
// Subject.Has, and Checker — those are what a call site is supposed to use.
var rawPermChecks = map[string]bool{
	"HasPerm":               true,
	"HasAnyPerm":            true,
	"HasServerPerm":         true,
	"HasAdmin":              true,
	"EffectivePerms":        true,
	"EffectiveChannelPerms": true,
}

// Residue classes, from HP-2 question 5's table. Each says why the sites in it
// are not a channel predicate, so B3-8 can retire a whole class at once.
const (
	// classServerScoped: a server-wide permission with no channel to resolve
	// a permissions.Subject for. These are the canonical server-wide check.
	classServerScoped = "server-scoped"
	// classAdminShortCircuit: HasAdmin used to skip the override query before
	// the predicate runs. An optimisation, not a decision.
	classAdminShortCircuit = "admin-short-circuit"
	// classAdminPerimeter: HasAdmin as an authorization input for role
	// hierarchy and the admin perimeter — the 2026-08-18 measurement's
	// "no Outranks" class.
	classAdminPerimeter = "admin-perimeter"
	// classBulkReaderWalk: the bulk @everyone reader walk, a per-role layer
	// walk whose mechanical conversion the owner declined on 2026-08-18.
	classBulkReaderWalk = "bulk-reader-walk"
	// classBaseBitRejection: a base-bit early rejection ahead of
	// CanModerateVoice. It never admits; it keeps FORBIDDEN ahead of the
	// voice-state lookup (a B2-5 decision).
	classBaseBitRejection = "base-bit-rejection"
)

// authzResidueClasses is the closed set of classes a row may carry;
// TestAuthzResidueAllowIsLive rejects any other value. A row cannot invent a
// class, and that includes the "unclassified" escape valve the B3-6 brief
// sketched: a genuinely new kind of residue means adding a constant above as a
// deliberate, reviewable edit, so nothing reaches the allowlist without a
// classification someone chose. authzClassList must name it too.
var authzResidueClasses = map[string]bool{
	classServerScoped:      true,
	classAdminShortCircuit: true,
	classAdminPerimeter:    true,
	classBulkReaderWalk:    true,
	classBaseBitRejection:  true,
}

// authzClassList names the legal classes in the violation message. Built from
// the constants, so it cannot drift from them; TestAuthzResidueAllowIsLive
// checks it covers authzResidueClasses.
const authzClassList = classServerScoped + ", " + classAdminShortCircuit + ", " +
	classAdminPerimeter + ", " + classBulkReaderWalk + ", " + classBaseBitRejection

// AuthzResidueEntry is one row of HP-2 question 5's residue table: why a
// production symbol outside Server/permissions still calls a raw bit helper
// instead of a predicate.
type AuthzResidueEntry struct {
	Class string // one of the classes above; the set is closed
	Note  string // what this particular site does
}

// AuthzResidueAllow is the residue. Rows are keyed by symbol — the file's
// directory relative to the Server tree, then the enclosing function or
// method, e.g. "ws.(*Hub).readyVisibleChannels" — never by file:line, because
// lines move on every edit and a stale line number would silently stop
// matching. The directory rather than the package clause keeps the four
// `package main` files at different paths from colliding.
//
// The list only shrinks: a symbol that stops calling a raw helper fails
// TestAuthzResidueAllowIsLive, and a new raw call anywhere else fails
// authz-chokepoint. B3-8 deletes rows as it moves each family behind a
// service.
//
// 19 symbols, 21 call sites, matching HP-2 question 5 at dev 75d64dd4.
var AuthzResidueAllow = map[string]AuthzResidueEntry{
	// ── server-scoped: no channel exists to resolve a Subject for ──────────
	"admin.adminAuthMiddleware":                {classServerScoped, "HasAnyPerm over AdminPerimeter gates the admin panel as a whole"},
	"admin.requirePerm":                        {classServerScoped, "per-route server permission for the admin mux"},
	"api.RequirePermission":                    {classServerScoped, "per-route server permission for the REST mux"},
	"service.(*EmojiService).RequireManage":    {classServerScoped, "MANAGE_SERVER is server-wide; emoji have no channel"},
	"service.(*ModerationService).requirePerm": {classServerScoped, "ban/kick/timeout are server-wide"},
	"service.(*RoleService).actorRole":         {classServerScoped, "MANAGE_ROLES is server-wide"},

	// ── HasAdmin as a fetch short-circuit, ahead of the predicate ──────────
	"service.(*ChannelService).ListVisibleChannels":     {classAdminShortCircuit, "an administrator sees every channel; skips the override query"},
	"service.(*MessageService).GetAccessibleChannelIDs": {classAdminShortCircuit, "an administrator searches every channel; skips the override query"},
	"service.(*PermissionService).getOrPopulate":        {classAdminShortCircuit, "cache fill skips the override query for an administrator"},
	"ws.(*Hub).computeAllowedChannels":                  {classAdminShortCircuit, "broadcast audience skips the override query for an administrator"},
	"ws.(*Hub).readyVisibleChannels":                    {classAdminShortCircuit, "ready snapshot skips the override query for an administrator"},
	"ws.(*Hub).voiceJoinPublishPerms":                   {classAdminShortCircuit, "publish/video/screenshare bits skip the override query for an administrator"},

	// ── HasAdmin as an authorization input: role hierarchy and perimeter ───
	"admin.requireGrantableOverride": {classAdminPerimeter, "refuses an override that grants past the actor's own role"},
	"admin.requireManageableUser":    {classAdminPerimeter, "role-hierarchy check on the target user"},
	"admin.logStreamAuthorize":       {classAdminPerimeter, "the log stream is administrator-only, re-checked per tick"},
	"api.serveFileAuthorize":         {classAdminPerimeter, "administrator bypass for attachment access"},
	"service.requireGrantable":       {classAdminPerimeter, "refuses a role edit that grants past the actor's own bits"},

	// ── bulk @everyone reader walk ─────────────────────────────────────────
	"service.(*MessageService).mentionReaders": {classBulkReaderWalk, "per-role layer walk over every role that can read the channel"},

	// ── base-bit early rejection ahead of CanModerateVoice ─────────────────
	"ws.voiceModTarget": {classBaseBitRejection, "rejects on MUTE_MEMBERS before the voice-state lookup; never admits"},
}

// authzChokepoint fails on any production symbol outside Server/permissions
// that calls a raw permission bit helper without a residue row. B2-5 gave
// every channel-scoped security property exactly one predicate; this rule
// keeps the next call site from re-deriving one of them by hand, which is how
// the thirteen hand-rolled decision sites B2-5 collapsed came to exist.
//
// Test files are out of scope — Run never parses them — so a parity table may
// call the helpers freely.
var authzChokepoint = Rule{
	ID:    authzChokepointID,
	Scope: nil, // every directory; permissions/ itself is excluded in Check
	Check: checkAuthzChokepoint,
}

func checkAuthzChokepoint(f *ast.File, fset *token.FileSet, rel string) []Violation {
	var out []Violation
	for _, h := range authzHits(f, fset, rel) {
		if _, listed := AuthzResidueAllow[h.Symbol]; listed {
			continue
		}
		out = append(out, Violation{
			Rule: authzChokepointID,
			File: rel,
			Line: h.Line,
			Msg:  h.message(),
		})
	}
	return out
}

// authzHit is one raw permission check at one source location, tagged with the
// symbol an AuthzResidueAllow row would name.
type authzHit struct {
	Symbol string // e.g. "ws.(*Hub).readyVisibleChannels"
	Helper string // e.g. "HasAdmin", or "" for a dot-import
	Line   int
}

func (h authzHit) message() string {
	if h.Helper == "" {
		return `dot-import of the permissions package defeats authz-chokepoint (a bare HasAdmin/HasPerm call can no longer be matched); import permissions normally`
	}
	return "raw permissions." + h.Helper + " resolves permission bits outside Server/permissions " +
		"(the Has* helpers decide, the Effective* ones compute the mask a decision then reads); " +
		"resolve a permissions.Subject and ask the predicate that owns the property " +
		"(CanViewChannel, CanAdmitSession, CanSendMessage, CanType, CanJoinVoice, CanModerateVoice), " +
		"or add an AuthzResidueAllow entry for " + h.Symbol + " with a reason and one of the classes " +
		authzClassList
}

// authzHits reports every raw permission check in one file, whether or not it
// is allowlisted, so the rule and TestAuthzResidueAllowIsLive read the same
// scan from opposite directions.
//
// It matches the selector, not the call: `f := permissions.HasAdmin` followed
// by `f(bits)` is the same decision made at the same place, and a rule that
// only looked at CallExpr would miss it.
func authzHits(f *ast.File, fset *token.FileSet, rel string) []authzHit {
	dir := path.Dir(rel)
	if dir == "." {
		dir = ""
	}
	// permissions/ needs no exemption and deliberately does not get one: a file
	// in that package cannot import itself, so it binds no "permissions"
	// identifier and matches nothing here. A directory-keyed exemption would be
	// worse than redundant — it would silently exempt a future
	// permissions/<sub>, which is a different package that does import
	// permissions and must be checked like any other.
	names, dotImports := importNames(f, permissionsImportPath)

	var out []authzHit
	for _, imp := range dotImports {
		out = append(out, authzHit{
			Symbol: dir + "." + enclosingSymbol(f, imp.Pos()),
			Line:   fset.Position(imp.Pos()).Line,
		})
	}
	if len(names) == 0 {
		return out
	}

	ast.Inspect(f, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok || !names[pkg.Name] || !rawPermChecks[sel.Sel.Name] {
			return true
		}
		out = append(out, authzHit{
			Symbol: dir + "." + enclosingSymbol(f, sel.Pos()),
			Helper: sel.Sel.Name,
			Line:   fset.Position(sel.Pos()).Line,
		})
		return true
	})
	return out
}
