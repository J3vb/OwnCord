package invariants

import (
	"fmt"
	"go/ast"
	"go/token"
	"path"
)

// authzChokepointID is the rule's stable id (a const to avoid an initialization cycle).
const authzChokepointID = "authz-chokepoint"

// permissionsImportPath is the package that owns every authorization decision.
const permissionsImportPath = "github.com/J3vb/OwnCord/Server/permissions"

// rawPermChecks are the raw bit helpers exported by permissions.go that the
// residue grep treats as a raw check. Name is absent because it formats a bit
// rather than deciding on one; the channel predicates, Subject.Has and Checker
// are the chokepoints a call site should use.
var rawPermChecks = map[string]bool{
	"HasPerm":               true,
	"HasAnyPerm":            true,
	"HasServerPerm":         true,
	"HasAdmin":              true,
	"EffectivePerms":        true,
	"EffectiveChannelPerms": true,
}

// Residue classes. Each says why the sites in it are not a channel predicate,
// so a whole class can be retired at once as its call sites move behind a service.
const (
	// classServerScoped: a server-wide permission with no channel to resolve a Subject for.
	classServerScoped = "server-scoped"
	// classAdminShortCircuit: HasAdmin used to skip the override query; an optimisation, not a decision.
	classAdminShortCircuit = "admin-short-circuit"
	// classAdminPerimeter: HasAdmin as an authorization input for role hierarchy and the admin perimeter.
	classAdminPerimeter = "admin-perimeter"
	// classBulkReaderWalk: the bulk @everyone reader walk, a per-role layer walk.
	classBulkReaderWalk = "bulk-reader-walk"
	// classBaseBitRejection: a base-bit early rejection ahead of CanModerateVoice
	// that never admits; currently unused.
	classBaseBitRejection = "base-bit-rejection"
)

// authzResidueClasses is the closed set of classes a row may carry;
// TestAuthzResidueAllowIsLive rejects any other. A genuinely new kind of
// residue means adding a constant above as a reviewable edit.
var authzResidueClasses = map[string]bool{
	classServerScoped:      true,
	classAdminShortCircuit: true,
	classAdminPerimeter:    true,
	classBulkReaderWalk:    true,
	classBaseBitRejection:  true,
}

// authzClassList names the legal classes in the violation message.
const authzClassList = classServerScoped + ", " + classAdminShortCircuit + ", " +
	classAdminPerimeter + ", " + classBulkReaderWalk + ", " + classBaseBitRejection

// calls is a helper-name to call-count multiset; an alias so the exported field stays a plain map[string]int.
type calls = map[string]int

// AuthzResidueEntry is one row of the residue table: why a production symbol
// outside Server/permissions still calls a raw bit helper, and exactly which calls.
type AuthzResidueEntry struct {
	Class string // one of the classes above; the set is closed
	Note  string // what this particular site does
	// Calls is the exact multiset of raw helper calls the symbol may contain
	// (helper name to count), so a row is no licence for the whole function. An
	// extra or different call fails authz-chokepoint at that line; fewer fails
	// TestAuthzResidueAllowIsLive.
	Calls calls
}

// AuthzResidueAllow is the residue, keyed by symbol (directory relative to the
// Server tree, then the enclosing function, e.g. "ws.(*Hub).readyVisibleChannels"),
// never by file:line, which would silently stop matching as lines move.
//
// A row binds the symbol, which raw helpers it calls and how many times each;
// allowlisting the symbol alone would let the residue grow without review.
//
// The list only shrinks: a symbol that stops calling a raw helper, or whose
// counts no longer match, fails TestAuthzResidueAllowIsLive; an extra or
// different call, or a new raw call elsewhere, fails authz-chokepoint. Raising
// a count is a reviewable edit here.
var AuthzResidueAllow = map[string]AuthzResidueEntry{
	// ── server-scoped: no channel exists to resolve a Subject for ──────────
	"admin.adminAuthMiddleware":                {classServerScoped, "HasAnyPerm over AdminPerimeter gates the admin panel as a whole", calls{"HasAnyPerm": 1}},
	"admin.requirePerm":                        {classServerScoped, "per-route server permission for the admin mux", calls{"HasServerPerm": 1}},
	"admin.handleGetConfigFacts":               {classServerScoped, "ADMINISTRATOR is server-wide; gates the host path and endpoint fields of GET /config", calls{"HasServerPerm": 1}},
	"api.RequirePermission":                    {classServerScoped, "per-route server permission for the REST mux", calls{"HasServerPerm": 1}},
	"service.(*EmojiService).RequireManage":    {classServerScoped, "MANAGE_SERVER is server-wide; emoji have no channel", calls{"HasServerPerm": 1}},
	"service.(*ModerationService).requirePerm": {classServerScoped, "ban/kick/timeout are server-wide", calls{"HasServerPerm": 1}},
	// Voice moderation asks permissions.CanModerateVoice, not a raw bit.
	"service.(*RoleService).actorRole": {classServerScoped, "MANAGE_ROLES is server-wide", calls{"HasServerPerm": 1}},

	// ── HasAdmin as a fetch short-circuit, ahead of the predicate ──────────
	"service.(*ChannelService).ListVisibleChannels": {classAdminShortCircuit, "an administrator sees every channel; skips the override query", calls{"HasAdmin": 1}},
	// The channel family's override guards.
	"service.requireGrantableChannelOverride":         {classAdminPerimeter, "refuses an override that grants past the actor's own role", calls{"HasAdmin": 1}},
	"service.(*channelOverrides).requireOutranks":     {classAdminPerimeter, "role-hierarchy check on the target user; admin bypass", calls{"HasAdmin": 1}},
	"service.(*messageReads).GetAccessibleChannelIDs": {classAdminShortCircuit, "an administrator searches every channel; skips the override query", calls{"HasAdmin": 1}},
	"service.(*PermissionService).loadPerms":          {classAdminShortCircuit, "cache fill skips the override query for an administrator", calls{"HasAdmin": 1}},
	"service.(*PermissionService).Subject":            {classAdminShortCircuit, "skips the TimedOut lookup for an administrator (B5-9)", calls{"HasAdmin": 1}},
	"ws.(*Hub).computeAllowedChannels":                {classAdminShortCircuit, "broadcast audience skips the override query for an administrator", calls{"HasAdmin": 1}},
	"ws.(*Hub).readyVisibleChannels":                  {classAdminShortCircuit, "ready snapshot skips the override query for an administrator", calls{"HasAdmin": 1}},
	"ws.(*Hub).voiceJoinPublishPerms":                 {classAdminShortCircuit, "publish/video/screenshare bits skip the override query for an administrator", calls{"HasAdmin": 1}},

	// ── HasAdmin as an authorization input: role hierarchy and perimeter ───
	"service.(*UploadService).Authorize": {classAdminPerimeter, "administrator bypass for attachment access", calls{"HasAdmin": 1}},
	"service.requireGrantable":           {classAdminPerimeter, "refuses a role edit that grants past the actor's own bits", calls{"HasAdmin": 1}},

	// ── bulk @everyone reader walk ─────────────────────────────────────────
	// The one multi-call row: one EffectivePerms, then HasAdmin twice (to keep an
	// administrator role in, and in the read test).
	"service.(*mentionState).readingRoles": {classBulkReaderWalk, "per-role layer walk over every role that can read the channel", calls{"EffectivePerms": 1, "HasAdmin": 2}},

	// The base-bit-rejection rows are gone (those sites call
	// permissions.AuthorizeVoiceModerator); classBaseBitRejection stays defined
	// for a future call site of that shape.
}

