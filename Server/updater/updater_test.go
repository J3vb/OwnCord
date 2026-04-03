package updater

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aead.dev/minisign"
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
			{Name: "chatserver-linux-amd64.tar.gz", BrowserDownloadURL: assetDownloadBase + "/chatserver-linux-amd64.tar.gz"},
			{Name: "checksums.sha256", BrowserDownloadURL: assetDownloadBase + "/checksums.sha256"},
			{Name: "chatserver.exe.sig", BrowserDownloadURL: assetDownloadBase + "/chatserver.exe.sig"},
			{Name: "server-update-manifest.json", BrowserDownloadURL: assetDownloadBase + "/server-update-manifest.json"},
			{Name: "server-update-manifest.json.sig", BrowserDownloadURL: assetDownloadBase + "/server-update-manifest.json.sig"},
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

func newSignedTestUpdater(t *testing.T, baseURL, currentVersion string) (*Updater, minisign.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	publicKeyText, err := publicKey.MarshalText()
	if err != nil {
		t.Fatalf("MarshalText(public key): %v", err)
	}
	u := newTestUpdater(baseURL, currentVersion)
	u.signingKeyText = base64.StdEncoding.EncodeToString(publicKeyText)
	return u, privateKey
}

func signTestAsset(t *testing.T, privateKey minisign.PrivateKey, content []byte) []byte {
	t.Helper()
	reader := minisign.NewReader(bytes.NewReader(content))
	if _, err := io.Copy(io.Discard, reader); err != nil {
		t.Fatalf("signTestAsset io.Copy: %v", err)
	}
	return reader.SignWithComments(privateKey, "timestamp:1712016000\tfile:chatserver.exe", "untrusted comment: owncord test")
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
	if info.ChecksumURL == "" {
		t.Error("expected non-empty ChecksumURL")
	}
	// Server binary asset is only selected on Windows and Linux.
	if want := serverDownloadAssetName(runtime.GOOS); want != "" {
		if info.DownloadURL == "" {
			t.Error("expected non-empty DownloadURL")
		}
	} else if info.DownloadURL != "" {
		t.Error("expected empty DownloadURL on unsupported GOOS")
	}
	if info.SignatureURL == "" {
		t.Error("expected non-empty SignatureURL")
	}
	if info.ManifestURL == "" {
		t.Error("expected non-empty ManifestURL")
	}
	if info.ManifestSignatureURL == "" {
		t.Error("expected non-empty ManifestSignatureURL")
	}
	if !info.RequiredAssetsPresent {
		t.Error("expected RequiredAssetsPresent=true")
	}
}

