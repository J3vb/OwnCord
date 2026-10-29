package api

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestPluginsHandler_ErrorsUseTheJSONEnvelope pins MX-7 part 3: every error the
// plugin admin API answers is the standard {"error","message"} JSON envelope
// with an application/json content type, so the admin panel reads one shape on
// every route.
func TestPluginsHandler_ErrorsUseTheJSONEnvelope(t *testing.T) {
	disabled := NewPluginAdminHandler(nil, nil, nil)
	reg, store := newTestPluginRegistryWithStore(t)
	live := NewPluginAdminHandler(reg, store, nil)

	upload := func(build func(mw *multipart.Writer)) (io.Reader, string) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		build(mw)
		_ = mw.Close()
		return &buf, mw.FormDataContentType()
	}
	zipBody, zipType := buildZipUpload(t, validPluginZip(t))
	noPartBody, noPartType := upload(func(mw *multipart.Writer) { _ = mw.WriteField("other", "x") })
	badMagicBody, badMagicType := buildZipUpload(t, []byte("not a zip"))
	textBody, textType := upload(func(mw *multipart.Writer) {
		part, err := mw.CreatePart(map[string][]string{
			"Content-Disposition": {`form-data; name="plugin"; filename="evil.txt"`},
			"Content-Type":        {"text/plain"},
		})
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(validPluginZip(t))
	})

	cases := []struct {
		name        string
		handler     http.Handler
		method      string
		path        string
		body        io.Reader
		contentType string
		status      int
		code        string
	}{
		{"install, runtime off", disabled, "POST", "/install", zipBody, zipType, http.StatusServiceUnavailable, "PLUGINS_DISABLED"},
		{"enable, runtime off", disabled, "POST", "/1/enable", nil, "", http.StatusServiceUnavailable, "PLUGINS_DISABLED"},
		{"disable, runtime off", disabled, "POST", "/1/disable", nil, "", http.StatusServiceUnavailable, "PLUGINS_DISABLED"},
		{"uninstall, runtime off", disabled, "DELETE", "/1", nil, "", http.StatusServiceUnavailable, "PLUGINS_DISABLED"},
		{"install, not multipart", live, "POST", "/install", strings.NewReader("{}"), "application/json", http.StatusBadRequest, "INVALID_INPUT"},
		{"install, no plugin part", live, "POST", "/install", noPartBody, noPartType, http.StatusBadRequest, "INVALID_INPUT"},
		{"install, not a zip type", live, "POST", "/install", textBody, textType, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE"},
		{"install, not zip bytes", live, "POST", "/install", badMagicBody, badMagicType, http.StatusBadRequest, "INVALID_INPUT"},
		{"enable, bad id", live, "POST", "/0/enable", nil, "", http.StatusBadRequest, "BAD_REQUEST"},
		{"uninstall, unknown id", live, "DELETE", "/999", nil, "", http.StatusNotFound, "NOT_FOUND"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, tc.body)
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			rec := httptest.NewRecorder()
			tc.handler.ServeHTTP(rec, req)
			assertErrorEnvelope(t, rec, tc.status, tc.code)
		})
	}
}

// TestPluginsHandler_UploadPastTheCapMidParseIs413 covers a body that trips the
// request cap while multipart parsing is still reading it: that is an
// over-size upload, not a malformed one.
func TestPluginsHandler_UploadPastTheCapMidParseIs413(t *testing.T) {
	h := NewPluginAdminHandler(newTestPluginRegistry(t), nil, nil)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("plugin", "big.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(bytes.Repeat([]byte{'x'}, maxPluginUploadBytes+64*1024)); err != nil {
		t.Fatal(err)
	}
	_ = mw.Close()

	req := httptest.NewRequest("POST", "/install", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertErrorEnvelope(t, rec, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE")
}

// TestPluginsHandler_ListStoreFailureIsJSON500 covers the list route's one
// error: a store that cannot be read.
func TestPluginsHandler_ListStoreFailureIsJSON500(t *testing.T) {
	reg, store := newTestPluginRegistryWithStore(t)
	h := NewPluginAdminHandler(reg, store, nil)
	_ = store.Close()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	assertErrorEnvelope(t, rec, http.StatusInternalServerError, "INTERNAL_ERROR")
}

func assertErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var env errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("body is not the JSON envelope: %v; body=%s", err, rec.Body.String())
	}
	if env.Error != code || env.Message == "" {
		t.Errorf("envelope = %+v, want code %s with a message", env, code)
	}
}
