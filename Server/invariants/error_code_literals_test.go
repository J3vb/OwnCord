package invariants

import (
	"strings"
	"testing"
	"testing/fstest"
)

const fixtureCodes = "package httperr\ntype Code string\nconst (\n\tCodeBadRequest Code = \"BAD_REQUEST\"\n\tCodeForbidden Code = \"FORBIDDEN\"\n)\n"

const fixtureWSCodes = "package ws\nconst MsgTypeChatSend = \"chat_send\"\nconst (\n\tErrCodeForbidden = \"FORBIDDEN\"\n\tErrCodeSlowMode = \"SLOW_MODE\"\n)\n"

func errorCodeTree(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{
		"httperr/codes.go":    {Data: []byte(fixtureCodes)},
		"ws/message_types.go": {Data: []byte(fixtureWSCodes)},
	}
	for name, src := range files {
		fsys[name] = &fstest.MapFile{Data: []byte(src)}
	}
	return fsys
}

func TestErrorCodeLiterals_LiteralCodesAreFlagged(t *testing.T) {
	got := errorCodeLiterals.Tree(errorCodeTree(map[string]string{
		// A writeErr argument, a code variable fed through a helper, and a WS
		// code: each spelling a client branch depends on.
		"api/a.go":   "package api\nfunc f() { writeErr(w, 400, \"BAD_REQUEST\", \"x\") }\n",
		"admin/b.go": "package admin\nfunc g() { code := \"FORBIDDEN\"; writeErr(w, 403, code, \"x\") }\n",
		"ws/c.go":    "package ws\nfunc h() { buildErrorMsg(\"SLOW_MODE\", \"x\") }\n",
	}))
	if len(got) != 3 {
		t.Fatalf("violations = %v, want 3", got)
	}
	if got[0].File != "admin/b.go" || !strings.Contains(got[0].Msg, "httperr.CodeForbidden or ws.ErrCodeForbidden") {
		t.Errorf("shared code message = %q, want both constants named", got[0].Msg)
	}
	if !strings.Contains(got[1].Msg, "httperr.CodeBadRequest") || !strings.Contains(got[2].Msg, "ws.ErrCodeSlowMode") {
		t.Errorf("messages = %q / %q, want the constant to use", got[1].Msg, got[2].Msg)
	}
}

func TestErrorCodeLiterals_ConstantsTestsAndOtherStringsAreClean(t *testing.T) {
	got := errorCodeLiterals.Tree(errorCodeTree(map[string]string{
		"api/a.go":      "package api\nfunc f() { writeErr(w, 400, httperr.CodeBadRequest, \"BAD_REQUEST is not a message\") }\n",
		"api/a_test.go": "package api\nfunc TestF() { want := \"BAD_REQUEST\" }\n",
		"admin/log.go":  "package admin\nvar levels = []string{\"DEBUG\", \"INFO\", \"WARN\"}\n",
		// Outside the scope: report evidence names reuse code-like words.
		"service/e.go": "package service\nconst E = \"FORBIDDEN\"\n",
	}))
	if len(got) != 0 {
		t.Errorf("violations = %v, want none", got)
	}
}

func TestErrorCodeLiterals_MissingGeneratedFilesFail(t *testing.T) {
	got := errorCodeLiterals.Tree(fstest.MapFS{"api/a.go": {Data: []byte("package api\n")}})
	if len(got) != 1 || !strings.Contains(got[0].Msg, "protocol-generate") {
		t.Errorf("violations = %v, want one asking for a regenerate", got)
	}
}

func TestErrorCodeLiterals_RealTreeIsClean(t *testing.T) {
	violations, err := runWith([]Rule{errorCodeLiterals}, serverRoot(t))
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range violations {
		t.Errorf("%s", v)
	}
}
