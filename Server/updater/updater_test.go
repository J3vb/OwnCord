package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// ghRelease mirrors the GitHub release API response shape.
type ghRelease struct {
	TagName string    `json:"tag_name"`
	Body    string    `json:"body"`
	HTMLURL string    `json:"html_url"`
	Assets  []ghAsset `json:"assets"`
}

// ghAsset mirrors a GitHub release asset.
type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func newTestRelease(tag, body, htmlURL string, assetDownloadBase string) ghRelease {
	return ghRelease{
		TagName: tag,
		Body:    body,
		HTMLURL: htmlURL,
		Assets: []ghAsset{
			{Name: "chatserver.exe", BrowserDownloadURL: assetDownloadBase + "/chatserver.exe"},
			{Name: "checksums.sha256", BrowserDownloadURL: assetDownloadBase + "/checksums.sha256"},
		},
	}
}

func newTestServer(t *testing.T, release ghRelease, statusCode int) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(statusCode)
		if statusCode == http.StatusOK {
			if err := json.NewEncoder(w).Encode(release); err != nil {
				t.Fatalf("encoding release: %v", err)
			}
		} else {
			_, _ = fmt.Fprint(w, `{"message":"Internal Server Error"}`)
		}
	})
	return httptest.NewServer(mux)
}

func newTestUpdater(baseURL, currentVersion string) *Updater {
	u := NewUpdater(currentVersion, "", "J3vb", "OwnCord")
	u.baseURL = baseURL
	return u
}

