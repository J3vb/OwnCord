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
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
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
			mustDo(t, "encoding release", json.NewEncoder(w).Encode(release))
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
	mustDo(t, "GenerateKey", err)
	publicKeyText, err := publicKey.MarshalText()
	mustDo(t, "MarshalText(public key)", err)
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
	release := newReleaseFor("v1.2.0", "Bug fixes and improvements")
	srv := newTestServer(t, release, http.StatusOK)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	info, err := u.CheckForUpdate(context.Background())
	mustDo(t, "unexpected error", err)
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
	// Server binary asset is only selected on Windows and Linux, amd64 only.
	if want := serverDownloadAssetName(runtime.GOOS, runtime.GOARCH); want != "" {
		if info.DownloadURL == "" {
			t.Error("expected non-empty DownloadURL")
		}
	} else if info.DownloadURL != "" {
		t.Error("expected empty DownloadURL on unsupported GOOS")
	}
	// The detached binary signature is Windows-only: DownloadAndVerify sets
	// needSignature = runtime.GOOS == "windows", and the Linux tarball path
	// verifies through the signed manifest and checksum instead. The reported
	// URL is now the signature paired with the asset this host would actually
	// download, so a non-Windows host reports none rather than pointing at a
	// Windows signature it would never fetch.
	if want := serverSignatureAssetName(runtime.GOOS, runtime.GOARCH); want != "" {
		if info.SignatureURL == "" {
			t.Error("expected non-empty SignatureURL on Windows")
		}
	} else if info.SignatureURL != "" {
		t.Errorf("expected empty SignatureURL off Windows, got %q", info.SignatureURL)
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
	mustDo(t, "unexpected error", err)
	if info.UpdateAvailable {
		t.Fatal("expected UpdateAvailable=false for incomplete release")
	}
	if info.RequiredAssetsPresent {
		t.Fatal("expected RequiredAssetsPresent=false for incomplete release")
	}
}

func TestCheckForUpdate_UpToDate(t *testing.T) {
	release := newReleaseFor("v1.0.0", "Current release")
	srv := newTestServer(t, release, http.StatusOK)
	defer srv.Close()

	u := newTestUpdater(srv.URL, "1.0.0")
	info, err := u.CheckForUpdate(context.Background())
	mustDo(t, "unexpected error", err)
	if info.UpdateAvailable {
		t.Error("expected UpdateAvailable=false, got true")
	}
}

func TestCheckForUpdate_CachesResult(t *testing.T) {
	u, hitCount := newCountingUpdater(t)
	ctx := context.Background()

	_, err := u.CheckForUpdate(ctx)
	mustDo(t, "first call error", err)
	_, err = u.CheckForUpdate(ctx)
	mustDo(t, "second call error", err)

	if got := hitCount.Load(); got != 1 {
		t.Errorf("expected 1 API hit (cached), got %d", got)
	}
}

func TestCheckForUpdate_CacheExpires(t *testing.T) {
	u, hitCount := newCountingUpdater(t)
	ctx := context.Background()

	// First call populates cache.
	_, err := u.CheckForUpdate(ctx)
	mustDo(t, "first call error", err)

	// Expire the cache manually.
	u.mu.Lock()
	u.cacheExpiry = time.Now().Add(-1 * time.Minute)
	u.mu.Unlock()

	// Second call should hit the API again.
	_, err = u.CheckForUpdate(ctx)
	mustDo(t, "second call error", err)

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
	mustDo(t, "writing temp file", os.WriteFile(filePath, content, 0o644))

	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	if err := u.VerifyChecksum(filePath, expectedHash); err != nil {
		t.Errorf("expected correct checksum to pass, got error: %v", err)
	}
}

