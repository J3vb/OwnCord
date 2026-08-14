package api

import (
	"net/url"
	"strings"
	"testing"
)

// OC-0109: url.Error embeds the upstream request URL, which is built with
// params.Encode() — every character outside [A-Za-z0-9-_.~] is percent
// escaped. redactKey compared only against the literal (decoded) key, so a
// key containing such a character (common in base64-style keys: '+', '/',
// '=') survived into the log line in its encoded form.
func TestRedactKeyMatchesPercentEncodedForm(t *testing.T) {
	apiKey := "ab+cd/ef="
	encoded := url.QueryEscape(apiKey)
	msg := `Get "https://api.klipy.com/v2/featured?key=` + encoded + `&limit=20": dial tcp: lookup api.klipy.com: no such host`

	got := redactKey(msg, apiKey)

	if strings.Contains(got, encoded) {
		t.Fatalf("redactKey left the percent-encoded API key in the message: %q", got)
	}
	if strings.Contains(got, apiKey) {
		t.Fatalf("redactKey left the literal API key in the message: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("redactKey did not redact anything: %q", got)
	}
}
