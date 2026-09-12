package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// The fixture turns a bare server into an install an owner would recognise —
// an owner account, an uploaded attachment, a database backup — because
// "the new binary boots" is not the question B6-8 asks. The question is
// whether an upgrade preserves what was already there, and nothing that a
// cold boot creates by itself can answer it.

const (
	// fixtureUser and fixturePassword go through POST /admin/api/setup, which
	// enforces auth.ValidatePasswordStrength (8-72 bytes). These are the
	// credentials of a throwaway server in a temporary directory that is
	// deleted at the end of the run; they are not a secret.
	fixtureUser     = "rehearsal-owner"
	fixturePassword = "rehearsal-passphrase" //nolint:gosec // throwaway account on a temp-dir server, deleted with it

	// fixturePayloadSize is deliberately larger than one filesystem block, so
	// a truncated or partially copied attachment shows up as a digest
	// mismatch rather than fitting inside a single write that either happens
	// or does not.
	fixturePayloadSize = 64 * 1024
	fixtureFilename    = "rehearsal-attachment.bin"

	// fixtureTimeout bounds every call. Without it a server that accepted the
	// connection and then stopped answering would hang the whole rehearsal
	// instead of failing the phase that hung.
	fixtureTimeout = 30 * time.Second
)

// credentialFiles are the on-disk secrets that live beside the database and
// are NOT inside a database backup: losing one is silent at boot and only
// surfaces later as "every TOTP enrolment is invalid" or "push stopped".
// Kept in slash form because they are also the names printed in a failure.
var credentialFiles = []string{
	"data/totp.key",
	"data/erasure.key",
	"data/push_vapid.key",
}

// fixtureClient talks to the server this harness launched moments ago on
// loopback.
//
// The generated certificate carries no SANs at all (Server/auth/tls.go), so
// no RootCAs pool can verify it. This client talks to a server this harness
// just launched on loopback; there is nothing to be MITM'd by.
var fixtureClient = &http.Client{
	Timeout: fixtureTimeout,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402
	},
}

// fixture is what installFixture left behind: what a later phase needs to
// speak to the same install as the same owner.
type fixture struct {
	// token is the PRE-upgrade session token, re-used deliberately after the
	// upgrade: "authenticated downloads still work afterwards" is only a real
	// assertion if the session that was open before the upgrade is the one
	// making the request.
	token string
	// attachmentID is both the /api/v1/files/{id} path segment and the file
	// name under data/uploads (Server/storage saves under the id verbatim).
	attachmentID string
}

// The rehearsal phases that call these land in B6-8 Task 3. Until then
// nothing in the package references them and `unused` reports every function
// the fixture is built from; these two entry points are what Task 3 calls, so
// wiring the phases up deletes this block.
var (
	_ = installFixture
	_ = captureState
)

// installFixture populates a freshly booted server. It runs against the OLD
// version, so everything it creates is state the upgrade has to carry over.
func installFixture(baseURL string) (fixture, error) {
	token, err := runSetup(baseURL)
	if err != nil {
		return fixture{}, err
	}
	id, err := uploadAttachment(baseURL, token)
	if err != nil {
		return fixture{}, err
	}
	// A backup taken before the upgrade is the artefact the rollback recipe
	// tells owners to take, so the rehearsal has to prove the upgrade keeps
	// it rather than sweeping it.
	if err := request(http.MethodPost, baseURL+"/admin/api/backup", token, "", nil, http.StatusOK, nil); err != nil {
		return fixture{}, fmt.Errorf("creating a database backup: %w", err)
	}
	fmt.Printf("fixture: owner %q, attachment %s, one database backup\n", fixtureUser, id)
	return fixture{token: token, attachmentID: id}, nil
}

// runSetup creates the owner account through the first-run wizard.
func runSetup(baseURL string) (string, error) {
	// Wizard fields that live in config.yaml — port, tls_mode, tls_domain,
	// upload_max_size_mb, voice_quality, voice_auto_download — are
	// deliberately omitted. Setting any of them makes the server restart
	// itself right after this response (restart_required) and rewrite the
	// very file whose hash the rehearsal compares, so the fixture would be
	// mutating the thing under test and racing a restart while doing it.
	body, err := json.Marshal(map[string]any{
		"username": fixtureUser,
		"password": fixturePassword,
		"wizard": map[string]any{
			"server_name": "Upgrade Rehearsal",
			"motd":        "rehearsal fixture",
		},
	})
	if err != nil {
		return "", err
	}
	var resp struct {
		Token           string `json:"token"`
		RestartRequired bool   `json:"restart_required"`
	}
	if err := request(http.MethodPost, baseURL+"/admin/api/setup", "", "application/json",
		bytes.NewReader(body), http.StatusCreated, &resp); err != nil {
		return "", fmt.Errorf("creating the owner account: %w", err)
	}
	if resp.RestartRequired {
		return "", errors.New("setup reported restart_required: the fixture must never trigger one, " +
			"because the restart rewrites config.yaml — the file the rehearsal compares — mid-fixture")
	}
	if resp.Token == "" {
		return "", errors.New("setup returned 201 with no session token")
	}
	return resp.Token, nil
}