func TestVerifyChecksum_Incorrect(t *testing.T) {
	content := []byte("hello world binary content")

	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "chatserver.exe")
	mustDo(t, "writing temp file", os.WriteFile(filePath, content, 0o644))

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
		goarch  string
		assetFn func(*testing.T) []byte
	}{
		{
			name:   "windows_exe",
			goos:   "windows",
			goarch: "amd64",
			assetFn: func(*testing.T) []byte {
				return []byte("windows server binary payload for checksum test")
			},
		},
		{
			name:   "linux_tar_gz",
			goos:   "linux",
			goarch: "amd64",
			assetFn: func(t *testing.T) []byte {
				return mustBuildChatserverTarGz(t, []byte("linux inner binary for checksum test"))
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			asset := tc.assetFn(t)
			names := checksumEntryNamesForGOOS(tc.goos, tc.goarch)
			if len(names) == 0 {
				t.Fatal("checksumEntryNamesForGOOS: empty names")
			}

			sum := sha256.Sum256(asset)
			expectedHex := hex.EncodeToString(sum[:])

			// Same line shape as release workflow: sha256sum prints "<hash>  <path>".
			primaryPath := names[0]
			checksumData := fmt.Appendf(nil, "%s  %s\n", expectedHex, primaryPath)

			parsed, err := u.parseChecksumFileAny(checksumData, names...)
			mustDo(t, "parseChecksumFileAny", err)
			if !strings.EqualFold(parsed, expectedHex) {
				t.Fatalf("parsed hash %q, want %q", parsed, expectedHex)
			}

			tmp := filepath.Join(t.TempDir(), "release-asset")
			mustDo(t, "WriteFile", os.WriteFile(tmp, asset, 0o644))
			mustDo(t, "VerifyChecksum", u.VerifyChecksum(tmp, expectedHex))
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
	checksumData := fmt.Appendf(nil, "%s  chatserver.exe\n", expectedHex)

	names := checksumEntryNamesForGOOS("windows", "amd64")
	parsed, err := u.parseChecksumFileAny(checksumData, names...)
	mustDo(t, "parseChecksumFileAny", err)
	if !strings.EqualFold(parsed, expectedHex) {
		t.Fatalf("parsed %q, want %q", parsed, expectedHex)
	}

	tmp := filepath.Join(t.TempDir(), "chatserver.exe")
	mustDo(t, "WriteFile", os.WriteFile(tmp, asset, 0o644))
	mustDo(t, "VerifyChecksum", u.VerifyChecksum(tmp, expectedHex))
}

func TestParseChecksumFile_FindsFile(t *testing.T) {
	data := []byte("abc123  readme.txt\ndef456  chatserver.exe\nghi789  other.dll\n")
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	hash, err := u.ParseChecksumFile(data, "chatserver.exe")
	mustDo(t, "unexpected error", err)
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
	mustDo(t, "parseChecksumFileAny", err)
	if h != "bbb" {
		t.Errorf("hash = %q, want bbb (linux line first in list)", h)
	}
}

func TestServerDownloadAssetName(t *testing.T) {
	tests := []struct {
		goos   string
		goarch string
		want   string
	}{
		{"windows", "amd64", "chatserver.exe"},
		{"linux", "amd64", "chatserver-linux-amd64.tar.gz"},
		{"windows", "arm64", "chatserver-windows-arm64.exe"},
		{"linux", "arm64", "chatserver-linux-arm64.tar.gz"},
		{"darwin", "amd64", ""},
		{"freebsd", "amd64", ""},
		// The pairing still fails closed: a host must never receive a binary
		// for an architecture it cannot execute (OC-0320). Only the four
		// published pairs above resolve; everything else is "".
		{"darwin", "arm64", ""},
		{"linux", "386", ""},
		{"windows", "arm", ""},
	}
	for _, tc := range tests {
		if got := serverDownloadAssetName(tc.goos, tc.goarch); got != tc.want {
			t.Errorf("serverDownloadAssetName(%q, %q) = %q, want %q", tc.goos, tc.goarch, got, tc.want)
		}
	}
}

// TestChecksumEntryNamesForTarget pins the checksum lookup to the target's
// whole GOOS/GOARCH pair, the way serverDownloadAssetName already is. A
// GOOS-only lookup handed every architecture the amd64 entry names, so an
// arm64 host looked up its own download under the amd64 file's hash, the
// comparison failed, and the update was refused with nothing naming the
// reason.
func TestChecksumEntryNamesForTarget(t *testing.T) {
	tests := []struct {
		goos   string
		goarch string
		want   []string
	}{
		{"windows", "amd64", []string{"windows/chatserver.exe", "chatserver.exe"}},
		{"windows", "arm64", []string{"windows/chatserver-windows-arm64.exe", "chatserver-windows-arm64.exe"}},
		{"linux", "amd64", []string{"linux/chatserver-linux-amd64.tar.gz", "chatserver-linux-amd64.tar.gz"}},
		{"linux", "arm64", []string{"linux/chatserver-linux-arm64.tar.gz", "chatserver-linux-arm64.tar.gz"}},
		// Fail closed, like the asset-name pairing: an unpublished target
		// resolves no checksum entry at all, so download.go falls back to the
		// filename it actually fetched rather than to another target's hash.
		{"darwin", "arm64", nil},
		{"linux", "386", nil},
	}
	for _, tc := range tests {
		if got := checksumEntryNamesForGOOS(tc.goos, tc.goarch); !slices.Equal(got, tc.want) {
			t.Errorf("checksumEntryNamesForGOOS(%q, %q) = %q, want %q", tc.goos, tc.goarch, got, tc.want)
		}
	}

	// The bare entry must match a checksum line in the release's layout, which
	// the release workflow writes with an in-directory `sha256sum -- *` and so
	// without a directory prefix. This is the assertion an amd64-only lookup
	// fails: neither amd64 name appears in an arm64-only blob, and
	// parseChecksumFileAny reports no matching line.
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	for _, target := range []struct{ goos, goarch string }{
		{"windows", "arm64"},
		{"linux", "arm64"},
	} {
		names := checksumEntryNamesForGOOS(target.goos, target.goarch)
		if len(names) == 0 {
			t.Fatalf("checksumEntryNamesForGOOS(%q, %q): empty names", target.goos, target.goarch)
		}
		bare := names[len(names)-1]
		sum := sha256.Sum256([]byte("arm64 asset payload"))
		expectedHex := hex.EncodeToString(sum[:])
		checksumData := fmt.Appendf(nil, "%s  %s\n", expectedHex, bare)

		parsed, err := u.parseChecksumFileAny(checksumData, names...)
		if err != nil {
			t.Fatalf("%s/%s: parseChecksumFileAny(%q): %v", target.goos, target.goarch, bare, err)
		}
		if !strings.EqualFold(parsed, expectedHex) {
			t.Errorf("%s/%s: parsed %q, want %q", target.goos, target.goarch, parsed, expectedHex)
		}
	}
}

// The detached binary signature must name the asset actually downloaded. A
// fixed "chatserver.exe.sig" would hand a Windows arm64 host the amd64
// signature, so verification would fail on every arm64 update — the OC-0320
// architecture-blindness failure moved one step down the pipeline.
func TestServerSignatureAssetName(t *testing.T) {
	tests := []struct {
		goos   string
		goarch string
		want   string
	}{
		{"windows", "amd64", "chatserver.exe.sig"},
		{"windows", "arm64", "chatserver-windows-arm64.exe.sig"},
		// Windows-only: the Linux tarball verifies through the signed
		// manifest and checksum and never receives a detached signature.
		{"linux", "amd64", ""},
		{"linux", "arm64", ""},
		{"darwin", "arm64", ""},
	}
	for _, tc := range tests {
		if got := serverSignatureAssetName(tc.goos, tc.goarch); got != tc.want {
			t.Errorf("serverSignatureAssetName(%q, %q) = %q, want %q", tc.goos, tc.goarch, got, tc.want)
		}
	}
}

func TestExtractChatserverFromTarGz(t *testing.T) {
	inner := []byte("#!/bin/fake\n")
	var gzbuf bytes.Buffer
	gw := gzip.NewWriter(&gzbuf)
	tw := tar.NewWriter(gw)
	hdr := &tar.Header{Name: "chatserver", Mode: 0o755, Size: int64(len(inner)), Typeflag: tar.TypeReg}
	mustDo(t, "WriteHeader", tw.WriteHeader(hdr))
	if _, err := tw.Write(inner); err != nil {
		t.Fatal(err)
	}
	mustDo(t, "Close", tw.Close())
	mustDo(t, "Close", gw.Close())

	tmpDir := t.TempDir()
	dest := filepath.Join(tmpDir, "chatserver")
	gotHash, err := extractChatserverFromTarGz(bytes.NewReader(gzbuf.Bytes()), dest)
	mustDo(t, "extractChatserverFromTarGz", err)
	innerSum := sha256.Sum256(inner)
	if gotHash != hex.EncodeToString(innerSum[:]) {
		t.Errorf("extracted hash = %q, want hash of written bytes", gotHash)
	}
	got, err := os.ReadFile(dest)
	mustDo(t, "ReadFile", err)
	if !bytes.Equal(got, inner) {
		t.Errorf("extracted content mismatch")
	}
}

// tarEntry is one member of a test archive; body is empty for header-only
// entries such as symlinks.
type tarEntry struct {
	hdr  tar.Header
	body []byte
}

func buildTarGz(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for i := range entries {
		hdr := entries[i].hdr
		hdr.Mode = 0o755
		hdr.Size = int64(len(entries[i].body))
		mustDo(t, "WriteHeader", tw.WriteHeader(&hdr))
		if _, err := tw.Write(entries[i].body); err != nil {
			t.Fatal(err)
		}
	}
	mustDo(t, "Close", tw.Close())
	mustDo(t, "Close", gw.Close())
	return buf.Bytes()
}

func TestExtractChatserverFromTarGzEntryFilters(t *testing.T) {
	want := []byte("#!/bin/real\n")
	wantSum := sha256.Sum256(want)
	regular := tarEntry{hdr: tar.Header{Name: "chatserver", Typeflag: tar.TypeReg}, body: want}

	tests := []struct {
		name    string
		entries []tarEntry
		wantErr bool
	}{
		{
			// A "chatserver" shipped as a symlink must not be followed.
			name:    "non-regular entry is skipped",
			entries: []tarEntry{{hdr: tar.Header{Name: "chatserver", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}}, regular},
		},
		{
			name:    "path-traversal name is skipped",
			entries: []tarEntry{{hdr: tar.Header{Name: "../../chatserver", Typeflag: tar.TypeReg}, body: []byte("planted")}, regular},
		},
		{
			name:    "other basename is skipped",
			entries: []tarEntry{{hdr: tar.Header{Name: "chatserver.sig", Typeflag: tar.TypeReg}, body: []byte("sig")}, regular},
		},
		{
			name:    "no chatserver member at all",
			entries: []tarEntry{{hdr: tar.Header{Name: "README", Typeflag: tar.TypeReg}, body: []byte("hi")}, {hdr: tar.Header{Name: "chatserver", Typeflag: tar.TypeSymlink, Linkname: "/bin/sh"}}},
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "chatserver")
			gotHash, err := extractChatserverFromTarGz(bytes.NewReader(buildTarGz(t, tc.entries...)), dest)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("extractChatserverFromTarGz = %q, want error", gotHash)
				}
				if _, statErr := os.Stat(dest); !errors.Is(statErr, fs.ErrNotExist) {
					t.Errorf("destPath exists after a failed extraction (stat err %v)", statErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("extractChatserverFromTarGz: %v", err)
			}
			if gotHash != hex.EncodeToString(wantSum[:]) {
				t.Errorf("hash = %q, want hash of the regular chatserver entry", gotHash)
			}
			got, readErr := os.ReadFile(dest)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if !bytes.Equal(got, want) {
				t.Errorf("extracted %q, want %q", got, want)
			}
		})
	}
}

