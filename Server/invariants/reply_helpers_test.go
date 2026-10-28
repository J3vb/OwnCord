package invariants

import (
	"go/token"
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

func TestReplyHelpers_AdminDecoderOutsideTheHelperIsFlagged(t *testing.T) {
	src := "package admin\nimport \"encoding/json\"\nfunc h() { json.NewDecoder(r.Body).Decode(&v) }\n"
	if got := replyHelperViolations(t, "admin/handlers_users.go", src); len(got) != 1 {
		t.Fatalf("violations = %v, want one: admin has no decoder allowance left", got)
	}
	helper := "package admin\nimport \"encoding/json\"\nfunc decodeStrictJSON() { json.NewDecoder(r.Body) }\n"
	if got := replyHelperViolations(t, "admin/decode.go", helper); len(got) != 0 {
		t.Errorf("admin decodeStrictJSON: %v, want none", got)
	}
}

func TestReplyHelpers_PlainTextErrorIsFlagged(t *testing.T) {
	for _, rel := range []string{"api/plugins_handler.go", "admin/logstream.go"} {
		src := "package x\nimport h \"net/http\"\nfunc f() { h.Error(w, \"nope\", h.StatusBadRequest) }\n"
		if got := replyHelperViolations(t, rel, src); len(got) != 1 {
			t.Errorf("%s: violations = %v, want one under an import alias", rel, got)
		}
	}
	dot := "package api\nimport . \"net/http\"\nfunc f() { Error(w, \"nope\", 400) }\n"
	if got := replyHelperViolations(t, "api/x.go", dot); len(got) != 1 {
		t.Errorf("dot-import: violations = %v, want one", got)
	}
	// Outside api and admin (asset server, LiveKit webhook, WebSocket upgrade)
	// plain text is the reply.
	src := "package ws\nimport \"net/http\"\nfunc f() { http.Error(w, \"full\", 503) }\n"
	if got := replyHelperViolations(t, "ws/serve.go", src); len(got) != 0 {
		t.Errorf("ws: violations = %v, want none", got)
	}
	// A local value named Error is not net/http's.
	other := "package api\nfunc f() { errs.Error(w) }\n"
	if got := replyHelperViolations(t, "api/x.go", other); len(got) != 0 {
		t.Errorf("non-http Error: violations = %v, want none", got)
	}
}

const pathIDHead = "package admin\nimport (\n\t\"strconv\"\n\t\"github.com/go-chi/chi/v5\"\n)\n"

func TestReplyHelpers_RawPathIDParseIsFlagged(t *testing.T) {
	for name, body := range map[string]string{
		"direct ParseInt":  "func h() { strconv.ParseInt(chi.URLParam(r, \"id\"), 10, 64) }\n",
		"direct ParseUint": "func h() { strconv.ParseUint(chi.URLParam(r, \"id\"), 10, 64) }\n",
		"direct Atoi":      "func h() { strconv.Atoi(chi.URLParam(r, \"id\")) }\n",
		"via a variable":   "func h() { raw := chi.URLParam(r, \"id\"); strconv.ParseInt(raw, 10, 64) }\n",
		"via var decl":     "func h() { var raw = chi.URLParam(r, \"id\"); strconv.Atoi(raw) }\n",
		"inside a closure": "func h() { f := func() { raw := chi.URLParam(r, \"id\"); strconv.Atoi(raw) }; f() }\n",
	} {
		for _, rel := range []string{"admin/handlers_roles.go", "api/sticker_handler.go"} {
			if got := replyHelperViolations(t, rel, pathIDHead+body); len(got) != 1 {
				t.Errorf("%s in %s: %v, want one violation", name, rel, got)
			}
		}
	}
}

func TestReplyHelpers_PathIDHelpersAndQueryParsesAreClean(t *testing.T) {
	helper := pathIDHead + "func pathInt64() { strconv.ParseInt(chi.URLParam(r, \"id\"), 10, 64) }\n"
	if got := replyHelperViolations(t, "admin/helpers.go", helper); len(got) != 0 {
		t.Errorf("pathInt64: %v, want none", got)
	}
	apiHelper := pathIDHead + "func pathID() { strconv.ParseInt(chi.URLParam(r, \"id\"), 10, 64) }\n"
	if got := replyHelperViolations(t, "api/path_id.go", apiHelper); len(got) != 0 {
		t.Errorf("pathID: %v, want none", got)
	}
	// The same name in another file is not the helper.
	if got := replyHelperViolations(t, "admin/other.go", helper); len(got) != 1 {
		t.Errorf("pathInt64 in another file: %v, want one violation", got)
	}
	// A query value, or a parse of a variable that never held a URL param.
	other := pathIDHead + "func h() { raw := r.URL.Query().Get(\"n\"); strconv.Atoi(raw); strconv.Atoi(\"7\") }\n" +
		"func g() { raw := chi.URLParam(r, \"id\"); _ = raw }\nfunc k(raw string) { strconv.Atoi(raw) }\n"
	if got := replyHelperViolations(t, "api/some_handler.go", other); len(got) != 0 {
		t.Errorf("non-URL-param parses: %v, want none", got)
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
