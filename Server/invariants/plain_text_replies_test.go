package invariants

import (
	"go/token"
	"testing"
)

func plainTextViolations(t *testing.T, rel, src string) []Violation {
	t.Helper()
	return checkSourceWith([]Rule{plainTextReplies}, token.NewFileSet(), rel, []byte(src))
}

func TestPlainTextReplies_HTTPErrorIsFlaggedEverywhere(t *testing.T) {
	for _, rel := range []string{"api/plugins_handler.go", "admin/logstream.go", "ws/serve.go", "plugin/host_ui.go"} {
		src := "package x\nimport h \"net/http\"\nfunc f() { h.Error(w, \"nope\", h.StatusBadRequest) }\n"
		if got := plainTextViolations(t, rel, src); len(got) != 1 || got[0].Rule != plainTextRepliesID {
			t.Errorf("%s: violations = %v, want one under an import alias", rel, got)
		}
	}
}

func TestPlainTextReplies_DotImportIsFlagged(t *testing.T) {
	src := "package api\nimport . \"net/http\"\nfunc f() { Error(w, \"nope\", 400) }\n"
	if got := plainTextViolations(t, "api/x.go", src); len(got) != 1 {
		t.Errorf("violations = %v, want one", got)
	}
}

func TestPlainTextReplies_OtherErrorCallsAreClean(t *testing.T) {
	src := "package api\nimport \"net/http\"\nfunc f() { errs.Error(w); http.NotFound(w, r); _ = err.Error() }\n"
	if got := plainTextViolations(t, "api/x.go", src); len(got) != 0 {
		t.Errorf("violations = %v, want none", got)
	}
	noImport := "package api\nfunc f() { http.Error(w, \"x\", 400) }\n"
	if got := plainTextViolations(t, "api/y.go", noImport); len(got) != 0 {
		t.Errorf("no net/http import: violations = %v, want none", got)
	}
}

func TestPlainTextReplies_RealTreeIsClean(t *testing.T) {
	violations, err := runWith([]Rule{plainTextReplies}, serverRoot(t))
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range violations {
		t.Errorf("%s", v)
	}
}