func TestCheckForUpdate_MissingRequiredAssetsSuppressesUpdate(t *testing.T) {
	release := ghRelease{
		TagName: "v1.2.0",
		Body:    "Broken release",
		HTMLURL: "https://github.com/J3vb/OwnCord/releases/tag/v1.2.0",
		Assets: []ghAsset{
			{Name: "chatserver.exe", BrowserDownloadURL: "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/chatserver.exe"},
			{Name: "checksums.sha256", BrowserDownloadURL: "https://github.com/J3vb/OwnCord/releases/download/v1.2.0/checksums.sha256"},
		},
	}
	srv := newTestServer(t, release, http.StatusOK)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	info, err := u.CheckForUpdate(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.UpdateAvailable {
		t.Fatal("expected UpdateAvailable=false for incomplete release")
	}
	if info.RequiredAssetsPresent {
		t.Fatal("expected RequiredAssetsPresent=false for incomplete release")
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

// TestUpdateChecksum_SHA256MatchesChecksumsFile checks the full checksum chain
// used during server update: SHA-256 of the downloaded release artifact must
// equal the hex in checksums.sha256 (same layout as CI: "hash  path/to/file"),
// and VerifyChecksum must accept the on-disk file against that expected value.
func TestUpdateChecksum_SHA256MatchesChecksumsFile(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")

	tests := []struct {
		name    string
		goos    string
		assetFn func(*testing.T) []byte
	}{
		{
			name: "windows_exe",
			goos: "windows",
			assetFn: func(*testing.T) []byte {
				return []byte("windows server binary payload for checksum test")
			},
		},
		{
			name: "linux_tar_gz",
			goos: "linux",
			assetFn: func(t *testing.T) []byte {
				return mustBuildChatserverTarGz(t, []byte("linux inner binary for checksum test"))
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			asset := tc.assetFn(t)
			names := checksumEntryNamesForGOOS(tc.goos)
			if len(names) == 0 {
				t.Fatal("checksumEntryNamesForGOOS: empty names")
			}

			sum := sha256.Sum256(asset)
			expectedHex := hex.EncodeToString(sum[:])

			// Same line shape as release workflow: sha256sum prints "<hash>  <path>".
			primaryPath := names[0]
			checksumData := []byte(fmt.Sprintf("%s  %s\n", expectedHex, primaryPath))

			parsed, err := u.parseChecksumFileAny(checksumData, names...)
			if err != nil {
				t.Fatalf("parseChecksumFileAny: %v", err)
			}
			if !strings.EqualFold(parsed, expectedHex) {
				t.Fatalf("parsed hash %q, want %q", parsed, expectedHex)
			}

			tmp := filepath.Join(t.TempDir(), "release-asset")
			if err := os.WriteFile(tmp, asset, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := u.VerifyChecksum(tmp, expectedHex); err != nil {
				t.Fatalf("VerifyChecksum: %v", err)
			}
		})
	}
}

// TestUpdateChecksum_FallbackChecksumLine verifies lookup when checksums.sha256
// lists only the bare filename (second candidate in checksumEntryNamesForGOOS).
func TestUpdateChecksum_FallbackChecksumLine(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	asset := []byte("bare-name-line test")
	sum := sha256.Sum256(asset)
	expectedHex := hex.EncodeToString(sum[:])
	// Only "chatserver.exe", no windows/ prefix — second entry in list must match.
	checksumData := []byte(fmt.Sprintf("%s  chatserver.exe\n", expectedHex))

	names := checksumEntryNamesForGOOS("windows")
	parsed, err := u.parseChecksumFileAny(checksumData, names...)
	if err != nil {
		t.Fatalf("parseChecksumFileAny: %v", err)
	}
	if !strings.EqualFold(parsed, expectedHex) {
		t.Fatalf("parsed %q, want %q", parsed, expectedHex)
	}

	tmp := filepath.Join(t.TempDir(), "chatserver.exe")
	if err := os.WriteFile(tmp, asset, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := u.VerifyChecksum(tmp, expectedHex); err != nil {
		t.Fatalf("VerifyChecksum: %v", err)
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

func TestParseChecksumFileAny_FirstMatch(t *testing.T) {
	data := []byte("aaa  other\nbbb  linux/chatserver-linux-amd64.tar.gz\nccc  chatserver.exe\n")
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	h, err := u.parseChecksumFileAny(data, "linux/chatserver-linux-amd64.tar.gz", "chatserver.exe")
	if err != nil {
		t.Fatalf("parseChecksumFileAny: %v", err)
	}
	if h != "bbb" {
		t.Errorf("hash = %q, want bbb (linux line first in list)", h)
	}
}

func TestServerDownloadAssetName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "chatserver.exe"},
		{"linux", "chatserver-linux-amd64.tar.gz"},
		{"darwin", ""},
		{"freebsd", ""},
	}
	for _, tc := range tests {
		if got := serverDownloadAssetName(tc.goos); got != tc.want {
			t.Errorf("serverDownloadAssetName(%q) = %q, want %q", tc.goos, got, tc.want)
		}
	}
}

func TestExtractChatserverFromTarGz(t *testing.T) {
	inner := []byte("#!/bin/fake\n")
	var gzbuf bytes.Buffer
	gw := gzip.NewWriter(&gzbuf)
	tw := tar.NewWriter(gw)
	hdr := &tar.Header{Name: "chatserver", Mode: 0o755, Size: int64(len(inner)), Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(inner); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver")
	if err := extractChatserverFromTarGz(bytes.NewReader(gzbuf.Bytes()), dest); err != nil {
		t.Fatalf("extractChatserverFromTarGz: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, inner) {
		t.Errorf("extracted content mismatch")
	}
}

func TestAssetFilenameFromURL(t *testing.T) {
	got, err := assetFilenameFromURL("https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe")
	if err != nil {
		t.Fatalf("assetFilenameFromURL: %v", err)
	}
	if got != "chatserver.exe" {
		t.Errorf("assetFilenameFromURL = %q, want chatserver.exe", got)
	}
}

func TestDefaultServerSignaturePublicKey_DiffersFromTauriUpdaterKey(t *testing.T) {
	tauriConfigPath := filepath.Clean(filepath.Join("..", "..", "Client", "tauri-client", "src-tauri", "tauri.conf.json"))
	raw, err := os.ReadFile(tauriConfigPath)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", tauriConfigPath, err)
	}

	var cfg struct {
		Plugins struct {
			Updater struct {
				PubKey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("Unmarshal tauri.conf.json: %v", err)
	}

	if cfg.Plugins.Updater.PubKey == defaultServerSignaturePublicKey {
		t.Fatalf("server updater signing key must differ from tauri.conf.json updater pubkey")
	}
}

func TestDefaultServerSignaturePublicKey_Parseable(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	if _, err := u.serverSignaturePublicKey(); err != nil {
		t.Fatalf("serverSignaturePublicKey: %v", err)
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
	if !bytes.Equal(got, content) {
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
	switch runtime.GOOS {
	case "windows":
		testDownloadAndVerifySuccessWindows(t)
	case "linux":
		testDownloadAndVerifySuccessLinux(t)
	default:
		t.Skip("no DownloadAndVerify integration case for GOOS=" + runtime.GOOS)
	}
}

func testDownloadAndVerifySuccessWindows(t *testing.T) {
	content := []byte("real binary content for verification")
	hash := sha256.Sum256(content)
	checksumHex := hex.EncodeToString(hash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	signature := signTestAsset(t, privateKey, content)
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"` + checksumHex + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", checksumHex)
	})
	mux.HandleFunc("/download/chatserver.exe.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(append(signature, []byte("\r\n")...))
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe.new")

	u.baseURL = srv.URL

	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe"
	checksumURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256"
	signatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig"
	manifestURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json"
	manifestSignatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig"

	// Override HTTP client to route GitHub URLs to our test server.
	u.httpClient = &http.Client{
		Transport: &rewriteTransport{srv.URL},
	}

	err := u.DownloadAndVerify(context.Background(), "v1.0.0", downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, dest)
	if err != nil {
		t.Fatalf("DownloadAndVerify: %v", err)
	}

	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, content) {
		t.Errorf("downloaded content mismatch")
	}
}

func testDownloadAndVerifySuccessLinux(t *testing.T) {
	inner := []byte("linux binary payload")
	tgz := mustBuildChatserverTarGz(t, inner)
	hash := sha256.Sum256(tgz)
	checksumHex := hex.EncodeToString(hash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver-linux-amd64.tar.gz","sha256":"` + checksumHex + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver-linux-amd64.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(tgz)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  linux/chatserver-linux-amd64.tar.gz\n", checksumHex)
	})
	mux.HandleFunc("/download/chatserver-linux-amd64.tar.gz.sig", func(w http.ResponseWriter, r *http.Request) {
		// Linux tar.gz does not have a detached binary sig; return empty to satisfy URL validation.
		// The signing flow only applies the manifest; the binary sig slot is unused on Linux.
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver")

	u.baseURL = srv.URL

	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver-linux-amd64.tar.gz"
	checksumURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256"
	signatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver-linux-amd64.tar.gz.sig"
	manifestURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json"
	manifestSignatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig"

	u.httpClient = &http.Client{
		Transport: &rewriteTransport{srv.URL},
	}

	err := u.DownloadAndVerify(context.Background(), "v1.0.0", downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, dest)
	if err != nil {
		t.Fatalf("DownloadAndVerify: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, inner) {
		t.Errorf("extracted binary mismatch")
	}
}

func mustBuildChatserverTarGz(t *testing.T, inner []byte) []byte {
	t.Helper()
	var gzbuf bytes.Buffer
	gw := gzip.NewWriter(&gzbuf)
	tw := tar.NewWriter(gw)
	hdr := &tar.Header{
		Name:     "chatserver",
		Mode:     0o755,
		Size:     int64(len(inner)),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(inner); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return gzbuf.Bytes()
}

func TestDownloadAndVerify_InvalidDownloadURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	err := u.DownloadAndVerify(context.Background(), "v1.0.0", "https://evil.com/file", "https://evil.com/sum", "https://evil.com/file.sig", "https://evil.com/manifest.json", "https://evil.com/manifest.json.sig", "/tmp/out")
	if err == nil {
		t.Error("DownloadAndVerify should reject invalid download URL")
	}
}

func TestDownloadAndVerify_InvalidChecksumURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe"
	err := u.DownloadAndVerify(context.Background(), "v1.0.0", downloadURL, "https://evil.com/sum", "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig", "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json", "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig", "/tmp/out")
	if err == nil {
		t.Error("DownloadAndVerify should reject invalid checksum URL")
	}
}

func TestDownloadAndVerify_ChecksumMismatch(t *testing.T) {
	switch runtime.GOOS {
	case "windows":
		testDownloadAndVerifyChecksumMismatchWindows(t)
	case "linux":
		testDownloadAndVerifyChecksumMismatchLinux(t)
	default:
		t.Skip("no checksum mismatch case for GOOS=" + runtime.GOOS)
	}
}

func testDownloadAndVerifyChecksumMismatchWindows(t *testing.T) {
	content := []byte("binary content")
	wrongChecksum := "0000000000000000000000000000000000000000000000000000000000000000"
	actualHash := sha256.Sum256(content)
	actualChecksum := hex.EncodeToString(actualHash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	signature := signTestAsset(t, privateKey, content)
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"` + actualChecksum + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", wrongChecksum)
	})
	mux.HandleFunc("/download/chatserver.exe.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(signature)
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe")

	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}

	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe"
	checksumURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256"
	signatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig"
	manifestURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json"
	manifestSignatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig"

	err := u.DownloadAndVerify(context.Background(), "v1.0.0", downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, dest)
	if err == nil {
		t.Error("DownloadAndVerify should fail on checksum mismatch")
	}

	// File should be removed after mismatch.
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after checksum mismatch")
	}
}

func testDownloadAndVerifyChecksumMismatchLinux(t *testing.T) {
	tgz := mustBuildChatserverTarGz(t, []byte("x"))
	wrongChecksum := "0000000000000000000000000000000000000000000000000000000000000000"
	actualHash := sha256.Sum256(tgz)
	actualChecksum := hex.EncodeToString(actualHash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver-linux-amd64.tar.gz","sha256":"` + actualChecksum + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver-linux-amd64.tar.gz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(tgz)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  linux/chatserver-linux-amd64.tar.gz\n", wrongChecksum)
	})
	mux.HandleFunc("/download/chatserver-linux-amd64.tar.gz.sig", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver")

	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}

	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver-linux-amd64.tar.gz"
	checksumURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256"
	signatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver-linux-amd64.tar.gz.sig"
	manifestURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json"
	manifestSignatureURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig"

	err := u.DownloadAndVerify(context.Background(), "v1.0.0", downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, dest)
	if err == nil {
		t.Error("DownloadAndVerify should fail on checksum mismatch")
	}

	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("extracted file should not exist after checksum mismatch")
	}
}

func TestDownloadAndVerify_MissingSignature(t *testing.T) {
	content := []byte("real binary content for verification")
	hash := sha256.Sum256(content)
	checksumHex := hex.EncodeToString(hash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"` + checksumHex + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", checksumHex)
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe")

	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}

	err := u.DownloadAndVerify(
		context.Background(),
		"v1.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig",
		dest,
	)
	if err == nil {
		t.Fatal("DownloadAndVerify should fail when signature asset is missing")
	}
}

func TestDownloadAndVerify_InvalidSignature(t *testing.T) {
	content := []byte("real binary content for verification")
	otherContent := []byte("tampered bytes")
	hash := sha256.Sum256(content)
	checksumHex := hex.EncodeToString(hash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	signature := signTestAsset(t, privateKey, otherContent)
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"` + checksumHex + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", checksumHex)
	})
	mux.HandleFunc("/download/chatserver.exe.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(signature)
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe")

	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}
	err := u.DownloadAndVerify(
		context.Background(),
		"v1.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig",
		dest,
	)
	if err == nil {
		t.Fatal("DownloadAndVerify should fail on invalid signature")
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after signature verification failure")
	}
}

func TestDownloadAndVerify_MalformedSignature(t *testing.T) {
	content := []byte("real binary content for verification")
	hash := sha256.Sum256(content)
	checksumHex := hex.EncodeToString(hash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	manifest := []byte(`{"version":"v1.0.0","asset":"chatserver.exe","sha256":"` + checksumHex + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", checksumHex)
	})
	mux.HandleFunc("/download/chatserver.exe.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not-a-valid-signature"))
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver.exe")

	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}
	err := u.DownloadAndVerify(
		context.Background(),
		"v1.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig",
		dest,
	)
	if err == nil {
		t.Fatal("DownloadAndVerify should fail on malformed signature")
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after malformed signature")
	}
}

func TestDownloadAndVerify_ManifestVersionMismatch(t *testing.T) {
	content := []byte("real binary content for verification")
	hash := sha256.Sum256(content)
	checksumHex := hex.EncodeToString(hash[:])
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	signature := signTestAsset(t, privateKey, content)
	manifest := []byte(`{"version":"v0.9.0","asset":"chatserver.exe","sha256":"` + checksumHex + `"}`)
	manifestSignature := signTestAsset(t, privateKey, manifest)

	mux := http.NewServeMux()
	mux.HandleFunc("/download/chatserver.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(content)
	})
	mux.HandleFunc("/download/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  chatserver.exe\n", checksumHex)
	})
	mux.HandleFunc("/download/chatserver.exe.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(signature)
	})
	mux.HandleFunc("/download/server-update-manifest.json", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifest)
	})
	mux.HandleFunc("/download/server-update-manifest.json.sig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(manifestSignature)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "chatserver.exe")
	u.httpClient = &http.Client{Transport: &rewriteTransport{srv.URL}}
	err := u.DownloadAndVerify(
		context.Background(),
		"v1.0.0",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/checksums.sha256",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json",
		"https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig",
		dest,
	)
	if err == nil {
		t.Fatal("DownloadAndVerify should fail on mismatched signed manifest version")
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after manifest verification failure")
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
