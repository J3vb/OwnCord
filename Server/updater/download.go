package updater

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ValidateDownloadURL ensures the URL points to an expected GitHub release
// asset for this repository.
func (u *Updater) ValidateDownloadURL(url string) error {
	prefix := fmt.Sprintf("https://github.com/%s/%s/releases/download/", u.repoOwner, u.repoName)
	if !strings.HasPrefix(url, prefix) {
		return fmt.Errorf("download URL %q does not match expected prefix %q", url, prefix)
	}
	return nil
}

// DownloadAndVerify downloads the release artifact from downloadURL, fetches
// the checksum file, the detached binary signature, and a signed release
// manifest, and verifies that the downloaded asset matches both the release
// version and the pinned signing key. On Windows the asset is a single
// executable; on Linux it is a tar.gz archive containing a "chatserver"
// binary, which is extracted to destPath. On verification failure the
// downloaded file is removed.
//
// It returns the hex SHA256 of the staged binary at destPath, derived from
// the signed release manifest (on Linux, computed over the extracted bytes of
// the manifest-verified archive). Callers that later execute the staged file
// must re-verify it against this hash through an open handle
// (OpenVerifiedBinary), never by path.
func (u *Updater) DownloadAndVerify(ctx context.Context, latestVersion, downloadURL, checksumURL, signatureURL, manifestURL, manifestSignatureURL, destPath string) (string, error) {
	if err := u.ValidateDownloadURL(downloadURL); err != nil {
		return "", err
	}
	if err := u.ValidateDownloadURL(checksumURL); err != nil {
		return "", fmt.Errorf("validating checksum URL: %w", err)
	}
	if err := u.ValidateDownloadURL(signatureURL); err != nil {
		return "", fmt.Errorf("validating signature URL: %w", err)
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
	signatureData, err := u.fetchBody(ctx, signatureURL)
	if err != nil {
		return "", fmt.Errorf("fetching signature: %w", err)
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
	names := checksumEntryNamesForGOOS(runtime.GOOS)
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

	// Clear a stale staged binary from a previous aborted attempt. Staging is
	// O_EXCL, so anything recreated at this path afterwards fails the download
	// instead of being written through (TOCTOU).
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

	// Verify hash.
	if err := u.VerifyChecksum(destPath, expectedHash); err != nil {
		// Remove the invalid file.
		_ = os.Remove(destPath)
		return "", err
	}
	// The asset is the binary itself, so the manifest-bound hash is the
	// staged binary's trusted hash.
	return expectedHash, nil
}

func (u *Updater) downloadLinuxTarballAndVerify(ctx context.Context, downloadURL, destPath, expectedHash string) (string, error) {
	tarPath := destPath + ".tar.gz.partial"
	_ = os.Remove(tarPath) // clear a stale partial; download stages O_EXCL
	defer func() { _ = os.Remove(tarPath) }()

	if err := u.downloadFile(ctx, downloadURL, tarPath); err != nil {
		return "", fmt.Errorf("downloading archive: %w", err)
	}

	// Open the archive once and do both the checksum and the extraction
	// through this one handle, so the bytes verified are the bytes extracted
	// even if the path is swapped in between (TOCTOU).
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

// extractChatserverFromTarGz extracts the "chatserver" entry from a tar.gz
// stream to destPath and returns the hex SHA256 of the bytes it wrote, so the
// caller gets a trusted hash of the staged binary without a path re-read.
// destPath is created O_EXCL: a pre-existing file (attacker-planted staging
// path) fails the extraction instead of being written through.
func extractChatserverFromTarGz(r io.Reader, destPath string) (string, error) {
	gr, err := gzip.NewReader(r)
	if err != nil {
		return "", fmt.Errorf("gzip: %w", err)
	}
	defer gr.Close() //nolint:errcheck

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return "", fmt.Errorf("archive contains no file named chatserver")
		}
		if err != nil {
			return "", fmt.Errorf("tar: %w", err)
		}
		skipBody := func() error {
			if _, err := io.Copy(io.Discard, io.LimitReader(tr, hdr.Size)); err != nil {
				return err
			}
			return nil
		}
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA {
			if err := skipBody(); err != nil {
				return "", err
			}
			continue
		}
		if strings.Contains(hdr.Name, "..") {
			if err := skipBody(); err != nil {
				return "", err
			}
			continue
		}
		if filepath.Base(hdr.Name) != "chatserver" {
			if err := skipBody(); err != nil {
				return "", err
			}
			continue
		}

		out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
		if err != nil {
			return "", err
		}
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(tr, hdr.Size))
		closeErr := out.Close()
		if copyErr != nil {
			_ = os.Remove(destPath)
			return "", fmt.Errorf("writing binary: %w", copyErr)
		}
		if closeErr != nil {
			_ = os.Remove(destPath)
			return "", closeErr
		}
		if n != hdr.Size {
			_ = os.Remove(destPath)
			return "", fmt.Errorf("incomplete tar entry (%d of %d bytes)", n, hdr.Size)
		}
		return hex.EncodeToString(h.Sum(nil)), nil
	}
}

// serverDownloadAssetName returns the GitHub release asset file name for the
// server binary on the given GOOS (windows, linux). Other values return "".
func serverDownloadAssetName(goos string) string {
	switch goos {
	case "windows":
		return windowsServerBinary
	case "linux":
		return linuxServerArchive
	default:
		return ""
	}
}

// downloadFile downloads the content at url and writes it to destPath.
func (u *Updater) downloadFile(ctx context.Context, url, destPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if u.githubToken != "" && u.shouldSendToken(url) {
		req.Header.Set("Authorization", "token "+u.githubToken)
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d downloading %s", resp.StatusCode, url)
	}

	// O_EXCL: staging paths are predictable (exe + ".new"), so refuse to
	// write through a pre-created file or symlink (TOCTOU). Callers remove
	// stale staged files before downloading.
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

	// Cap download at 500 MiB to prevent unbounded disk usage from a
	// malicious or corrupted release asset.
	const maxBinarySize = 500 * 1024 * 1024
	limitedReader := io.LimitReader(resp.Body, maxBinarySize)

	n, err := io.Copy(f, limitedReader)
	if err != nil {
		_ = f.Close()
		closed = true
		_ = os.Remove(destPath)
		return fmt.Errorf("writing downloaded file: %w", err)
	}
	// Probe for one more byte to detect if the file exceeds the limit.
	if n == maxBinarySize {
		var probe [1]byte
		if extra, _ := resp.Body.Read(probe[:]); extra > 0 {
			_ = f.Close()
			closed = true
			_ = os.Remove(destPath)
			return fmt.Errorf("downloaded file exceeds maximum size of %d bytes", maxBinarySize)
		}
	}

	// Explicitly close and check the error so a disk-full flush failure is
	// not silently swallowed, which would leave a corrupt file on disk.
	if err := f.Close(); err != nil {
		closed = true
		_ = os.Remove(destPath)
		return fmt.Errorf("closing downloaded file: %w", err)
	}
	closed = true
	return nil
}
