package ws

// Auto-download of the companion livekit-server binary.
//
// When voice.auto_download_livekit is enabled and no voice.livekit_binary is
// configured, the server fetches a pinned livekit-server release from the
// official LiveKit GitHub releases, verifies it against the release's
// checksums.txt, and stores it under <data_dir>/livekit/. The version is
// pinned (overridable via voice.livekit_version) so a boot never silently
// picks up a new upstream release.

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DefaultLiveKitVersion is the livekit-server release the server downloads
// when voice.livekit_version is not set. Bump deliberately with releases.
const DefaultLiveKitVersion = "1.13.5"

// livekitDownloadBase is the release download URL prefix. Package variable so
// tests can point it at a local httptest server.
var livekitDownloadBase = "https://github.com/livekit/livekit/releases/download"

const (
	// maxLiveKitArchiveSize caps the archive download (the real archive is
	// ~40 MB compressed).
	maxLiveKitArchiveSize = 200 * 1024 * 1024
	// maxChecksumsSize caps the checksums.txt download.
	maxChecksumsSize = 1 * 1024 * 1024
)

// livekitAssetName maps GOOS/GOARCH to the release asset file name, following
// LiveKit's goreleaser config (linux/windows on amd64/arm64/armv7; archives
// are tar.gz except zip on windows; checksum file is "checksums.txt").
func livekitAssetName(version, goos, goarch string) (string, error) {
	var arch string
	switch goarch {
	case "amd64", "arm64":
		arch = goarch
	case "arm":
		arch = "armv7"
	default:
		return "", fmt.Errorf("livekit auto-download does not support architecture %s — set voice.livekit_binary to a livekit-server binary you provide", goarch)
	}
	switch goos {
	case "linux":
		return fmt.Sprintf("livekit_%s_linux_%s.tar.gz", version, arch), nil
	case "windows":
		return fmt.Sprintf("livekit_%s_windows_%s.zip", version, arch), nil
	default:
		return "", fmt.Errorf("livekit auto-download does not support OS %s — set voice.livekit_binary to a livekit-server binary you provide", goos)
	}
}

// livekitBinaryFilename is the versioned name the extracted binary is stored
// under. Embedding the version means a bumped pin downloads fresh instead of
// reusing a stale cached binary.
func livekitBinaryFilename(version string) string {
	name := "livekit-server-" + version
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// EnsureLiveKitBinary returns the path to a verified livekit-server binary
// for the given release version (empty = DefaultLiveKitVersion), downloading
// and extracting it into <dataDir>/livekit/ if it is not already cached.
func EnsureLiveKitBinary(ctx context.Context, dataDir, version string) (string, error) {
	version = strings.TrimPrefix(version, "v")
	if version == "" {
		version = DefaultLiveKitVersion
	}
	asset, err := livekitAssetName(version, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}

	dir := filepath.Join(dataDir, "livekit")
	dest := filepath.Join(dir, livekitBinaryFilename(version))
	if info, statErr := os.Stat(dest); statErr == nil && info.Mode().IsRegular() && info.Size() > 0 {
		return dest, nil
	}

	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("creating livekit dir: %w", err)
	}

	base := livekitDownloadBase + "/v" + version
	slog.Info("livekit: downloading livekit-server (one-time)", "version", version, "asset", asset)

	sums, err := fetchLimited(ctx, base+"/checksums.txt", maxChecksumsSize)
	if err != nil {
		return "", fmt.Errorf("fetching livekit checksums: %w", err)
	}
	expectedHash, err := parseChecksumLine(sums, asset)
	if err != nil {
		return "", err
	}

	// Download the archive next to the destination so the final rename stays
	// on one filesystem. O_EXCL via downloadTo refuses pre-planted files.
	archivePath := dest + ".download"
	_ = os.Remove(archivePath)
	defer os.Remove(archivePath) //nolint:errcheck // best-effort cleanup

	if err := downloadTo(ctx, base+"/"+asset, archivePath, maxLiveKitArchiveSize); err != nil {
		return "", fmt.Errorf("downloading %s: %w", asset, err)
	}

	// Verify and extract through one open handle so the bytes verified are
	// the bytes extracted even if the path is swapped in between (TOCTOU).
	f, err := os.Open(archivePath) //nolint:gosec // G304: path constructed from trusted config
	if err != nil {
		return "", fmt.Errorf("opening archive: %w", err)
	}
	defer f.Close() //nolint:errcheck

	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return "", fmt.Errorf("hashing archive: %w", err)
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expectedHash) {
		return "", fmt.Errorf("livekit archive checksum mismatch for %s: expected %s, got %s", asset, expectedHash, actual)
	}

	tmpBin := dest + ".tmp"
	_ = os.Remove(tmpBin)
	if strings.HasSuffix(asset, ".zip") {
		err = extractLiveKitFromZip(f, size, tmpBin)
	} else {
		if _, seekErr := f.Seek(0, io.SeekStart); seekErr != nil {
			return "", fmt.Errorf("rewinding archive: %w", seekErr)
		}
		err = extractLiveKitFromTarGz(f, tmpBin)
	}
	if err != nil {
		_ = os.Remove(tmpBin)
		return "", fmt.Errorf("extracting %s: %w", asset, err)
	}
	if err := os.Chmod(tmpBin, 0o755); err != nil { //nolint:gosec // G302: must be executable
		_ = os.Remove(tmpBin)
		return "", fmt.Errorf("chmod binary: %w", err)
	}
	if err := os.Rename(tmpBin, dest); err != nil {
		_ = os.Remove(tmpBin)
		return "", fmt.Errorf("staging binary: %w", err)
	}

	cleanupOldLiveKitBinaries(dir, filepath.Base(dest))
	slog.Info("livekit: download complete", "path", dest)
	return dest, nil
}

