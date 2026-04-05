package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ─── FindClientAssets ───────────────────────────────────────────────────────

func TestFindClientAssets_NilCache(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")

	ca := u.FindClientAssets()
	if ca.InstallerURL != "" || ca.SignatureURL != "" {
		t.Error("expected empty ClientAssets when no cache")
	}
}

func TestFindClientAssets_WithMatchingAssets(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.mu.Lock()
	u.cache = &UpdateInfo{
		Assets: []Asset{
			{Name: "OwnCord_1.0.0_x64-setup.nsis.zip", DownloadURL: "https://example.com/installer.zip"},
			{Name: "OwnCord_1.0.0_x64-setup.nsis.zip.sig", DownloadURL: "https://example.com/installer.zip.sig"},
			{Name: "chatserver.exe", DownloadURL: "https://example.com/chatserver.exe"},
		},
	}
	u.mu.Unlock()

	ca := u.FindClientAssets()
	if ca.InstallerURL != "https://example.com/installer.zip" {
		t.Errorf("InstallerURL = %q, want installer URL", ca.InstallerURL)
	}
	if ca.SignatureURL != "https://example.com/installer.zip.sig" {
		t.Errorf("SignatureURL = %q, want signature URL", ca.SignatureURL)
	}
}

func TestFindClientAssets_NoMatchingAssets(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.mu.Lock()
	u.cache = &UpdateInfo{
		Assets: []Asset{
			{Name: "chatserver.exe", DownloadURL: "https://example.com/chatserver.exe"},
			{Name: "checksums.sha256", DownloadURL: "https://example.com/checksums.sha256"},
		},
	}
	u.mu.Unlock()

	ca := u.FindClientAssets()
	if ca.InstallerURL != "" || ca.SignatureURL != "" {
		t.Error("expected empty ClientAssets when no NSIS assets")
	}
}

// ─── FetchTextAsset ─────────────────────────────────────────────────────────

func TestFetchTextAsset_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("dW50cnVzdGVkIGNvbW1lbnQ="))
	}))
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	text, err := u.FetchTextAsset(context.Background(), srv.URL+"/sig.txt")
	if err != nil {
		t.Fatalf("FetchTextAsset: %v", err)
	}
	if text != "dW50cnVzdGVkIGNvbW1lbnQ=" {
		t.Errorf("text = %q, want 'dW50cnVzdGVkIGNvbW1lbnQ='", text)
	}
}

func TestFetchTextAsset_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	_, err := u.FetchTextAsset(context.Background(), srv.URL+"/missing.sig")
	if err == nil {
		t.Error("expected error for 404 response")
	}
}

// ─── shouldSendToken ────────────────────────────────────────────────────────

