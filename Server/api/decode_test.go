package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type decodeTarget struct {
	Name string `json:"name"`
}

func runDecode(t *testing.T, decode func(http.ResponseWriter, *http.Request, any) bool, body string, limit int64) (bool, decodeTarget, *httptest.ResponseRecorder) {
	t.Helper()
	rr := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	if limit > 0 {
		r.Body = http.MaxBytesReader(rr, r.Body, limit)
	}
	var v decodeTarget
	ok := decode(rr, r, &v)
	return ok, v, rr
}

func wantReply(t *testing.T, rr *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rr.Code != status {
		t.Fatalf("status = %d, want %d; body %s", rr.Code, status, rr.Body.String())
	}
	var body errorResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v: %s", err, rr.Body.String())
	}
	if body.Error != code {
		t.Fatalf("error = %q, want %q", body.Error, code)
	}
}

func TestDecodeJSON_ValidBody(t *testing.T) {
	ok, v, rr := runDecode(t, decodeJSON, `{"name":"a"}`, 0)
	if !ok || v.Name != "a" || rr.Body.Len() != 0 {
		t.Fatalf("ok=%v v=%+v body=%q, want decoded and nothing written", ok, v, rr.Body.String())
	}
}

func TestDecodeJSON_BadBodiesShareOneReply(t *testing.T) {
	for _, body := range []string{``, `{`, `[1]`, `{"name":3}`, `not json`} {
		ok, _, rr := runDecode(t, decodeJSON, body, 0)
		if ok {
			t.Fatalf("%q: ok, want refused", body)
		}
		wantReply(t, rr, http.StatusBadRequest, "INVALID_INPUT")
	}
}

// The cap trips mid-value: the decoder has read part of the string when the
// reader refuses, and the reply is 413, not the 400 of a malformed body.
func TestDecodeJSON_OverCapIs413(t *testing.T) {
	body := `{"name":"` + strings.Repeat("x", 4096) + `"}`
	for name, decode := range map[string]func(http.ResponseWriter, *http.Request, any) bool{
		"required": decodeJSON, "optional": decodeOptionalJSON, "strict": decodeStrictJSON,
	} {
		ok, _, rr := runDecode(t, decode, body, 1024)
		if ok {
			t.Fatalf("%s: ok, want refused", name)
		}
		wantReply(t, rr, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE")
	}
}

func TestDecodeOptionalJSON_EmptyBodyKeepsTheZeroValue(t *testing.T) {
	ok, v, rr := runDecode(t, decodeOptionalJSON, ``, 0)
	if !ok || v != (decodeTarget{}) || rr.Body.Len() != 0 {
		t.Fatalf("ok=%v v=%+v body=%q, want accepted with nothing written", ok, v, rr.Body.String())
	}
	ok, _, rr = runDecode(t, decodeOptionalJSON, `{`, 0)
	if ok {
		t.Fatal("a truncated body was accepted")
	}
	wantReply(t, rr, http.StatusBadRequest, "INVALID_INPUT")
}

func TestDecodeStrictJSON_RefusesUnknownFieldsAndTrailingData(t *testing.T) {
	for _, body := range []string{`{"name":"a","extra":1}`, `{"name":"a"}{}`, `{"name":"a"} x`} {
		ok, _, rr := runDecode(t, decodeStrictJSON, body, 0)
		if ok {
			t.Fatalf("%q: ok, want refused", body)
		}
		wantReply(t, rr, http.StatusBadRequest, "INVALID_INPUT")
	}
	if ok, v, _ := runDecode(t, decodeStrictJSON, `{"name":"a"}`+"\n", 0); !ok || v.Name != "a" {
		t.Fatalf("ok=%v v=%+v, want a single value with a trailing newline accepted", ok, v)
	}
}

// The cap trips only on the trailing-data read: the first value fits, the
// padding after it does not.
func TestDecodeStrictJSON_OverCapAfterTheValueIs413(t *testing.T) {
	body := `{"name":"a"}` + strings.Repeat(" ", 4096) + `{}`
	ok, _, rr := runDecode(t, decodeStrictJSON, body, 1024)
	if ok {
		t.Fatal("ok, want refused")
	}
	wantReply(t, rr, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE")
}
