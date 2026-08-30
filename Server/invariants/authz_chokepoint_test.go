package invariants

import (
	"go/ast"
	"go/token"
	"maps"
	"strings"
	"testing"
)

func TestAuthzChokepoint(t *testing.T) {
	const importPerms = `import "github.com/J3vb/OwnCord/Server/permissions"`
	tests := []struct {
		name string
		path string
		src  string
		want int
	}{
		{
			name: "unlisted api function calling HasPerm is flagged",
			path: "api/brand_new_handler.go",
			src: "package api\n" + importPerms + `
func brandNew(bits int64) bool { return permissions.HasPerm(bits, 1) }
`,
			want: 1,
		},
		{
			name: "every raw bit helper is flagged",
			path: "api/brand_new_handler.go",
			src: "package api\n" + importPerms + `
func brandNew(bits, a, d int64) bool {
	_ = permissions.HasAnyPerm(bits, 1)
	_ = permissions.HasServerPerm(bits, 1)
	_ = permissions.HasAdmin(bits)
	_ = permissions.EffectivePerms(bits, a, d)
	_ = permissions.EffectiveChannelPerms(bits, permissions.ChannelOverride{})
	return permissions.HasPerm(bits, 1)
}
`,
			want: 6,
		},
		{
			name: "a predicate call is the point of the rule and is clean",
			path: "api/brand_new_handler.go",
			src: "package api\n" + importPerms + `
func brandNew(s permissions.Subject) error { return permissions.CanSendMessage(s) }
`,
			want: 0,
		},
		{
			name: "aliased import is still flagged",
			path: "ws/brand_new.go",
			src: `package ws
import perms "github.com/J3vb/OwnCord/Server/permissions"
func brandNew(bits int64) bool { return perms.HasAdmin(bits) }
`,
			want: 1,
		},
		{
			name: "dot-import is flagged as its own violation",
			path: "ws/brand_new.go",
			src: `package ws
import . "github.com/J3vb/OwnCord/Server/permissions"
func brandNew(bits int64) bool { return HasAdmin(bits) }
`,
			want: 1,
		},
		{
			name: "taking the helper as a value, not calling it, is still flagged",
			path: "ws/brand_new.go",
			src: "package ws\n" + importPerms + `
func brandNew(bits int64) bool {
	f := permissions.HasAdmin
	return f(bits)
}
`,
			want: 1,
		},
		{
			name: "listed method symbol is allowed",
			path: "ws/serve_ready.go",
			src: `package ws
` + importPerms + `
type Hub struct{}
func (h *Hub) readyVisibleChannels(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 0,
		},
		{
			name: "listed plain function symbol is allowed at the calls its row binds",
			path: "api/upload_handler.go",
			src: "package api\n" + importPerms + `
func serveFileAuthorize(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 0,
		},
		{
			// The Codex P2: a row must not exempt the whole function.
			name: "a second call of the bound helper inside a listed symbol is flagged",
			path: "api/upload_handler.go",
			src: "package api\n" + importPerms + `
func serveFileAuthorize(bits, other int64) bool {
	return permissions.HasAdmin(bits) || permissions.HasAdmin(other)
}
`,
			want: 1,
		},
		{
			name: "a different helper inside a listed symbol is flagged",
			path: "api/upload_handler.go",
			src: "package api\n" + importPerms + `
func serveFileAuthorize(bits int64) bool { return permissions.HasPerm(bits, 1) }
`,
			want: 1,
		},
		{
			// Fewer calls than the row binds is the liveness test's direction,
			// not the rule's: the rule never flags a shrinking residue.
			name: "fewer calls than the row binds is not the rule's business",
			path: "service/mentions.go",
			src: "package service\n" + importPerms + `
type MessageService struct{}
func (s *MessageService) mentionReaders(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 0,
		},
		{
			name: "the multi-call row is satisfied only by its exact multiset",
			path: "service/mentions.go",
			src: "package service\n" + importPerms + `
type MessageService struct{}
func (s *MessageService) mentionReaders(bits, a, d int64) bool {
	_ = permissions.EffectivePerms(bits, a, d)
	return permissions.HasAdmin(bits) || permissions.HasAdmin(a)
}
`,
			want: 0,
		},
		{
			name: "a dot-import inside a listed symbol is still flagged",
			path: "api/upload_handler.go",
			src: `package api
import . "github.com/J3vb/OwnCord/Server/permissions"
func serveFileAuthorize(bits int64) bool { return HasAdmin(bits) }
`,
			want: 1,
		},
		{
			name: "a row is keyed by symbol, not by file: the same symbol in another file of the package is allowed",
			path: "api/moved_somewhere_else.go",
			src: "package api\n" + importPerms + `
func serveFileAuthorize(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 0,
		},
		{
			name: "a row does not cover a different symbol in the same file",
			path: "api/upload_handler.go",
			src: "package api\n" + importPerms + `
func someOtherHelper(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 1,
		},
		{
			name: "a row does not cover the same function name on a different receiver",
			path: "ws/serve_ready.go",
			src: `package ws
` + importPerms + `
type Client struct{}
func (c *Client) readyVisibleChannels(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 1,
		},
		{
			name: "a row does not carry across packages",
			path: "plugin/brand_new.go",
			src: "package plugin\n" + importPerms + `
func serveFileAuthorize(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 1,
		},
		{
			// Not an exemption: a file in package permissions cannot import
			// itself, so it binds no "permissions" identifier and the bare
			// call matches nothing.
			name: "a file inside permissions binds no name and is not flagged",
			path: "permissions/checker.go",
			src: `package permissions
func f(bits int64) bool { return HasAdmin(bits) }
`,
			want: 0,
		},
		{
			// A directory-keyed exemption for permissions/ would silently let
			// this through, which is why the rule has none. Re-adding one must
			// fail here.
			name: "a permissions subpackage does import permissions and is checked like any other",
			path: "permissions/policy/x.go",
			src: "package policy\n" + importPerms + `
func decide(bits int64) bool { return permissions.HasAdmin(bits) }
`,
			want: 1,
		},
		{
			name: "a call at package scope has no enclosing symbol and is flagged",
			path: "api/brand_new_handler.go",
			src: "package api\n" + importPerms + `
var adminOnly = permissions.HasAdmin(0)
`,
			want: 1,
		},
		{
			name: "a same-named helper on another package is not a permission check",
			path: "api/brand_new_handler.go",
			src: `package api
import "github.com/J3vb/OwnCord/Server/plugin"
func brandNew(bits int64) bool { return plugin.HasAdmin(bits) }
`,
			want: 0,
		},
		{
			name: "permissions.Name is not a check",
			path: "api/brand_new_handler.go",
			src: "package api\n" + importPerms + `
func brandNew(bit int64) string { return permissions.Name(bit) }
`,
			want: 0,
		},
		{
			name: "allow comment with a reason suppresses",
			path: "api/brand_new_handler.go",
			src: "package api\n" + importPerms + `
func brandNew(bits int64) bool {
	return permissions.HasAdmin(bits) //invariant:allow authz-chokepoint — synthetic fixture
}
`,
			want: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkSourceWith([]Rule{authzChokepoint}, token.NewFileSet(), tt.path, []byte(tt.src))
			if len(got) != tt.want {
				t.Fatalf("want %d violation(s), got %d: %v", tt.want, len(got), got)
			}
			for _, v := range got {
				if v.Rule != authzChokepointID {
					t.Errorf("rule id = %q, want %q", v.Rule, authzChokepointID)
				}
			}
		})
	}
}

func TestAuthzChokepointMessageNamesTheFix(t *testing.T) {
	src := `package api
import "github.com/J3vb/OwnCord/Server/permissions"

type h struct{}

func (x *h) decide(bits int64) bool { return permissions.HasPerm(bits, 1) }
`
	got := checkSourceWith([]Rule{authzChokepoint}, token.NewFileSet(), "api/x.go", []byte(src))
	if len(got) != 1 {
		t.Fatalf("got %d violation(s), want 1: %v", len(got), got)
	}
	v := got[0]
	if v.Line != 6 {
		t.Errorf("Line = %d, want 6", v.Line)
	}
	if !strings.Contains(v.Msg, "permissions.HasPerm") {
		t.Errorf("message must name the helper that was called, got %q", v.Msg)
	}
	if !strings.Contains(v.Msg, "CanSendMessage") {
		t.Errorf("message must name the predicates to use instead, got %q", v.Msg)
	}
	// The symbol is the allowlist key, so the message doubles as the row to
	// paste when a site is genuinely residue.
	if !strings.Contains(v.Msg, "api.(*h).decide") {
		t.Errorf("message must name the symbol an AuthzResidueAllow row would use, got %q", v.Msg)
	}
	// A row is only writable if the caller is told which classes are legal.
	for _, class := range []string{
		classServerScoped, classAdminShortCircuit, classAdminPerimeter,
		classBulkReaderWalk, classBaseBitRejection,
	} {
		if !strings.Contains(v.Msg, class) {
			t.Errorf("message must name the legal class %q, got %q", class, v.Msg)
		}
	}
}

// TestAuthzChokepointMessageFitsAllSixTargets guards the wording: two of the
// six helpers compute a mask rather than deciding, so the message cannot claim
// the call "decides authorization".
func TestAuthzChokepointMessageFitsAllSixTargets(t *testing.T) {
	src := `package api
import "github.com/J3vb/OwnCord/Server/permissions"

func compute(bits, a, d int64) int64 { return permissions.EffectivePerms(bits, a, d) }
`
	got := checkSourceWith([]Rule{authzChokepoint}, token.NewFileSet(), "api/x.go", []byte(src))
	if len(got) != 1 {
		t.Fatalf("got %d violation(s), want 1: %v", len(got), got)
	}
	if strings.Contains(got[0].Msg, "decides authorization") {
		t.Errorf("EffectivePerms computes a mask, it does not decide: %q", got[0].Msg)
	}
	if !strings.Contains(got[0].Msg, "resolves permission bits") {
		t.Errorf("message must describe all six targets accurately, got %q", got[0].Msg)
	}
}

// TestAuthzChokepointExcessMessageNamesHelperAndCount pins what a maintainer
// needs to act on an over-count: which helper, how many the row binds, and how
// many are actually there.
func TestAuthzChokepointExcessMessageNamesHelperAndCount(t *testing.T) {
	src := `package api
import "github.com/J3vb/OwnCord/Server/permissions"

func serveFileAuthorize(bits, other int64) bool {
	return permissions.HasAdmin(bits) || permissions.HasAdmin(other)
}
`
	got := checkSourceWith([]Rule{authzChokepoint}, token.NewFileSet(), "api/upload_handler.go", []byte(src))
	if len(got) != 1 {
		t.Fatalf("got %d violation(s), want 1: %v", len(got), got)
	}
	v := got[0]
	// The second call, not the first: the row's one bound call is spent.
	if v.Line != 5 {
		t.Errorf("Line = %d, want 5 (the extra call, not the bound one)", v.Line)
	}
	for _, want := range []string{
		"HasAdmin",                    // which helper
		"binds 1 call(s) of HasAdmin", // how many the row allows
		"found 2",                     // how many are there
		"api.serveFileAuthorize",      // where
		"it never widens them",        // and that raising it is a review, not an edit
	} {
		if !strings.Contains(v.Msg, want) {
			t.Errorf("message must contain %q, got %q", want, v.Msg)
		}
	}
}

// TestAuthzResidueAllowIsLive keeps the residue honest in the other direction:
// every allowlisted symbol must still exist and still call a raw bit helper.
// A row for a site that moved behind a predicate is stale and must be deleted
// — the list only shrinks. TestServerInvariants covers the opposite direction
// (no unlisted raw check anywhere in the tree), so together they pin the
// residue to exactly this set of symbols.
func TestAuthzResidueAllowIsLive(t *testing.T) {
	live := make(map[string]calls)
	collect := Rule{
		ID: authzChokepointID,
		Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
			for _, h := range authzHits(f, fset, rel) {
				if live[h.Symbol] == nil {
					live[h.Symbol] = make(calls)
				}
				live[h.Symbol][h.Helper]++
			}
			return nil
		},
	}
	if _, err := runWith([]Rule{collect}, ".."); err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	if len(live) == 0 {
		t.Fatal("no raw permission check found anywhere in the tree; the scan is vacuous")
	}

	for sym, entry := range AuthzResidueAllow {
		switch {
		case live[sym] == nil:
			t.Errorf("AuthzResidueAllow[%q] no longer performs a raw permission check — delete the row", sym)
		case !maps.Equal(entry.Calls, live[sym]):
			// Exact, not "at least one": a row that over-counts would leave
			// headroom for a raw call nobody reviewed, and one that under-counts
			// is caught by the rule instead.
			t.Errorf("AuthzResidueAllow[%q] binds %v but the tree has %v — "+
				"correct the row under review, or delete it if the calls have moved behind a predicate",
				sym, entry.Calls, live[sym])
		}
		if len(entry.Calls) == 0 {
			t.Errorf("AuthzResidueAllow[%q]: a row must bind the calls it allows, otherwise it exempts the whole symbol", sym)
		}
		if fileScopeRow(sym) {
			t.Errorf("AuthzResidueAllow[%q] would exempt every package-scope raw call and dot-import "+
				"in that directory at once; move the call into a named function and key the row on it", sym)
		}
		if !authzResidueClasses[entry.Class] {
			t.Errorf("AuthzResidueAllow[%q]: unknown class %q", sym, entry.Class)
		}
		if entry.Note == "" {
			t.Errorf("AuthzResidueAllow[%q]: the reason is mandatory", sym)
		}
	}

	// The message can only tell a caller which classes are legal if it names
	// every one of them.
	for class := range authzResidueClasses {
		if !strings.Contains(authzClassList, class) {
			t.Errorf("class %q is missing from authzClassList, so the violation message never names it", class)
		}
	}
}

// fileScopeRow reports whether an allowlist key names a whole directory's file
// scope rather than one function. Such a row is never residue: it would match
// every package-scope raw call and every dot-import in that directory at once.
func fileScopeRow(sym string) bool { return strings.HasSuffix(sym, "."+fileScopeSymbol) }

func TestFileScopeRowsAreRejected(t *testing.T) {
	for sym, want := range map[string]bool{
		"api.<file-scope>":                         true,
		".<file-scope>":                            true, // a root-level file
		"api.serveFileAuthorize":                   false,
		"ws.(*Hub).readyVisibleChannels":           false,
		"service.(*MessageService).mentionReaders": false,
	} {
		if got := fileScopeRow(sym); got != want {
			t.Errorf("fileScopeRow(%q) = %v, want %v", sym, got, want)
		}
	}
}