// A pre-existing staging path is an attacker-planted file: staging is O_EXCL,
// so extraction must fail rather than write through it.
func TestExtractChatserverFromTarGzRefusesExistingDest(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "chatserver")
	planted := []byte("planted-by-attacker")
	mustDo(t, "WriteFile", os.WriteFile(dest, planted, 0o600))

	archive := buildTarGz(t, tarEntry{hdr: tar.Header{Name: "chatserver", Typeflag: tar.TypeReg}, body: []byte("#!/bin/real\n")})
	if _, err := extractChatserverFromTarGz(bytes.NewReader(archive), dest); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("extractChatserverFromTarGz err = %v, want fs.ErrExist", err)
	}
	got, err := os.ReadFile(dest)
	mustDo(t, "ReadFile", err)
	if !bytes.Equal(got, planted) {
		t.Errorf("pre-existing file was overwritten: %q", got)
	}
}

func TestAssetFilenameFromURL(t *testing.T) {
	got, err := assetFilenameFromURL("https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe")
	mustDo(t, "assetFilenameFromURL", err)
	if got != "chatserver.exe" {
		t.Errorf("assetFilenameFromURL = %q, want chatserver.exe", got)
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
	mustDo(t, "fetchBody", err)
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
	mustDo(t, "downloadFile", u.downloadFile(context.Background(), srv.URL+"/binary", dest))

	got, err := os.ReadFile(dest)
	mustDo(t, "reading downloaded file", err)
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
	f := newWindowsDownloadFixture(t, content, "v1.0.0")
	f.signature = append(f.signature, []byte("\r\n")...)
	f.serve(t, true)

	stagedHash, err := downloadAndVerifyAsset(f.updater, "chatserver.exe", f.dest)
	mustDo(t, "DownloadAndVerify", err)
	if want := sha256Hex(content); stagedHash != want {
		t.Errorf("staged hash = %q, want manifest-bound hash %q", stagedHash, want)
	}

	got, _ := os.ReadFile(f.dest)
	if !bytes.Equal(got, content) {
		t.Errorf("downloaded content mismatch")
	}
}

func testDownloadAndVerifySuccessLinux(t *testing.T) {
	inner := []byte("linux binary payload")
	f := newLinuxDownloadFixture(t, inner, "")

	stagedHash, err := downloadAndVerifyAsset(f.updater, "chatserver-linux-amd64.tar.gz", f.dest)
	mustDo(t, "DownloadAndVerify", err)
	if stagedHash != sha256Hex(inner) {
		t.Errorf("staged hash = %q, want hash of extracted binary", stagedHash)
	}

	got, err := os.ReadFile(f.dest)
	mustDo(t, "ReadFile", err)
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
	mustDo(t, "WriteHeader", tw.WriteHeader(hdr))
	if _, err := tw.Write(inner); err != nil {
		t.Fatal(err)
	}
	mustDo(t, "Close", tw.Close())
	mustDo(t, "Close", gw.Close())
	return gzbuf.Bytes()
}

func TestDownloadAndVerify_InvalidDownloadURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	_, err := u.DownloadAndVerify(context.Background(), "v1.0.0", "https://evil.com/file", "https://evil.com/sum", "https://evil.com/file.sig", "https://evil.com/manifest.json", "https://evil.com/manifest.json.sig", "/tmp/out")
	if err == nil {
		t.Error("DownloadAndVerify should reject invalid download URL")
	}
}

