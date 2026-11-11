package updater

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/internal/archivebin"
)

// ValidateDownloadURL ensures url is an expected release asset of this repository.
func (u *Updater) ValidateDownloadURL(url string) error {
	prefix := fmt.Sprintf("https://github.com/%s/%s/releases/download/", u.repoOwner, u.repoName)
	if !strings.HasPrefix(url, prefix) {
		return fmt.Errorf("download URL %q does not match expected prefix %q", url, prefix)
	}
	return nil
}

// DownloadAndVerify downloads the release artifact (a Windows executable or a
// Linux tar.gz holding "chatserver", extracted to destPath) and verifies it
// against the checksum file, the detached signature, and the signed manifest's
// version and pinned key; on failure the file is removed. It returns the hex
// SHA256 of the staged binary at destPath. Callers that later execute the file
// must re-verify it against that hash through an open handle (OpenVerifiedBinary), never by path.
func (u *Updater) DownloadAndVerify(ctx context.Context, latestVersion, downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, destPath string) (string, error) {
	if err := u.ValidateDownloadURL(downloadURL); err != nil {
		return "", err
	}
	if err := u.ValidateDownloadURL(checksumURL); err != nil {
		return "", fmt.Errorf("validating checksum URL: %w", err)
	}
	// The detached signature is Windows-only; Linux integrity comes from the signed manifest + checksum.
	needSignature := runtime.GOOS == "windows"
	if needSignature {
		if err := u.ValidateDownloadURL(signatureURL); err != nil {
			return "", fmt.Errorf("validating signature URL: %w", err)
		}
	}
	if err := u.ValidateDownloadURL(manifestURL); err != nil {
		return "", fmt.Errorf("validating manifest URL: %w", err)
	}
	if err := u.ValidateDownloadURL(manifestSignatureURL); err != nil {
		return "", fmt.Errorf("validating manifest signature URL: %w", err)
	}

	checksumData, err := u.fetchBody(ctx, checksumURL)
	if err != nil {
		return "", fmt.Errorf("fetching checksums: %w", err)
	}
	var signatureData []byte
	if needSignature {
		signatureData, err = u.fetchBody(ctx, signatureURL)
		if err != nil {
			return "", fmt.Errorf("fetching signature: %w", err)
		}
	}
	manifestData, err := u.fetchBody(ctx, manifestURL)
	if err != nil {
		return "", fmt.Errorf("fetching release manifest: %w", err)
	}
	manifestSignatureData, err := u.fetchBody(ctx, manifestSignatureURL)
	if err != nil {
		return "", fmt.Errorf("fetching release manifest signature: %w", err)
	}

	assetFilename, err := assetFilenameFromURL(downloadURL)
	if err != nil {
		return "", fmt.Errorf("determining asset filename: %w", err)
	}
	manifest, err := u.VerifyReleaseManifest(manifestData, manifestSignatureData, latestVersion, assetFilename)
	if err != nil {
		return "", err
	}
	names := checksumEntryNamesForGOOS(runtime.GOOS, runtime.GOARCH)
	if len(names) == 0 {
		names = []string{assetFilename}
	}
	expectedHash, err := u.parseChecksumFileAny(checksumData, names...)
	if err != nil {
		return "", fmt.Errorf("parsing checksum file: %w", err)
	}
	if !strings.EqualFold(expectedHash, manifest.SHA256) {
		return "", fmt.Errorf("release manifest checksum mismatch for %s", assetFilename)
	}

	// Clear a stale staged binary; staging is O_EXCL, so a file recreated here
	// afterwards fails the download instead of being written through (TOCTOU).
	_ = os.Remove(destPath)

	goos := runtime.GOOS
	switch goos {
	case "windows":
		return u.downloadWindowsBinaryAndVerify(ctx, downloadURL, destPath, expectedHash, signatureData)
	case "linux":
		return u.downloadLinuxTarballAndVerify(ctx, downloadURL, destPath, expectedHash)
	default:
		return "", fmt.Errorf("server auto-update is not supported on %s", goos)
	}
}

func (u *Updater) downloadWindowsBinaryAndVerify(ctx context.Context, downloadURL, destPath, expectedHash string, signatureData []byte) (string, error) {
	if err := u.downloadFile(ctx, downloadURL, destPath); err != nil {
		return "", fmt.Errorf("downloading binary: %w", err)
	}

	if err := u.VerifySignature(destPath, signatureData); err != nil {
		_ = os.Remove(destPath)
		return "", err
	}

	if err := u.VerifyChecksum(destPath, expectedHash); err != nil {
		_ = os.Remove(destPath)
		return "", err
	}
	// The asset is the binary, so the manifest-bound hash is its trusted hash.
	return expectedHash, nil
}

func (u *Updater) downloadLinuxTarballAndVerify(ctx context.Context, downloadURL, destPath, expectedHash string) (string, error) {
	tarPath := destPath + ".tar.gz.partial"
	_ = os.Remove(tarPath) // clear a stale partial; download stages O_EXCL
	defer func() { _ = os.Remove(tarPath) }()

	if err := u.downloadFile(ctx, downloadURL, tarPath); err != nil {
		return "", fmt.Errorf("downloading archive: %w", err)
	}

	// Checksum and extract through one handle so the verified bytes are the
	// extracted bytes even if the path is swapped (TOCTOU).
	f, err := os.Open(tarPath)
	if err != nil {
		return "", fmt.Errorf("opening archive: %w", err)
	}
	defer f.Close() //nolint:errcheck

	actual, err := readerSHA256(f)
	if err != nil {
		return "", fmt.Errorf("hashing archive: %w", err)
	}
	if !strings.EqualFold(actual, expectedHash) {
		return "", fmt.Errorf("checksum mismatch: expected %s, got %s", expectedHash, actual)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", fmt.Errorf("rewinding archive: %w", err)
	}

	binaryHash, err := extractChatserverFromTarGz(f, destPath)
	if err != nil {
		_ = os.Remove(destPath)
		return "", fmt.Errorf("extracting archive: %w", err)
	}
	if err := os.Chmod(destPath, 0o755); err != nil { //nolint:gosec // G302: binary must be world-executable to run
		return "", fmt.Errorf("chmod binary: %w", err)
	}
	return binaryHash, nil
}

