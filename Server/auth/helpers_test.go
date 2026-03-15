package auth_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// ─── ExtractBearerToken ───────────────────────────────────────────────────────

func TestExtractBearerToken_ValidHeader(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer mytoken123")

	token, ok := auth.ExtractBearerToken(r)

	if !ok {
		t.Fatal("ExtractBearerToken() ok = false, want true")
	}
	if token != "mytoken123" {
		t.Errorf("ExtractBearerToken() token = %q, want %q", token, "mytoken123")
	}
}

func TestExtractBearerToken_MissingHeader(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)

	token, ok := auth.ExtractBearerToken(r)

	if ok {
		t.Error("ExtractBearerToken() ok = true with no Authorization header, want false")
	}
	if token != "" {
		t.Errorf("ExtractBearerToken() token = %q, want empty string", token)
	}
}

func TestExtractBearerToken_EmptyHeaderValue(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "")

	_, ok := auth.ExtractBearerToken(r)

	if ok {
		t.Error("ExtractBearerToken() ok = true for empty header value, want false")
	}
}

func TestExtractBearerToken_WrongScheme(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Basic dXNlcjpwYXNz")

	_, ok := auth.ExtractBearerToken(r)

	if ok {
		t.Error("ExtractBearerToken() ok = true for Basic scheme, want false")
	}
}

func TestExtractBearerToken_BearerCaseInsensitive(t *testing.T) {
	cases := []string{
		"BEARER mytoken",
		"bearer mytoken",
		"Bearer mytoken",
		"bEaReR mytoken",
	}
	for _, authHeader := range cases {
		r, _ := http.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Authorization", authHeader)

		token, ok := auth.ExtractBearerToken(r)

		if !ok {
			t.Errorf("ExtractBearerToken() ok = false for header %q, want true", authHeader)
		}
		if token != "mytoken" {
			t.Errorf("ExtractBearerToken() token = %q for header %q, want %q", token, authHeader, "mytoken")
		}
	}
}

func TestExtractBearerToken_BearerWithNoToken(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer ")

	_, ok := auth.ExtractBearerToken(r)

	if ok {
		t.Error("ExtractBearerToken() ok = true for 'Bearer ' with empty token, want false")
	}
}

func TestExtractBearerToken_OnlySchemeNoSpace(t *testing.T) {
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer")

	_, ok := auth.ExtractBearerToken(r)

	if ok {
		t.Error("ExtractBearerToken() ok = true for 'Bearer' with no space or token, want false")
	}
}

func TestExtractBearerToken_TokenPreservesValue(t *testing.T) {
	// Tokens can contain mixed-case, digits, hyphens, underscores, dots.
	rawToken := "aB3-xY9_zZ0.qQ7"
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+rawToken)

	token, ok := auth.ExtractBearerToken(r)

	if !ok {
		t.Fatal("ExtractBearerToken() ok = false, want true")
	}
	if token != rawToken {
		t.Errorf("ExtractBearerToken() token = %q, want %q", token, rawToken)
	}
}

func TestExtractBearerToken_MultipleSpaces(t *testing.T) {
	// SplitN with n=2 means "Bearer  tok" splits into ["Bearer", " tok"].
	// The second part " tok" is non-empty, so the function must return " tok", true.
	r, _ := http.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer  mytoken")

	token, ok := auth.ExtractBearerToken(r)

	// The contract: returns whatever follows the single separating space.
	// " mytoken" is non-empty, so ok should be true.
	if !ok {
		t.Fatal("ExtractBearerToken() ok = false for double-space header, want true")
	}
	if token != " mytoken" {
		t.Errorf("ExtractBearerToken() token = %q, want %q", token, " mytoken")
	}
}

// ─── IsSessionExpired ─────────────────────────────────────────────────────────

func TestIsSessionExpired_FutureTimeNotExpired(t *testing.T) {
	future := time.Now().UTC().Add(time.Hour)
	expiresAt := future.Format("2006-01-02 15:04:05")

	if auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = true for future time, want false", expiresAt)
	}
}

func TestIsSessionExpired_PastTimeExpired(t *testing.T) {
	past := time.Now().UTC().Add(-time.Hour)
	expiresAt := past.Format("2006-01-02 15:04:05")

	if !auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = false for past time, want true", expiresAt)
	}
}

func TestIsSessionExpired_FutureTimeSQLiteFormat(t *testing.T) {
	future := time.Now().UTC().Add(24 * time.Hour)
	expiresAt := future.Format("2006-01-02 15:04:05")

	if auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = true for future SQLite-format time, want false", expiresAt)
	}
}

func TestIsSessionExpired_PastTimeSQLiteFormat(t *testing.T) {
	past := time.Now().UTC().Add(-24 * time.Hour)
	expiresAt := past.Format("2006-01-02 15:04:05")

	if !auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = false for past SQLite-format time, want true", expiresAt)
	}
}