func TestDownloadAndVerify_InvalidChecksumURL(t *testing.T) {
	u := NewUpdater("1.0.0", "", "J3vb", "OwnCord")
	downloadURL := "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe"
	_, err := u.DownloadAndVerify(context.Background(), "v1.0.0", downloadURL, "https://evil.com/sum", "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/chatserver.exe.sig", "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json", "https://github.com/J3vb/OwnCord/releases/download/v1.0.0/server-update-manifest.json.sig", "/tmp/out")
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
	f := newWindowsDownloadFixture(t, []byte("binary content"), "v1.0.0")
	f.checksumLine = "0000000000000000000000000000000000000000000000000000000000000000  chatserver.exe\n"
	f.serve(t, true)

	if _, err := downloadAndVerifyAsset(f.updater, "chatserver.exe", f.dest); err == nil {
		t.Error("DownloadAndVerify should fail on checksum mismatch")
	}

	// File should be removed after mismatch.
	if _, statErr := os.Stat(f.dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after checksum mismatch")
	}
}

func testDownloadAndVerifyChecksumMismatchLinux(t *testing.T) {
	f := newLinuxDownloadFixture(t, []byte("x"), "0000000000000000000000000000000000000000000000000000000000000000")

	if _, err := downloadAndVerifyAsset(f.updater, "chatserver-linux-amd64.tar.gz", f.dest); err == nil {
		t.Error("DownloadAndVerify should fail on checksum mismatch")
	}

	if _, statErr := os.Stat(f.dest); !os.IsNotExist(statErr) {
		t.Error("extracted file should not exist after checksum mismatch")
	}
}