func TestCheckForUpdate_NewerVersionAvailable(t *testing.T) {
	release := newTestRelease("v1.2.0", "Bug fixes and improvements", "https://github.com/J3vb/OwnCord/releases/tag/v1.2.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.2.0")
	srv := newTestServer(t, release, http.StatusOK)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	info, err := u.CheckForUpdate(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !info.UpdateAvailable {
		t.Error("expected UpdateAvailable=true, got false")
	}
	if info.Latest != "v1.2.0" {
		t.Errorf("expected Latest=v1.2.0, got %s", info.Latest)
	}
	if info.Current != "v1.0.0" {
		t.Errorf("expected Current=v1.0.0, got %s", info.Current)
	}
	if info.DownloadURL == "" {
		t.Error("expected non-empty DownloadURL")
	}
	if info.ChecksumURL == "" {
		t.Error("expected non-empty ChecksumURL")
	}
}

func TestCheckForUpdate_UpToDate(t *testing.T) {
	release := newTestRelease("v1.0.0", "Current release", "https://github.com/J3vb/OwnCord/releases/tag/v1.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0")
	srv := newTestServer(t, release, http.StatusOK)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	info, err := u.CheckForUpdate(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.UpdateAvailable {
		t.Error("expected UpdateAvailable=false, got true")
	}
}

func TestCheckForUpdate_CachesResult(t *testing.T) {
	var hitCount atomic.Int32
	release := newTestRelease("v2.0.0", "Major update", "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v2.0.0")

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hitCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(release); err != nil {
			t.Fatalf("encoding release: %v", err)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	ctx := context.Background()

	_, err := u.CheckForUpdate(ctx)
	if err != nil {
		t.Fatalf("first call error: %v", err)
	}
	_, err = u.CheckForUpdate(ctx)
	if err != nil {
		t.Fatalf("second call error: %v", err)
	}

	if got := hitCount.Load(); got != 1 {
		t.Errorf("expected 1 API hit (cached), got %d", got)
	}
}

func TestCheckForUpdate_CacheExpires(t *testing.T) {
	var hitCount atomic.Int32
	release := newTestRelease("v2.0.0", "Major update", "https://github.com/J3vb/OwnCord/releases/tag/v2.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v2.0.0")

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/J3vb/OwnCord/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hitCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(release); err != nil {
			t.Fatalf("encoding release: %v", err)
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	ctx := context.Background()

	// First call populates cache.
	_, err := u.CheckForUpdate(ctx)
	if err != nil {
		t.Fatalf("first call error: %v", err)
	}

	// Expire the cache manually.
	u.mu.Lock()
	u.cacheExpiry = time.Now().Add(-1 * time.Minute)
	u.mu.Unlock()

	// Second call should hit the API again.
	_, err = u.CheckForUpdate(ctx)
	if err != nil {
		t.Fatalf("second call error: %v", err)
	}

	if got := hitCount.Load(); got != 2 {
		t.Errorf("expected 2 API hits (cache expired), got %d", got)
	}
}

func TestCheckForUpdate_APIError(t *testing.T) {
	release := ghRelease{} // unused since status is 500
	srv := newTestServer(t, release, http.StatusInternalServerError)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	_, err := u.CheckForUpdate(context.Background())
	if err == nil {
		t.Fatal("expected error for 500 response, got nil")
	}
}

func TestValidateDownloadURL_Valid(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	err := u.ValidateDownloadURL("https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe")
	if err != nil {
		t.Errorf("expected valid URL to pass, got error: %v", err)
	}
}

func TestValidateDownloadURL_Invalid(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	err := u.ValidateDownloadURL("https://evil.com/chatserver.exe")
	if err == nil {
		t.Error("expected invalid URL to be rejected, got nil")
	}
}

func TestVerifyChecksum_Correct(t *testing.T) {
	content := []byte("hello world binary content")
	hash := sha256.Sum256(content)
	expectedHash := hex.EncodeToString(hash[:])

	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "chatserver.exe")
	if err := os.WriteFile(filePath, content, 0o644); err != nil {
		t.Fatalf("writing temp file: %v", err)
	}

	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	if err := u.VerifyChecksum(filePath, expectedHash); err != nil {
		t.Errorf("expected correct checksum to pass, got error: %v", err)
	}
}

func TestVerifyChecksum_Incorrect(t *testing.T) {
	content := []byte("hello world binary content")

	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "chatserver.exe")
	if err := os.WriteFile(filePath, content, 0o644); err != nil {
		t.Fatalf("writing temp file: %v", err)
	}

	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	wrongHash := "0000000000000000000000000000000000000000000000000000000000000000"
	if err := u.VerifyChecksum(filePath, wrongHash); err == nil {
		t.Error("expected incorrect checksum to fail, got nil")
	}
}

func TestParseChecksumFile_FindsFile(t *testing.T) {
	data := []byte("abc123  readme.txt\ndef456  chatserver.exe\nghi789  other.dll\n")
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	hash, err := u.ParseChecksumFile(data, "chatserver.exe")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if hash != "def456" {
		t.Errorf("expected hash=def456, got %s", hash)
	}
}

func TestParseChecksumFile_FileNotFound(t *testing.T) {
	data := []byte("abc123  readme.txt\ndef456  chatserver.exe\n")
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	_, err := u.ParseChecksumFile(data, "nonexistent.exe")
	if err == nil {
		t.Error("expected error for missing file in checksum data, got nil")
	}
}

// ─── SetBaseURL ──────────────────────────────────────────────────────────────

func TestSetBaseURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.SetBaseURL("https://custom.api.example.com")
	if u.apiBaseURL() != "https://custom.api.example.com" {
		t.Errorf("apiBaseURL = %q, want custom URL", u.apiBaseURL())
	}
}

func TestApiBaseURL_DefaultWhenEmpty(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	got := u.apiBaseURL()
	if got != defaultBaseURL {
		t.Errorf("apiBaseURL = %q, want default %q", got, defaultBaseURL)
	}
}

// ─── fetchBody ───────────────────────────────────────────────────────────────

func TestFetchBody_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello body"))
	}))
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	body, err := u.fetchBody(context.Background(), srv.URL+"/test")
	if err != nil {
		t.Fatalf("fetchBody: %v", err)
	}
	if string(body) != "hello body" {
		t.Errorf("body = %q, want 'hello body'", body)
	}
}