// uploadAttachment stores the fixed payload and returns the attachment id.
func uploadAttachment(baseURL, token string) (string, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", fixtureFilename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(fixturePayload()); err != nil {
		return "", err
	}
	if err := mw.Close(); err != nil {
		return "", err
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := request(http.MethodPost, baseURL+"/api/v1/uploads", token, mw.FormDataContentType(),
		&body, http.StatusCreated, &resp); err != nil {
		return "", fmt.Errorf("uploading the fixture attachment: %w", err)
	}
	if resp.ID == "" {
		return "", errors.New("upload returned 201 with no attachment id")
	}
	return resp.ID, nil
}

// fixturePayload is a fixed pattern rather than random bytes, and that is the
// whole point: the pre-upgrade and post-upgrade digests must only ever differ
// because the upgrade lost or mangled the file. crypto/rand here would make
// them differ for a reason that has nothing to do with the upgrade.
func fixturePayload() []byte {
	b := make([]byte, fixturePayloadSize)
	for i := range b {
		b[i] = byte(i * 7 % 251)
	}
	return b
}

// request issues one call and decodes a JSON response into out (nil to
// discard it). Every fixture step goes through here so that a non-2xx is
// reported with the server's own error body — the reason — instead of
// surfacing three lines later as a decode failure.
func request(method, url, token, contentType string, body io.Reader, wantStatus int, out any) error {
	req, err := http.NewRequest(method, url, body) //nolint:noctx // the client's own Timeout bounds every call
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != wantStatus {
		// Cap the echoed body: an HTML error page from something other than
		// the API would otherwise bury the CI annotation.
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s %s: got %s, want %d: %s", method, url, resp.Status, wantStatus, bytes.TrimSpace(detail))
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("%s %s: decoding the response: %w", method, url, err)
	}
	return nil
}

// download is the attachment fetched back through the API, rather than read
// off disk: a file that survived the upgrade on disk but can no longer be
// served is still a broken install.
type download struct {
	id     string
	digest string
	length int
}

// state is one capture of everything the upgrade milestone promises to
// preserve: data, attachments, configuration, credentials and backups, plus
// the download that proves the pre-upgrade session still works.
//
// Digests rather than contents, so a failure prints a name and two hashes
// instead of a megabyte of SQLite.
type state struct {
	config string // SHA-256 of config.yaml
	// keys maps a credentialFiles entry to its SHA-256. A file that does not
	// exist has NO entry — absence is a distinct outcome from a digest,
	// because "was there and is gone" and "was never there" mean opposite
	// things about an upgrade (see compare).
	keys map[string]string
	// uploads maps a path relative to data/uploads (slash form) to its
	// SHA-256, keyed by path so a lost file can be named rather than counted.
	uploads  map[string]string
	backups  []string // names only: size and date do not survive a copy unchanged
	download download
	version  string // as reported by the running server
}

// captureState reads the install at dir and interrogates the server serving
// it. dir is the install directory (config.yaml at its root, data/ beneath).
//
// attachmentID is passed in rather than discovered: it comes from the fixture
// that ran against the OLD version, so re-fetching it after the upgrade asks
// the question the milestone asks — is the attachment I uploaded before still
// downloadable — rather than "is some attachment downloadable".
func captureState(dir, baseURL, token, attachmentID string) (state, error) {
	s := state{keys: map[string]string{}, uploads: map[string]string{}}

	var err error
	if s.config, err = hashFile(filepath.Join(dir, "config.yaml")); err != nil {
		return state{}, fmt.Errorf("hashing config.yaml: %w", err)
	}
	for _, name := range credentialFiles {
		digest, hashErr := hashFile(filepath.Join(dir, filepath.FromSlash(name)))
		switch {
		case errors.Is(hashErr, fs.ErrNotExist):
			continue // recorded as absent by having no entry
		case hashErr != nil:
			return state{}, fmt.Errorf("hashing %s: %w", name, hashErr)
		}
		s.keys[name] = digest
	}
	if s.uploads, err = hashUploads(filepath.Join(dir, "data", "uploads")); err != nil {
		return state{}, err
	}
	if s.backups, err = listBackups(baseURL, token); err != nil {
		return state{}, err
	}
	if s.download, err = fetchAttachment(baseURL, token, attachmentID); err != nil {
		return state{}, err
	}
	if s.version, err = reportedVersion(baseURL, token); err != nil {
		return state{}, err
	}
	return s, nil
}

// hashUploads digests every file under root, keyed by its path relative to
// root. A missing directory is not an error here: it yields an empty map, and
// compare then names each upload that went missing instead of failing with a
// single opaque "no such directory".
func hashUploads(root string) (map[string]string, error) {
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil
		case err != nil:
			return err
		case d.IsDir():
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		digest, err := hashFile(path)
		if err != nil {
			return err
		}
		out[filepath.ToSlash(rel)] = digest
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("hashing data/uploads: %w", err)
	}
	return out, nil
}

