package main

import (
	"archive/zip"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // RFC 6238 names HMAC-SHA1; this is the reference the server is checked against
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// totpPeriodSeconds is the step length of the server's second factor (RFC 6238's default).
const totpPeriodSeconds = 30

// totpDecryptFailedLine is what the server logs when a stored TOTP secret cannot be opened with the key it
// has; it is how the run tells "the key is gone" from "the code was a replay".
const totpDecryptFailedLine = "TOTP secret decryption failed"

// totpStep is the time step a clock reading falls in.
func totpStep(at time.Time) int64 { return at.Unix() / totpPeriodSeconds }

// totpCode is the six-digit RFC 6238 code for a base32 secret. It is written out here on purpose and does not
// call the server's own generator, so the server is not graded by itself.
func totpCode(secret string, at time.Time) (string, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return "", fmt.Errorf("decoding the TOTP secret: %w", err)
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(totpStep(at))) //nolint:gosec // a step is never negative
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1_000_000), nil
}

// secretFromURI reads the secret out of the otpauth URI the enrolment answers with.
func secretFromURI(uri string) (string, error) {
	u, err := url.Parse(uri)
	if err != nil {
		return "", fmt.Errorf("parsing the enrolment URI: %w", err)
	}
	secret := u.Query().Get("secret")
	if secret == "" {
		return "", errors.New("the enrolment URI carries no secret")
	}
	return secret, nil
}

// nextFreshTOTPStep is how long to wait before a code can be a code for a step after lastUsed: zero once the
// clock is past that step's start, otherwise the time until it starts. The restored database keeps the codes
// used before the archive, so a code from the same step would be refused as a replay, and that looks exactly
// like a lost key.
func nextFreshTOTPStep(lastUsed int64, now time.Time) time.Duration {
	start := time.Unix((lastUsed+1)*totpPeriodSeconds, 0)
	if !now.Before(start) {
		return 0
	}
	return start.Sub(now)
}

// archiveCoreFiles are what the owner's guide says to check for before starting a restore.
var archiveCoreFiles = []string{"data/chatserver.db", "data/totp.key", "data/erasure.key", "config.yaml"}

// stripTOTPKey hides the one file the negative leg leaves out.
func stripTOTPKey(name string) bool { return name == "data/totp.key" }

// unpackArchive writes the archive into dest as an owner would: data/ and config.yaml end up side by side.
// Names that could land outside dest are refused up front (the zip file system would quietly clean them
// instead), and the archive must hold the core files; hide, when set, then leaves entries out of the copy.
// dest must not exist yet. Everything written is owner-only afterwards.
func unpackArchive(zipPath, dest string, hide func(name string) bool) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("opening the archive: %w", err)
	}
	defer func() { _ = r.Close() }()
	if err := checkArchiveNames(r.File); err != nil {
		return err
	}
	if err := requireArchiveFiles(r.File); err != nil {
		return err
	}
	var src fs.FS = &r.Reader
	if hide != nil {
		src = hideFS{FS: src, hide: hide}
	}
	if err := os.CopyFS(dest, src); err != nil {
		return fmt.Errorf("unpacking the archive: %w", err)
	}
	if err := tightenModes(dest); err != nil {
		return fmt.Errorf("unpacking the archive: %w", err)
	}
	return nil
}

func checkArchiveNames(files []*zip.File) error {
	for _, f := range files {
		name := strings.TrimSuffix(f.Name, "/")
		if name == "" || !fs.ValidPath(name) || strings.Contains(name, `\`) || !filepath.IsLocal(filepath.FromSlash(name)) {
			return fmt.Errorf("the archive has an entry named %q, which could land outside the install", f.Name)
		}
		if f.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("the archive has a link named %q, which an archive of this server never holds", f.Name)
		}
	}
	return nil
}

func requireArchiveFiles(files []*zip.File) error {
	missing := make([]string, 0, len(archiveCoreFiles))
	for _, want := range archiveCoreFiles {
		if !slices.ContainsFunc(files, func(f *zip.File) bool { return f.Name == want }) {
			missing = append(missing, want)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("the archive does not hold %s", strings.Join(missing, ", "))
	}
	return nil
}

// hideFS is a file system that does not show the names hide picks, in lookups or in listings.
type hideFS struct {
	fs.FS
	hide func(name string) bool
}

func (h hideFS) Open(name string) (fs.File, error) {
	if h.hide(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return h.FS.Open(name)
}

func (h hideFS) ReadDir(name string) ([]fs.DirEntry, error) {
	entries, err := fs.ReadDir(h.FS, name)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(entries, func(e fs.DirEntry) bool { return h.hide(path.Join(name, e.Name())) }), nil
}

// restoredConfigFiles are the two files that could hold a path into the old install.
var restoredConfigFiles = []string{"config.yaml", "data/config-overrides.json"}

// configFilesNaming lists the restored config files that name oldDir. A restored install that points back at
// the old one would pass on data that is not in the archive.
func configFilesNaming(root, oldDir string) ([]string, error) {
	spellings := []string{oldDir, filepath.ToSlash(oldDir), strings.ReplaceAll(oldDir, `\`, `\\`)}
	var hits []string
	for _, rel := range restoredConfigFiles {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("reading the restored %s: %w", rel, err)
		}
		if slices.ContainsFunc(spellings, func(s string) bool { return strings.Contains(string(data), s) }) {
			hits = append(hits, rel)
		}
	}
	return hits, nil
}

// keyEnvNames are the variables that would hand the server a key from the environment instead of the file in
// the archive.
var keyEnvNames = []string{"OWNCORD_TOTP_KEY", "OWNCORD_ERASURE_KEY", "OWNCORD_PUSH_VAPID_KEY"}

// inheritedKeyEnv names the key variables that are set.
func inheritedKeyEnv(lookup func(string) (string, bool)) []string {
	set := make([]string, 0, len(keyEnvNames))
	for _, name := range keyEnvNames {
		if value, ok := lookup(name); ok && value != "" {
			set = append(set, name)
		}
	}
	return set
}

// classifyNegativeLeg decides whether the restore without totp.key proved what it is for: the TOTP check must
// fail, and for the key. A missing totp.key never stops a boot (the server makes a new key), so a refused boot
// is some other fault and fails the leg. A refused sign-in counts only with the decryption line in the log, so
// a replayed code cannot pass for a lost key.
func classifyNegativeLeg(bootRefused, signedIn, sawDecryptLine bool) error {
	switch {
	case bootRefused:
		return errors.New("the restore without totp.key did not boot; a missing key never stops a boot, so something else is wrong")
	case signedIn:
		return errors.New("the TOTP check passed without totp.key, so it proves nothing")
	case !sawDecryptLine:
		return fmt.Errorf("the TOTP check failed without totp.key, but the log has no %q line, so the key may not be the reason", totpDecryptFailedLine)
	}
	return nil
}