func TestFetchBody_NonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	_, err := u.fetchBody(context.Background(), srv.URL+"/test")
	if err == nil {
		t.Error("fetchBody should error on non-200 status")
	}
}

func TestFetchBody_WithGithubToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	u := NewUpdater("1.0.0", "my-token", "J3vb", "OwnCord")
	u.baseURL = srv.URL
	_, _ = u.fetchBody(context.Background(), srv.URL+"/test")
	if gotAuth != "token my-token" {
		t.Errorf("Authorization = %q, want 'token my-token'", gotAuth)
	}
}

// ─── downloadFile ────────────────────────────────────────────────────────────

func TestDownloadFile_Success(t *testing.T) {
	content := []byte("binary content here")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(content)
	}))
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "downloaded.exe")

	u := newTestUpdater(srv.URL, "1.0.0")
	if err := u.downloadFile(context.Background(), srv.URL+"/binary", dest); err != nil {
		t.Fatalf("downloadFile: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("reading downloaded file: %v", err)
	}
	if string(got) != string(content) {
		t.Errorf("content = %q, want %q", got, content)
	}
}

func TestDownloadFile_NonOKStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "downloaded.exe")

	u := newTestUpdater(srv.URL, "1.0.0")
	err := u.downloadFile(context.Background(), srv.URL+"/binary", dest)
	if err == nil {
		t.Error("downloadFile should error on non-200 status")
	}
}

// ─── DownloadAndVerify ───────────────────────────────────────────────────────

func TestDownloadAndVerify_Success(t *testing.T) {
	content := []byte("real binary content for verification")
	hash := sha256.Sum256(content)
	checksumHex := hex.EncodeToString(hash[:])

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", checksumHex)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe")

	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.baseURL = srv.URL

	downloadURL := fmt.Sprintf("https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe")
	checksumURL := fmt.Sprintf("https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256")

	// Override HTTP client to route GitHub URLs to our test server.
	u.httpClient = &http.Client{
		Transport: &rewriteTransport{srv.URL},
	}

	err := u.DownloadAndVerify(context.Background(), downloadURL, checksumURL, dest)
	if err != nil {
		t.Fatalf("DownloadAndVerify: %v", err)
	}

	// File should exist and be correct.
	got, _ := os.ReadFile(dest)
	if string(got) != string(content) {
		t.Errorf("downloaded content mismatch")
	}
}

func TestDownloadAndVerify_InvalidDownloadURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	err := u.DownloadAndVerify(context.Background(), "https://evil.com/file", "https://evil.com/sum", "/tmp/out")
	if err == nil {
		t.Error("DownloadAndVerify should reject invalid download URL")
	}
}

func TestDownloadAndVerify_InvalidChecksumURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe"
	err := u.DownloadAndVerify(context.Background(), downloadURL, "https://evil.com/sum", "/tmp/out")
	if err == nil {
		t.Error("DownloadAndVerify should reject invalid checksum URL")
	}
}

func TestDownloadAndVerify_ChecksumMismatch(t *testing.T) {
	content := []byte("binary content")
	wrongChecksum := "0000000000000000000000000000000000000000000000000000000000000000"

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", wrongChecksum)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe")

	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}

	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe"
	checksumURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256"

	err := u.DownloadAndVerify(context.Background(), downloadURL, checksumURL, dest)
	if err == nil {
		t.Error("DownloadAndVerify should fail on checksum mismatch")
	}

	// File should be removed after mismatch.
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after checksum mismatch")
	}
}

// rewriteTransport rewrites GitHub release URLs to a local test server.
type rewriteTransport struct {
	target string
}

func (rt *rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Rewrite github.com URLs to the test server.
	newURL := rt.target + "/download/" + filepath.Base(req.URL.Path)
	newReq, _ := http.NewRequestWithContext(req.Context(), req.Method, newURL, req.Body)
	return http.DefaultTransport.RoundTrip(newReq)
}
