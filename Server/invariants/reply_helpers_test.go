package invariants

import (
	"go/token"
	"os"
	"path/filepath"
	"testing"
)

func replyHelperViolations(t *testing.T, rel, src string) []Violation {
	t.Helper()
	return checkSourceWith([]Rule{replyHelpers}, token.NewFileSet(), rel, []byte(src))
}

func TestReplyHelpers_ErrorLiteralOutsideWriteErrIsFlagged(t *testing.T) {
	src := "package api\nfunc h() { writeJSON(w, 400, errorResponse{Error: \"X\"}) }\n"
	got := replyHelperViolations(t, "api/some_handler.go", src)
	if len(got) != 1 || got[0].Rule != replyHelpersID {
		t.Fatalf("violations = %v, want exactly one %s", got, replyHelpersID)
	}
}

func TestReplyHelpers_HelpersThemselvesAreClean(t *testing.T) {
	writeErr := "package api\nfunc writeErr() { writeJSON(w, 400, errorResponse{}) }\n"
	if got := replyHelperViolations(t, "api/middleware.go", writeErr); len(got) != 0 {
		t.Errorf("writeErr: %v, want none", got)
	}
	decode := "package api\nimport \"encoding/json\"\nfunc decodeJSON() { json.NewDecoder(r.Body) }\n"
	if got := replyHelperViolations(t, "api/decode.go", decode); len(got) != 0 {
		t.Errorf("decodeJSON: %v, want none", got)
	}
	// The same name in another file is not the helper.
	if got := replyHelperViolations(t, "api/other.go", writeErr); len(got) != 1 {
		t.Errorf("writeErr in another file: %v, want one violation", got)
	}
}

func TestReplyHelpers_DecoderOutsideTheHelperIsFlagged(t *testing.T) {
	src := "package api\nimport j \"encoding/json\"\nfunc h() { j.NewDecoder(r.Body).Decode(&v) }\n"
	if got := replyHelperViolations(t, "api/some_handler.go", src); len(got) != 1 {
		t.Fatalf("violations = %v, want one under an import alias", got)
	}
}

func TestReplyHelpers_OutsideScopeIsNotChecked(t *testing.T) {
	src := "package ws\nimport \"encoding/json\"\nfunc h() { json.NewDecoder(r.Body); _ = errorResponse{} }\n"
	if got := replyHelperViolations(t, "ws/x.go", src); len(got) != 0 {
		t.Fatalf("violations = %v, want none outside api/admin", got)
	}
}

func TestReplyHelpers_DecodeAllowIsARatchet(t *testing.T) {
	const listed = "admin/handlers_users.go" // DecodeAllow count 1
	head := "package admin\nimport \"encoding/json\"\n"
	none := head + "func a() {}\n"
	one := head + "func a() { json.NewDecoder(r.Body) }\n"
	two := one + "func b() { json.NewDecoder(r.Body) }\n"
	if got := replyHelperViolations(t, listed, one); len(got) != 0 {
		t.Errorf("listed file at its count: %v, want none", got)
	}
	if got := replyHelperViolations(t, listed, two); len(got) != 1 {
		t.Errorf("listed file one over its count: %v, want one violation", got)
	}
	if got := replyHelperViolations(t, listed, none); len(got) != 1 {
		t.Errorf("listed file under its count: %v, want one stale violation", got)
	}
}

func TestReplyHelpers_DecodeAllowFilesExist(t *testing.T) {
	root := serverRoot(t)
	for rel := range DecodeAllow {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
			t.Errorf("DecodeAllow lists %s, which does not exist: %v", rel, err)
		}
	}
}

func TestReplyHelpers_RealTreeIsClean(t *testing.T) {
	violations, err := runWith([]Rule{replyHelpers}, serverRoot(t))
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range violations {
		t.Errorf("%s", v)
	}
}