// livekitBinaryEntry reports whether an archive entry name is the
// livekit-server binary (archives contain it at the top level plus LICENSE).
func livekitBinaryEntry(name string) bool {
	base := filepath.Base(filepath.ToSlash(name))
	return base == "livekit-server" || base == "livekit-server.exe"
}

// extractLiveKitFromTarGz extracts the livekit-server entry to destPath
// (created O_EXCL so a pre-planted file fails the extraction).
func extractLiveKitFromTarGz(r io.Reader, destPath string) error {
	gr, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gr.Close() //nolint:errcheck

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("archive contains no livekit-server binary")
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg || strings.Contains(hdr.Name, "..") || !livekitBinaryEntry(hdr.Name) {
			continue
		}
		return writeExact(destPath, io.LimitReader(tr, hdr.Size), hdr.Size)
	}
}

// extractLiveKitFromZip extracts the livekit-server entry to destPath
// (created O_EXCL). r must be positioned over the verified archive bytes.
func extractLiveKitFromZip(r io.ReaderAt, size int64, destPath string) error {
	zr, err := zip.NewReader(r, size)
	if err != nil {
		return fmt.Errorf("zip: %w", err)
	}
	for _, entry := range zr.File {
		if entry.FileInfo().IsDir() || strings.Contains(entry.Name, "..") || !livekitBinaryEntry(entry.Name) {
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			return fmt.Errorf("opening zip entry: %w", err)
		}
		//nolint:gosec // G110: size is bounded by the verified archive's cap
		writeErr := writeExact(destPath, rc, int64(entry.UncompressedSize64)) //nolint:gosec // G115: size fits int64
		_ = rc.Close()
		return writeErr
	}
	return fmt.Errorf("archive contains no livekit-server binary")
}

// writeExact writes exactly size bytes from r to destPath, O_EXCL.
func writeExact(destPath string, r io.Reader, size int64) error {
	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600) //nolint:gosec // G304: trusted path
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, r)
	closeErr := out.Close()
	if copyErr != nil {
		return fmt.Errorf("writing binary: %w", copyErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if n != size {
		return fmt.Errorf("incomplete archive entry (%d of %d bytes)", n, size)
	}
	return nil
}

// parseChecksumLine finds the sha256 for filename in a goreleaser-style
// checksums file ("<hex>  <filename>" per line).
func parseChecksumLine(data []byte, filename string) (string, error) {
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && fields[1] == filename && len(fields[0]) == 64 {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("no checksum entry for %s", filename)
}

// fetchLimited GETs url and returns at most limit bytes, erroring beyond it.
func fetchLimited(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("response exceeds %d bytes", limit)
	}
	return data, nil
}

// downloadTo streams url to destPath (O_EXCL), capped at limit bytes.
func downloadTo(ctx context.Context, url, destPath string, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}

	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600) //nolint:gosec // G304: trusted path
	if err != nil {
		return fmt.Errorf("creating download file: %w", err)
	}
	n, copyErr := io.Copy(out, io.LimitReader(resp.Body, limit))
	if copyErr == nil && n == limit {
		// Probe one more byte to distinguish exactly-at-limit from over-limit.
		var probe [1]byte
		if extra, _ := resp.Body.Read(probe[:]); extra > 0 {
			copyErr = fmt.Errorf("download exceeds maximum size of %d bytes", limit)
		}
	}
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return fmt.Errorf("closing download: %w", closeErr)
	}
	return nil
}

// cleanupOldLiveKitBinaries best-effort removes previously downloaded
// livekit-server versions other than keep.
func cleanupOldLiveKitBinaries(dir, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		if e.Type().IsRegular() && strings.HasPrefix(name, "livekit-server-") && name != keep &&
			!strings.HasSuffix(name, ".download") && !strings.HasSuffix(name, ".tmp") {
			if rmErr := os.Remove(filepath.Join(dir, name)); rmErr == nil {
				slog.Info("livekit: removed old downloaded binary", "name", name)
			}
		}
	}
}
