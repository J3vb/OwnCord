package livekitproc

// Auto-download of the companion livekit-server: when voice.auto_download_livekit
// is on and no voice.livekit_binary is set, a pinned release (overridable via
// voice.livekit_version, so a boot never silently takes a new upstream) is
// fetched, checked against checksums.txt and stored under <data_dir>/livekit/.

import (
	"bufio"
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

	"github.com/J3vb/OwnCord/Server/internal/archivebin"
)

// DefaultVersion is the livekit-server release downloaded when voice.livekit_version is unset. Every other
// place pinning it is listed in TestLiveKitPinsAgreeEverywhere (Server/docker_image_test.go); bump them all
// and run it.
const DefaultVersion = "1.13.11"

// livekitDownloadBase is the release URL prefix; a variable so tests can use an httptest server.
var livekitDownloadBase = "https://github.com/livekit/livekit/releases/download"

const (
	// maxLiveKitArchiveSize caps the archive download (the real one is ~40 MB).
	maxLiveKitArchiveSize = 200 * 1024 * 1024
	// maxChecksumsSize caps the checksums.txt download.
	maxChecksumsSize = 1 * 1024 * 1024
)

// livekitAssetName maps GOOS/GOARCH to the release asset name per LiveKit's
// goreleaser config (tar.gz, zip on windows; checksums in "checksums.txt").
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

// livekitBinaryFilename is the versioned stored name, so a bumped pin downloads fresh instead of reusing a
// stale binary.
func livekitBinaryFilename(version string) string {
	name := "livekit-server-" + version
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// EnsureBinary returns the path to a verified livekit-server binary for a
// release version (empty = DefaultVersion), downloading it into <dataDir>/livekit/ if not cached.
func EnsureBinary(ctx context.Context, dataDir, version string) (string, error) {
	version = strings.TrimPrefix(version, "v")
	if version == "" {
		version = DefaultVersion
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

	// Download beside the destination so the rename stays on one filesystem; O_EXCL via downloadTo refuses
	// pre-planted files.
	archivePath := dest + ".download"
	_ = os.Remove(archivePath)
	defer os.Remove(archivePath) //nolint:errcheck // best-effort cleanup

	if err := downloadTo(ctx, base+"/"+asset, archivePath, maxLiveKitArchiveSize); err != nil {
		return "", fmt.Errorf("downloading %s: %w", asset, err)
	}

	// Verify and extract through one handle so the verified bytes are the extracted bytes (TOCTOU).
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

	if err := ensureLiveKitStageBinary(f, size, asset, dest); err != nil {
		return "", err
	}

	cleanupOldLiveKitBinaries(dir, filepath.Base(dest))
	slog.Info("livekit: download complete", "path", dest)
	return dest, nil
}

// ensureLiveKitStageBinary extracts the verified archive f (asset's suffix picks
// zip vs tar.gz) into a temp file beside dest and renames it into place; failure removes the temp file.
func ensureLiveKitStageBinary(f *os.File, size int64, asset, dest string) error {
	tmpBin := dest + ".tmp"
	_ = os.Remove(tmpBin)
	var err error
	if strings.HasSuffix(asset, ".zip") {
		err = extractLiveKitFromZip(f, size, tmpBin)
	} else {
		if _, seekErr := f.Seek(0, io.SeekStart); seekErr != nil {
			return fmt.Errorf("rewinding archive: %w", seekErr)
		}
		err = extractLiveKitFromTarGz(f, tmpBin)
	}
	if err != nil {
		_ = os.Remove(tmpBin)
		return fmt.Errorf("extracting %s: %w", asset, err)
	}
	if err := os.Chmod(tmpBin, 0o755); err != nil { //nolint:gosec // G302: must be executable
		_ = os.Remove(tmpBin)
		return fmt.Errorf("chmod binary: %w", err)
	}
	if err := os.Rename(tmpBin, dest); err != nil {
		_ = os.Remove(tmpBin)
		return fmt.Errorf("staging binary: %w", err)
	}
	return nil
}

// livekitBinaryEntry reports whether an archive entry is the top-level livekit-server binary.
func livekitBinaryEntry(name string) bool {
	base := filepath.Base(filepath.ToSlash(name))
	return base == "livekit-server" || base == "livekit-server.exe"
}

// maxLiveKitBytes bounds the staged binary; it only stops a damaged archive filling the disk.
const maxLiveKitBytes = 512 << 20

// extractLiveKitFromTarGz extracts the livekit-server entry to destPath
// (created O_EXCL so a pre-planted file fails the extraction).
func extractLiveKitFromTarGz(r io.Reader, destPath string) error {
	if _, err := archivebin.FromTarGz(r, destPath, livekitBinaryEntry, maxLiveKitBytes); err != nil {
		return fmt.Errorf("livekit-server from archive: %w", err)
	}
	return nil
}

// extractLiveKitFromZip extracts the livekit-server entry to destPath
// (created O_EXCL). r must be positioned over the verified archive bytes.
func extractLiveKitFromZip(r io.ReaderAt, size int64, destPath string) error {
	if _, err := archivebin.FromZip(r, size, destPath, livekitBinaryEntry, maxLiveKitBytes); err != nil {
		return fmt.Errorf("livekit-server from archive: %w", err)
	}
	return nil
}

// parseChecksumLine finds filename's sha256 in a goreleaser-style checksums file.
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

// cleanupOldLiveKitBinaries best-effort removes downloaded versions other than keep.
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