func TestIsSessionExpired_FutureTimeISO8601Format(t *testing.T) {
	future := time.Now().UTC().Add(time.Hour)
	expiresAt := future.Format("2006-01-02T15:04:05Z")

	if auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = true for future ISO-8601 time, want false", expiresAt)
	}
}

func TestIsSessionExpired_PastTimeISO8601Format(t *testing.T) {
	past := time.Now().UTC().Add(-time.Hour)
	expiresAt := past.Format("2006-01-02T15:04:05Z")

	if !auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = false for past ISO-8601 time, want true", expiresAt)
	}
}

func TestIsSessionExpired_EmptyString(t *testing.T) {
	// Unparseable — must treat as expired for safety.
	if !auth.IsSessionExpired("") {
		t.Error("IsSessionExpired(\"\") = false for empty string, want true (fail-safe)")
	}
}

func TestIsSessionExpired_InvalidFormat(t *testing.T) {
	cases := []string{
		"not-a-date",
		"2025/03/15 12:00:00",
		"15-03-2025",
		"2025-13-45T99:99:99Z", // out-of-range values
	}
	for _, s := range cases {
		if !auth.IsSessionExpired(s) {
			t.Errorf("IsSessionExpired(%q) = false for invalid format, want true (fail-safe)", s)
		}
	}
}

func TestIsSessionExpired_ExactlyNow(t *testing.T) {
	// A timestamp one second in the past must always be expired.
	justPast := time.Now().UTC().Add(-time.Second)
	expiresAt := justPast.Format("2006-01-02 15:04:05")

	if !auth.IsSessionExpired(expiresAt) {
		t.Errorf("IsSessionExpired(%q) = false for just-past time, want true", expiresAt)
	}
}

// ─── IsEffectivelyBanned ──────────────────────────────────────────────────────

// ptr is a helper to get a pointer to a string literal.
func ptr(s string) *string { return &s }

func TestIsEffectivelyBanned_NotBanned(t *testing.T) {
	u := &db.User{Banned: false}
	if auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=false) = true, want false")
	}
}

func TestIsEffectivelyBanned_BannedNilExpiry(t *testing.T) {
	// Banned with no expiry — permanently banned.
	u := &db.User{Banned: true, BanExpires: nil}
	if !auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=true, BanExpires=nil) = false, want true")
	}
}

func TestIsEffectivelyBanned_BannedFutureExpiry(t *testing.T) {
	// Banned with an expiry in the future — still banned.
	future := time.Now().UTC().Add(time.Hour).Format("2006-01-02 15:04:05")
	u := &db.User{Banned: true, BanExpires: ptr(future)}
	if !auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=true, future expiry) = false, want true")
	}
}

func TestIsEffectivelyBanned_BannedPastExpiry(t *testing.T) {
	// Banned but the ban expired in the past — should be treated as NOT banned.
	past := time.Now().UTC().Add(-time.Hour).Format("2006-01-02 15:04:05")
	u := &db.User{Banned: true, BanExpires: ptr(past)}
	if auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=true, past expiry) = true, want false")
	}
}

func TestIsEffectivelyBanned_BannedExpiredISO8601(t *testing.T) {
	// ISO-8601 format for BanExpires past — should be treated as NOT banned.
	past := time.Now().UTC().Add(-time.Minute).Format("2006-01-02T15:04:05Z")
	u := &db.User{Banned: true, BanExpires: ptr(past)}
	if auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=true, ISO-8601 past expiry) = true, want false")
	}
}

func TestIsEffectivelyBanned_BannedFutureISO8601(t *testing.T) {
	// ISO-8601 format for BanExpires in future — still banned.
	future := time.Now().UTC().Add(time.Hour).Format("2006-01-02T15:04:05Z")
	u := &db.User{Banned: true, BanExpires: ptr(future)}
	if !auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=true, ISO-8601 future expiry) = false, want true")
	}
}

func TestIsEffectivelyBanned_BannedUnparsableExpiry(t *testing.T) {
	// Unparseable expiry string — fail-safe: treat as still banned.
	u := &db.User{Banned: true, BanExpires: ptr("not-a-date")}
	if !auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=true, unparseable expiry) = false, want true (fail-safe)")
	}
}

func TestIsEffectivelyBanned_NotBannedIgnoresExpiry(t *testing.T) {
	// Banned=false even with a future expiry field — should be false.
	future := time.Now().UTC().Add(time.Hour).Format("2006-01-02 15:04:05")
	u := &db.User{Banned: false, BanExpires: ptr(future)}
	if auth.IsEffectivelyBanned(u) {
		t.Error("IsEffectivelyBanned(Banned=false, future expiry) = true, want false")
	}
}

func TestIsEffectivelyBanned_NilUser(t *testing.T) {
	// A nil user pointer must not panic and must return false.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("IsEffectivelyBanned(nil) panicked: %v", r)
		}
	}()
	if auth.IsEffectivelyBanned(nil) {
		t.Error("IsEffectivelyBanned(nil) = true, want false")
	}
}
