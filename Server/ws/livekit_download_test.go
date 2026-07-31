package ws

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestLivekitAssetName(t *testing.T) {
	cases := []struct {
		goos, goarch string
		want         string
		wantErr      bool
	}{
		{"linux", "amd64", "livekit_1.13.5_linux_amd64.tar.gz", false},
		{"linux", "arm64", "livekit_1.13.5_linux_arm64.tar.gz", false},
		{"linux", "arm", "livekit_1.13.5_linux_armv7.tar.gz", false},
		{"windows", "amd64", "livekit_1.13.5_windows_amd64.zip", false},
		{"windows", "arm64", "livekit_1.13.5_windows_arm64.zip", false},
		{"darwin", "arm64", "", true},
		{"linux", "riscv64", "", true},
	}
	for _, tc := range cases {
		got, err := livekitAssetName("1.13.5", tc.goos, tc.goarch)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s/%s: expected error, got %q", tc.goos, tc.goarch, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s/%s: unexpected error: %v", tc.goos, tc.goarch, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%s/%s = %q, want %q", tc.goos, tc.goarch, got, tc.want)
		}
	}
}

func TestParseChecksumLine(t *testing.T) {
	hash := strings.Repeat("ab", 32)
	data := []byte("# comment\n" + hash + "  livekit_1.13.5_linux_amd64.tar.gz\ndeadbeef  other.txt\n")
	got, err := parseChecksumLine(data, "livekit_1.13.5_linux_amd64.tar.gz")
	if err != nil {
		t.Fatalf("parseChecksumLine: %v", err)
	}
	if got != hash {
		t.Errorf("hash = %q, want %q", got, hash)
	}
	if _, err := parseChecksumLine(data, "missing.tar.gz"); err == nil {
		t.Error("expected error for missing entry")
	}
	// "deadbeef" is not 64 hex chars — must not be accepted for other.txt.
	if _, err := parseChecksumLine(data, "other.txt"); err == nil {
		t.Error("expected error for malformed hash length")
	}
}

// makeTarGz builds a tar.gz containing LICENSE plus a livekit-server entry.
func makeTarGz(t *testing.T, binaryContent []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for _, f := range []struct {
		name string
		body []byte
	}{
		{"LICENSE", []byte("apache 2.0")},
		{"livekit-server", binaryContent},
	} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatalf("tar header: %v", err)
		}
		if _, err := tw.Write(f.body); err != nil {
			t.Fatalf("tar write: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

func TestExtractLiveKitFromZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range []struct {
		name string
		body []byte
	}{
		{"LICENSE", []byte("apache 2.0")},
		{"livekit-server.exe", []byte("MZ fake windows binary")},
	} {
		w, err := zw.Create(f.name)
		if err != nil {
			t.Fatalf("zip create: %v", err)
		}
		if _, err := w.Write(f.body); err != nil {
			t.Fatalf("zip write: %v", err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}

	dest := filepath.Join(t.TempDir(), "livekit-server.exe")
	if err := extractLiveKitFromZip(bytes.NewReader(buf.Bytes()), int64(buf.Len()), dest); err != nil {
		t.Fatalf("extractLiveKitFromZip: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("reading extracted binary: %v", err)
	}
	if string(got) != "MZ fake windows binary" {
		t.Errorf("extracted content = %q", got)
	}
}

// serveLiveKitRelease returns an httptest server mimicking the GitHub release
// download layout for the given archive bytes, plus a request counter.
func serveLiveKitRelease(t *testing.T, version string, archive []byte, checksumOverride string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	asset, err := livekitAssetName(version, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skipf("platform unsupported for auto-download: %v", err)
	}
	sum := sha256.Sum256(archive)
	hash := hex.EncodeToString(sum[:])
	if checksumOverride != "" {
		hash = checksumOverride
	}
	var archiveRequests atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v"+version+"/checksums.txt", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", hash, asset)
	})
	mux.HandleFunc("/v"+version+"/"+asset, func(w http.ResponseWriter, _ *http.Request) {
		archiveRequests.Add(1)
		_, _ = w.Write(archive)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &archiveRequests
}

func TestEnsureLiveKitBinary_DownloadsVerifiesAndCaches(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test builds a tar.gz; windows uses the zip path (covered by TestExtractLiveKitFromZip)")
	}
	const version = "9.9.9-test"
	binary := []byte("#!/bin/sh\necho fake livekit\n")
	archive := makeTarGz(t, binary)
	srv, archiveRequests := serveLiveKitRelease(t, version, archive, "")

	oldBase := livekitDownloadBase
	livekitDownloadBase = srv.URL
	defer func() { livekitDownloadBase = oldBase }()

	dataDir := t.TempDir()
	path, err := EnsureLiveKitBinary(context.Background(), dataDir, version)
	if err != nil {
		t.Fatalf("EnsureLiveKitBinary: %v", err)
	}
	want := filepath.Join(dataDir, "livekit", livekitBinaryFilename(version))
	if path != want {
		t.Errorf("path = %q, want %q", path, want)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading binary: %v", err)
	}
	if !bytes.Equal(got, binary) {
		t.Error("extracted binary content mismatch")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm()&0o100 == 0 {
		t.Error("binary is not executable")
	}

	// Second call must hit the cache, not the network.
	if _, err := EnsureLiveKitBinary(context.Background(), dataDir, version); err != nil {
		t.Fatalf("cached EnsureLiveKitBinary: %v", err)
	}
	if n := archiveRequests.Load(); n != 1 {
		t.Errorf("archive downloaded %d times, want 1 (second call must use cache)", n)
	}
}

func TestEnsureLiveKitBinary_ChecksumMismatchRejects(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("tar.gz path")
	}
	const version = "9.9.8-test"
	archive := makeTarGz(t, []byte("evil"))
	srv, _ := serveLiveKitRelease(t, version, archive, strings.Repeat("00", 32))

	oldBase := livekitDownloadBase
	livekitDownloadBase = srv.URL
	defer func() { livekitDownloadBase = oldBase }()

	dataDir := t.TempDir()
	if _, err := EnsureLiveKitBinary(context.Background(), dataDir, version); err == nil {
		t.Fatal("expected checksum mismatch error")
	}
	if _, err := os.Stat(filepath.Join(dataDir, "livekit", livekitBinaryFilename(version))); !os.IsNotExist(err) {
		t.Error("binary staged despite checksum mismatch")
	}
}

func TestEnsureLiveKitBinary_CleansUpOldVersions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("tar.gz path")
	}
	const version = "9.9.7-test"
	archive := makeTarGz(t, []byte("new build"))
	srv, _ := serveLiveKitRelease(t, version, archive, "")

	oldBase := livekitDownloadBase
	livekitDownloadBase = srv.URL
	defer func() { livekitDownloadBase = oldBase }()

	dataDir := t.TempDir()
	lkDir := filepath.Join(dataDir, "livekit")
	if err := os.MkdirAll(lkDir, 0o750); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(lkDir, "livekit-server-1.0.0-old")
	if err := os.WriteFile(stale, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := EnsureLiveKitBinary(context.Background(), dataDir, version); err != nil {
		t.Fatalf("EnsureLiveKitBinary: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale downloaded binary was not cleaned up")
	}
}