func TestShouldSendToken_GitHubHost(t *testing.T) {
	u := NewUpdater("1.0.0", "tok", "J3vb", "OwnCord")

	tests := []struct {
		url  string
		want bool
	}{
		{"https://api.github.com/repos/foo/bar", true},
		{"https://github.com/releases/download/v1", true},
		{"https://objects.githubusercontent.com/asset", true},
		{"https://evil.com/malicious", false},
		{"https://notgithub.example.com/foo", false},
	}
	for _, tc := range tests {
		got := u.shouldSendToken(tc.url)
		if got != tc.want {
			t.Errorf("shouldSendToken(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestShouldSendToken_CustomBaseURL(t *testing.T) {
	u := NewUpdater("1.0.0", "tok", "J3vb", "OwnCord")
	u.baseURL = "http://localhost:9090"

	if !u.shouldSendToken("http://localhost:9090/repos/foo/bar") {
		t.Error("expected true for URL matching baseURL")
	}
	if u.shouldSendToken("http://localhost:8080/different") {
		t.Error("expected false for URL not matching baseURL")
	}
}

// ─── isGitHubHost ───────────────────────────────────────────────────────────

func TestIsGitHubHost(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{"https://api.github.com/repos", true},
		{"https://github.com/J3vb/OwnCord", true},
		{"https://objects.githubusercontent.com/asset", true},
		{"https://raw.githubusercontent.com/file", true},
		{"https://evil.com", false},
		{"not a valid url \x00", false},
		{"https://fakegithub.com", false},
	}
	for _, tc := range tests {
		got := isGitHubHost(tc.url)
		if got != tc.want {
			t.Errorf("isGitHubHost(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

// ─── ensureVPrefix ──────────────────────────────────────────────────────────

func TestEnsureVPrefix(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"1.0.0", "v1.0.0"},
		{"v1.0.0", "v1.0.0"},
		{"0.0.1", "v0.0.1"},
		{"v0.0.1", "v0.0.1"},
	}
	for _, tc := range tests {
		got := ensureVPrefix(tc.input)
		if got != tc.want {
			t.Errorf("ensureVPrefix(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// ─── CheckForUpdate error caching ───────────────────────────────────────────

func TestCheckForUpdate_ErrorCaching(t *testing.T) {
	var hitCount int
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hitCount++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = fmt.Fprint(w, `{"message":"error"}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")

	// First call should error and cache.
	_, err := u.CheckForUpdate(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}

	// Second call should use cached error.
	_, err = u.CheckForUpdate(context.Background())
	if err == nil {
		t.Fatal("expected cached error")
	}

	if hitCount != 1 {
		t.Errorf("expected 1 API hit (error cached), got %d", hitCount)
	}
}

// ─── CheckForUpdate with assets list ────────────────────────────────────────

func TestCheckForUpdate_IncludesAssetsList(t *testing.T) {
	release := ghRelease{
		TagName: "v2.0.0",
		Body:    "notes",
		HTMLURL: "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
		Assets: []ghAsset{
			{Name: "chatserver.exe", BrowserDownloadURL: "https://example.com/chatserver.exe"},
			{Name: "checksums.sha256", BrowserDownloadURL: "https://example.com/checksums.sha256"},
			{Name: "OwnCord_2.0.0_x64-setup.nsis.zip", BrowserDownloadURL: "https://example.com/installer.zip"},
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(release)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	info, err := u.CheckForUpdate(context.Background())
	if err != nil {
		t.Fatalf("CheckForUpdate: %v", err)
	}
	if len(info.Assets) != 3 {
		t.Errorf("expected 3 assets, got %d", len(info.Assets))
	}
}

// ─── downloadFile with auth token ───────────────────────────────────────────

func TestDownloadFile_SendsTokenToGitHub(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data"))
	}))
	defer srv.Close()

	u := NewUpdater("1.0.0", "my-secret-token", "J3vb", "OwnCord")
	u.baseURL = srv.URL

	dest := t.TempDir() + "/download.bin"
	err := u.downloadFile(context.Background(), srv.URL+"/file", dest)
	if err != nil {
		t.Fatalf("downloadFile: %v", err)
	}
	if gotAuth != "token my-secret-token" {
		t.Errorf("Authorization = %q, want 'token my-secret-token'", gotAuth)
	}
}

func TestDownloadFile_NoTokenToExternalHost(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data"))
	}))
	defer srv.Close()

	u := NewUpdater("1.0.0", "my-secret-token", "J3vb", "OwnCord")
	// baseURL is NOT set to srv.URL, so shouldSendToken returns false.

	dest := t.TempDir() + "/download2.bin"
	err := u.downloadFile(context.Background(), srv.URL+"/file", dest)
	if err != nil {
		t.Fatalf("downloadFile: %v", err)
	}
	if gotAuth != "" {
		t.Errorf("expected no Authorization header for external host, got %q", gotAuth)
	}
}

// ─── ParseChecksumFile edge cases ───────────────────────────────────────────

func TestParseChecksumFile_SingleSpace(t *testing.T) {
	// Some tools output single-space instead of double-space.
	data := []byte("abc123 chatserver.exe\n")
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	hash, err := u.ParseChecksumFile(data, "chatserver.exe")
	if err != nil {
		t.Fatalf("ParseChecksumFile single space: %v", err)
	}
	if hash != "abc123" {
		t.Errorf("hash = %q, want 'abc123'", hash)
	}
}

func TestParseChecksumFile_EmptyLines(t *testing.T) {
	data := []byte("\n\nabc123  chatserver.exe\n\n")
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	hash, err := u.ParseChecksumFile(data, "chatserver.exe")
	if err != nil {
		t.Fatalf("ParseChecksumFile with empty lines: %v", err)
	}
	if hash != "abc123" {
		t.Errorf("hash = %q, want 'abc123'", hash)
	}
}

func TestParseChecksumFile_EmptyData(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	_, err := u.ParseChecksumFile([]byte(""), "chatserver.exe")
	if err == nil {
		t.Error("expected error for empty checksum data")
	}
}

// ─── VerifyChecksum file not found ──────────────────────────────────────────

func TestVerifyChecksum_FileNotFound(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	err := u.VerifyChecksum("/nonexistent/path/to/file.exe", "abc123")
	if err == nil {
		t.Error("expected error for non-existent file")
	}
}