// maxChatserverBytes bounds the staged binary; it only stops a damaged archive filling the disk.
const maxChatserverBytes = 512 << 20

// extractChatserverFromTarGz extracts the "chatserver" entry to destPath and
// returns the SHA256 of the bytes written, so no path re-read is needed.
// destPath is created O_EXCL so an attacker-planted staging file fails instead
// of being written through.
func extractChatserverFromTarGz(r io.Reader, destPath string) (string, error) {
	sum, err := archivebin.FromTarGz(r, destPath, isChatserverEntry, maxChatserverBytes)
	if err != nil {
		return "", fmt.Errorf("chatserver from release archive: %w", err)
	}
	return sum, nil
}

func isChatserverEntry(name string) bool { return filepath.Base(name) == "chatserver" }

// serverDownloadAssetName returns the release asset name for a GOOS/GOARCH, or
// "" for anything but the four published pairs so a foreign-arch binary is never
// installed. Pairs match whole, so adding an asset cannot widen an unrelated one.
func serverDownloadAssetName(goos, goarch string) string {
	switch {
	case goos == "windows" && goarch == "amd64":
		return windowsServerBinary
	case goos == "windows" && goarch == "arm64":
		return windowsServerArm64Binary
	case goos == "linux" && goarch == "amd64":
		return linuxServerArchive
	case goos == "linux" && goarch == "arm64":
		return linuxServerArm64Archive
	default:
		return ""
	}
}

// serverSignatureAssetName returns the Windows-only detached-signature asset
// paired with serverDownloadAssetName's result, or "" (see hasRequiredServerAssetsFor).
func serverSignatureAssetName(goos, goarch string) string {
	if goos != "windows" {
		return ""
	}
	binary := serverDownloadAssetName(goos, goarch)
	if binary == "" {
		return ""
	}
	return binary + ".sig"
}

func (u *Updater) downloadFile(parent context.Context, url, destPath string) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if u.githubToken != "" && u.trustedURL(url) {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.downloadHTTPClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}
	// The body is read under the stall watchdog; the caller's deadline still bounds the download.
	stall := newStallReader(cancel, resp.Body, u.stallTimeout())
	defer stall.stop()
	body := io.Reader(stall)

	// O_EXCL: staging paths are predictable, so refuse to write through a
	// pre-created file or symlink (TOCTOU).
	f, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("creating destination file: %w", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = f.Close()
		}
	}()

	// Cap the download at 500 MiB against a malicious or corrupted asset.
	const maxBinarySize = 500 * 1024 * 1024
	limitedReader := io.LimitReader(body, maxBinarySize)

	n, err := io.Copy(f, limitedReader)
	if err != nil {
		_ = f.Close()
		closed = true
		_ = os.Remove(destPath)
		if stall.stalled() {
			return fmt.Errorf("writing downloaded file: %w", errDownloadStalled)
		}
		return fmt.Errorf("writing downloaded file: %w", err)
	}
	if n == maxBinarySize {
		var probe [1]byte
		if extra, _ := body.Read(probe[:]); extra > 0 {
			_ = f.Close()
			closed = true
			_ = os.Remove(destPath)
			return fmt.Errorf("downloaded file exceeds maximum size of %d bytes", maxBinarySize)
		}
	}

	// Check Close so a disk-full flush failure does not leave a silently corrupt file.
	if err := f.Close(); err != nil {
		closed = true
		_ = os.Remove(destPath)
		return fmt.Errorf("closing downloaded file: %w", err)
	}
	closed = true
	return nil
}

// errDownloadStalled reports a download abandoned after the stall timeout.
var errDownloadStalled = errors.New("download stalled: no data received")

// downloadHTTPClient is the metadata client minus its whole-exchange Timeout,
// which net/http applies to the body and would cut a slow download. It keeps
// the Transport and release-host CheckRedirect; the caller's deadline and the
// stall watchdog bound the body.
func (u *Updater) downloadHTTPClient() *http.Client {
	c := *u.httpClient
	c.Timeout = 0
	return &c
}

func (u *Updater) stallTimeout() time.Duration {
	if u.downloadStallTimeout > 0 {
		return u.downloadStallTimeout
	}
	return defaultDownloadStallTimeout
}

// stallReader cancels the download context when no bytes arrive for d.
type stallReader struct {
	r       io.Reader
	timer   *time.Timer
	d       time.Duration
	fired   atomic.Bool
	stopped atomic.Bool
}

func newStallReader(cancel context.CancelFunc, r io.Reader, d time.Duration) *stallReader {
	s := &stallReader{r: r, d: d}
	s.timer = time.AfterFunc(d, func() {
		s.fired.Store(true)
		cancel()
	})
	return s
}

func (s *stallReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 && !s.stopped.Load() {
		s.timer.Reset(s.d)
	}
	return n, err
}

func (s *stallReader) stop() {
	s.stopped.Store(true)
	s.timer.Stop()
}

func (s *stallReader) stalled() bool { return s.fired.Load() }