// authzChokepoint fails on any production symbol outside Server/permissions
// that calls a raw permission bit helper without a residue row, so a call site
// cannot re-derive a channel predicate by hand. Test files are out of scope.
var authzChokepoint = Rule{
	ID:    authzChokepointID,
	Scope: nil, // every directory; permissions/ itself is excluded in Check
	Check: checkAuthzChokepoint,
}

func checkAuthzChokepoint(f *ast.File, fset *token.FileSet, rel string) []Violation {
	var out []Violation
	flag := func(h authzHit, msg string) {
		out = append(out, Violation{Rule: authzChokepointID, File: rel, Line: h.Line, Msg: msg})
	}

	// Per symbol, how many calls of each helper were seen in this file (a
	// symbol's hits are always in one file), so the violation lands on the extra call.
	seen := make(map[string]calls)

	for _, h := range authzHits(f, fset, rel) {
		if h.Helper == "" {
			// A dot-import binds no call to count, and an allowlisted symbol is no excuse.
			flag(h, h.message())
			continue
		}
		row, listed := AuthzResidueAllow[h.Symbol]
		if !listed {
			flag(h, h.message())
			continue
		}
		if seen[h.Symbol] == nil {
			seen[h.Symbol] = make(calls)
		}
		seen[h.Symbol][h.Helper]++
		if got, want := seen[h.Symbol][h.Helper], row.Calls[h.Helper]; got > want {
			flag(h, h.excessMessage(want, got))
		}
	}
	return out
}

// authzHit is one raw permission check at one source location, tagged with the symbol a row would name.
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
		"(" + authzPredicateList + "), " +
		"or add an AuthzResidueAllow entry for " + h.Symbol + " with a reason, the calls it binds, " +
		"and one of the classes " + authzClassList
}

// excessMessage is the message for a call a symbol's row does not account for.
func (h authzHit) excessMessage(want, got int) string {
	return fmt.Sprintf("raw permissions.%s at %s: the residue row binds %d call(s) of %s here, found %d. "+
		"A row freezes an inventory, it is not a licence for the function — resolve a permissions.Subject "+
		"and ask the predicate that owns the property (%s), or have the row's count raised under review. "+
		"B3-8 removes rows, it never widens them.",
		h.Helper, h.Symbol, want, h.Helper, got, authzPredicateList)
}

// authzPredicateList names the channel predicates a call site should be using.
const authzPredicateList = "CanViewChannel, CanAdmitSession, CanSendMessage, CanType, CanJoinVoice, CanPassChannelPassword, CanModerateVoice, CanReadContent, CanDeleteMessage, CanPinMessage, CanMentionRole"

// authzHits reports every raw permission check in one file, allowlisted or not,
// so the rule and TestAuthzResidueAllowIsLive read the same scan.
//
// It matches the selector, not the call, so `f := permissions.HasAdmin; f(bits)` is caught.
func authzHits(f *ast.File, fset *token.FileSet, rel string) []authzHit {
	dir := path.Dir(rel)
	if dir == "." {
		dir = ""
	}
	// permissions/ needs no exemption: a file in that package binds no
	// "permissions" identifier. A directory-keyed exemption would also silently
	// exempt a future permissions/<sub>, which must be checked like any other.
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