func listBackups(baseURL, token string) ([]string, error) {
	var entries []struct {
		Name string `json:"name"`
	}
	if err := request(http.MethodGet, baseURL+"/admin/api/backups", token, "", nil, http.StatusOK, &entries); err != nil {
		return nil, fmt.Errorf("listing backups: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name)
	}
	slices.Sort(names)
	return names, nil
}

// fetchAttachment re-downloads the attachment with the caller's token. The
// body is hashed rather than kept: 64 KiB per capture is not worth holding,
// and a digest plus a length names every way it could come back wrong.
func fetchAttachment(baseURL, token, id string) (download, error) {
	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/v1/files/"+id, nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return download{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return download{}, fmt.Errorf("downloading attachment %s: %w", id, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return download{}, fmt.Errorf("downloading attachment %s: got %s, want 200", id, resp.Status)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return download{}, fmt.Errorf("downloading attachment %s: %w", id, err)
	}
	return download{id: id, digest: fmt.Sprintf("%x", sha256.Sum256(data)), length: len(data)}, nil
}

// reportedVersion asks the only endpoint that reports the running version on
// both alpha.4 and HEAD. The version is what makes "the upgrade happened" an
// assertion rather than an assumption.
func reportedVersion(baseURL, token string) (string, error) {
	var diag struct {
		Server struct {
			Version string `json:"version"`
		} `json:"server"`
	}
	if err := request(http.MethodGet, baseURL+"/api/v1/diagnostics/connectivity", token, "", nil, http.StatusOK, &diag); err != nil {
		return "", fmt.Errorf("reading the reported version: %w", err)
	}
	if diag.Server.Version == "" {
		return "", errors.New("the connectivity diagnostics reported an empty server version")
	}
	return diag.Server.Version, nil
}

// compare asserts that everything recorded in before survived into after,
// byte for byte, naming whatever did not. It deliberately does NOT assert the
// reverse: an item present only in after is new, and is printed as an
// informational line instead of failing the rehearsal.
//
// The reason is concrete. alpha.4 contains no Server/auth/erasure_key.go and
// no Server/auth/push_vapid_key.go at all, so HEAD legitimately creates
// data/erasure.key, data/push_vapid.key and data/erasure/markers.sqlite on
// its first boot. Byte-equality would fail the rehearsal for a newer server
// doing exactly what it should. The milestone is "nothing was lost", not
// "nothing was added" — and a lost or mutated item still fails, which is the
// assertion with teeth.
//
// The version is NOT compared here: the upgrade phase expects it to differ
// and the rollback phase expects it to match, so the caller asserts it in
// whichever direction its own phase needs.
func compare(before, after state) error {
	problems := make([]error, 0, 4)
	if before.config != after.config {
		problems = append(problems, fmt.Errorf("config.yaml changed: %s -> %s", before.config, after.config))
	}
	problems = append(problems, lostOrChanged("credential file", before.keys, after.keys)...)
	problems = append(problems, lostOrChanged("upload", before.uploads, after.uploads)...)
	for _, name := range before.backups {
		if !slices.Contains(after.backups, name) {
			problems = append(problems, fmt.Errorf("backup %s is gone from the backup list", name))
		}
	}
	if before.download != after.download {
		problems = append(problems, fmt.Errorf(
			"the download of attachment %s changed: %s (%d bytes) -> %s (%d bytes)",
			before.download.id, before.download.digest, before.download.length,
			after.download.digest, after.download.length))
	}
	if line := additions(before, after); line != "" {
		fmt.Println(line)
	}
	return errors.Join(problems...)
}

// lostOrChanged reports every entry of before that after has lost or altered.
// Sorted, so the same divergence prints the same way on every run.
func lostOrChanged(kind string, before, after map[string]string) []error {
	problems := make([]error, 0, len(before))
	for _, name := range slices.Sorted(maps.Keys(before)) {
		switch got, ok := after[name]; {
		case !ok:
			problems = append(problems, fmt.Errorf("%s %s is gone", kind, name))
		case got != before[name]:
			problems = append(problems, fmt.Errorf("%s %s changed: %s -> %s", kind, name, before[name], got))
		}
	}
	return problems
}

// additions is the other half of the asymmetry compare documents: what the
// newer version created that the older one never had. Informational, never a
// failure — returns "" when there is nothing to say.
func additions(before, after state) string {
	added := slices.Concat(
		onlyIn("credential file", before.keys, after.keys),
		onlyIn("upload", before.uploads, after.uploads),
	)
	for _, name := range after.backups {
		if !slices.Contains(before.backups, name) {
			added = append(added, "backup "+name)
		}
	}
	if len(added) == 0 {
		return ""
	}
	slices.Sort(added)
	return "the upgrade added: " + strings.Join(added, ", ")
}

func onlyIn(kind string, before, after map[string]string) []string {
	var names []string
	for name := range after {
		if _, ok := before[name]; !ok {
			names = append(names, kind+" "+name)
		}
	}
	return names
}
