package invariants

import (
	"go/token"
	"os"
	"path/filepath"
	"testing"
)

func requestPathViolations(t *testing.T, rel, src string) []Violation {
	t.Helper()
	return checkSourceWith([]Rule{requestPathGo}, token.NewFileSet(), rel, []byte(src))
}

func TestRequestPathGo_BareGoInHandlerFileIsFlagged(t *testing.T) {
	src := "package api\nfunc h() { go func() {}() }\n"
	got := requestPathViolations(t, "api/some_handler.go", src)
	if len(got) != 1 || got[0].Rule != requestPathGoID {
		t.Fatalf("violations = %v, want exactly one %s", got, requestPathGoID)
	}
}

func TestRequestPathGo_OutsideScopeIsNotChecked(t *testing.T) {
	src := "package db\nfunc h() { go func() {}() }\n"
	if got := requestPathViolations(t, "db/x.go", src); len(got) != 0 {
		t.Fatalf("violations = %v, want none outside api/admin/service/ws", got)
	}
}

func TestRequestPathGo_AllowlistCounts(t *testing.T) {
	const listed = "api/router.go" // GoAllow count 1
	none := "package api\nfunc a() {}\n"
	one := "package api\nfunc a() { go func() {}() }\n"
	two := one + "func b() { go func() {}() }\n"
	if got := requestPathViolations(t, listed, one); len(got) != 0 {
		t.Errorf("listed file at its count: %v, want none", got)
	}
	if got := requestPathViolations(t, listed, two); len(got) != 1 {
		t.Errorf("listed file one over its count: %v, want one violation", got)
	}
	got := requestPathViolations(t, listed, none)
	if len(got) != 1 {
		t.Fatalf("listed file under its count: %v, want one stale violation", got)
	}
}

func TestRequestPathGo_AllowCommentSuppressesOneStatement(t *testing.T) {
	src := "package api\nfunc h() { go func() {}() } //invariant:allow request-path-go — probe\n"
	if got := requestPathViolations(t, "api/some_handler.go", src); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// Every inventory row still names a file that exists; the stale-count half is
// the rule itself.
func TestRequestPathGo_StaleEntriesFail(t *testing.T) {
	root := serverRoot(t)
	for rel := range GoAllow {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Errorf("GoAllow lists %s, which does not exist: %v", rel, err)
		}
	}
}

func TestRequestPathGo_RealTreeIsClean(t *testing.T) {
	violations, err := runWith([]Rule{requestPathGo}, serverRoot(t))
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range violations {
		t.Errorf("%s", v)
	}
}