func TestDownloadAndVerify_MissingSignature(t *testing.T) {
	f := newWindowsDownloadFixture(t, []byte("real binary content for verification"), "v1.0.0")
	f.serve(t, false)

	if _, err := downloadAndVerifyAsset(f.updater, "chatserver.exe", f.dest); err == nil {
		t.Fatal("DownloadAndVerify should fail when signature asset is missing")
	}
}

func TestDownloadAndVerify_InvalidSignature(t *testing.T) {
	f := newWindowsDownloadFixture(t, []byte("real binary content for verification"), "v1.0.0")
	f.signature = signTestAsset(t, f.key, []byte("tampered bytes"))
	f.serve(t, true)

	if _, err := downloadAndVerifyAsset(f.updater, "chatserver.exe", f.dest); err == nil {
		t.Fatal("DownloadAndVerify should fail on invalid signature")
	}
	if _, statErr := os.Stat(f.dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after signature verification failure")
	}
}

func TestDownloadAndVerify_MalformedSignature(t *testing.T) {
	f := newWindowsDownloadFixture(t, []byte("real binary content for verification"), "v1.0.0")
	f.signature = []byte("not-a-valid-signature")
	f.serve(t, true)

	if _, err := downloadAndVerifyAsset(f.updater, "chatserver.exe", f.dest); err == nil {
		t.Fatal("DownloadAndVerify should fail on malformed signature")
	}
	if _, statErr := os.Stat(f.dest); !os.IsNotExist(statErr) {
		t.Error("file should be removed after malformed signature")
	}
}

func TestDownloadAndVerify_ManifestVersionMismatch(t *testing.T) {
	f := newWindowsDownloadFixture(t, []byte("real binary content for verification"), "v0.9.0")
	f.serve(t, true)

	if _, err := downloadAndVerifyAsset(f.updater, "chatserver.exe", f.dest); err == nil {
		t.Fatal("DownloadAndVerify should fail on mismatched signed manifest version")
	}
	if _, statErr := os.Stat(f.dest); !os.IsNotExist(statErr) {
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

// TestVerifySignature_TauriBase64WrappedFormat locks in support for the .sig
// format that `tauri signer sign` produces in the release pipeline: a
// base64-wrapped minisign document. Raw minisign documents must keep working.
func TestVerifySignature_TauriBase64WrappedFormat(t *testing.T) {
	u, privateKey := newSignedTestUpdater(t, "", "1.0.0")
	content := []byte("tauri wrapped signature test")
	rawSig := signTestAsset(t, privateKey, content)
	wrappedSig := []byte(base64.StdEncoding.EncodeToString(rawSig))

	path := filepath.Join(t.TempDir(), "chatserver.exe")
	mustDo(t, "writing test asset", os.WriteFile(path, content, 0o600))

	if err := u.VerifySignature(path, wrappedSig); err != nil {
		t.Errorf("base64-wrapped tauri signature should verify: %v", err)
	}
	if err := u.VerifySignature(path, rawSig); err != nil {
		t.Errorf("raw minisign signature should verify: %v", err)
	}
	// Valid base64 that decodes to garbage must fail cleanly, not verify.
	garbage := []byte(base64.StdEncoding.EncodeToString([]byte("not a signature")))
	if err := u.VerifySignature(path, garbage); err == nil {
		t.Error("garbage base64 signature should fail verification")
	}
	// Wrapped signature over different content must fail verification.
	otherPath := filepath.Join(t.TempDir(), "other.bin")
	mustDo(t, "writing tampered asset", os.WriteFile(otherPath, []byte("tampered"), 0o600))
	if err := u.VerifySignature(otherPath, wrappedSig); err == nil {
		t.Error("wrapped signature must not verify tampered content")
	}
}

// ─── Staged-binary TOCTOU guard (W3-3) ───────────────────────────────────────

// TestOpenVerifiedBinary_CommitHappyPath: verify-through-handle then commit
// moves the exact verified file to the destination.
func TestOpenVerifiedBinary_CommitHappyPath(t *testing.T) {
	dir := t.TempDir()
	stagedPath := filepath.Join(dir, "app.new")
	content := []byte("verified update bytes")
	mustDo(t, "WriteFile", os.WriteFile(stagedPath, content, 0o600))
	sum := sha256.Sum256(content)

	staged, err := OpenVerifiedBinary(stagedPath, hex.EncodeToString(sum[:]))
	mustDo(t, "OpenVerifiedBinary", err)
	defer staged.Close() //nolint:errcheck

	destPath := filepath.Join(dir, "app")
	mustDo(t, "Commit", staged.Commit(destPath))
	got, err := os.ReadFile(destPath)
	mustDo(t, "ReadFile", err)
	if !bytes.Equal(got, content) {
		t.Errorf("committed content mismatch")
	}
	if _, err := os.Lstat(stagedPath); !os.IsNotExist(err) {
		t.Errorf("staged path should be gone after commit")
	}
}

func TestOpenVerifiedBinary_WrongHash(t *testing.T) {
	stagedPath := filepath.Join(t.TempDir(), "app.new")
	mustDo(t, "WriteFile", os.WriteFile(stagedPath, []byte("some bytes"), 0o600))
	wrong := "0000000000000000000000000000000000000000000000000000000000000000"
	if _, err := OpenVerifiedBinary(stagedPath, wrong); err == nil {
		t.Fatal("OpenVerifiedBinary must reject a hash mismatch")
	}
}

// TestOpenVerifiedBinary_SwapAfterVerifyDetectedAtCommit locks the W3-3
// invariant: hash verification and the rename commit operate on the same
// file. The old path-based flow (VerifyChecksum(path) then os.Rename(path))
// silently renamed — and would have spawned — whatever was swapped in at the
// staged path after verification. Now either the swap itself is blocked by
// the held verification handle (Windows) or Commit detects the swapped file
// and refuses (Unix); unverified bytes must never land at the destination.
func TestOpenVerifiedBinary_SwapAfterVerifyDetectedAtCommit(t *testing.T) {
	dir := t.TempDir()
	stagedPath := filepath.Join(dir, "app.new")
	good := []byte("good verified bytes")
	mustDo(t, "WriteFile", os.WriteFile(stagedPath, good, 0o600))
	sum := sha256.Sum256(good)

	staged, err := OpenVerifiedBinary(stagedPath, hex.EncodeToString(sum[:]))
	mustDo(t, "OpenVerifiedBinary", err)
	defer staged.Close() //nolint:errcheck

	// Attacker tries to win the race: replace the staged path after
	// verification but before the rename.
	evilPath := filepath.Join(dir, "evil")
	mustDo(t, "WriteFile", os.WriteFile(evilPath, []byte("malicious payload"), 0o600))
	swapErr := os.Rename(evilPath, stagedPath)

	destPath := filepath.Join(dir, "app")
	commitErr := staged.Commit(destPath)
	switch {
	case swapErr == nil && commitErr == nil:
		t.Fatal("staged binary was swapped after verification and Commit did not detect it")
	case swapErr != nil && commitErr != nil:
		t.Fatalf("swap was blocked (%v) but Commit still failed: %v", swapErr, commitErr)
	case commitErr == nil:
		// Swap blocked by the held verification handle (Windows): the
		// committed file must be the verified bytes.
		got, err := os.ReadFile(destPath)
		mustDo(t, "ReadFile", err)
		if !bytes.Equal(got, good) {
			t.Errorf("committed content is not the verified bytes")
		}
	}
}

// TestDownloadFile_RefusesPreExistingDest locks the O_EXCL staging invariant:
// the download must refuse to write through a path an attacker pre-created.
func TestDownloadFile_RefusesPreExistingDest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("downloaded content"))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "staged.bin")
	planted := []byte("attacker planted file")
	mustDo(t, "WriteFile", os.WriteFile(dest, planted, 0o600))

	u := newTestUpdater(srv.URL, "1.0.0")
	if err := u.downloadFile(context.Background(), srv.URL+"/binary", dest); err == nil {
		t.Fatal("downloadFile must refuse a pre-existing staging path")
	}
	got, err := os.ReadFile(dest)
	mustDo(t, "ReadFile", err)
	if !bytes.Equal(got, planted) {
		t.Errorf("pre-existing file must be left untouched")
	}
}

// The chatserver.exe.sig asset is consumed only by the Windows verify path;
// Linux integrity comes entirely from the signed manifest + checksum. Gating
// linux updates on a Windows-only asset makes any release without it report
// UpdateAvailable=false on Linux forever.
func TestHasRequiredServerAssets_SignatureGOOSAware(t *testing.T) {
	if !hasRequiredServerAssetsFor("linux", "d", "c", "", "m", "ms") {
		t.Error("linux update gated on the windows-only .sig asset")
	}
	if hasRequiredServerAssetsFor("windows", "d", "c", "", "m", "ms") {
		t.Error("windows update must still hard-require the .sig asset")
	}
	if !hasRequiredServerAssetsFor("windows", "d", "c", "s", "m", "ms") {
		t.Error("complete windows asset set refused")
	}
}
