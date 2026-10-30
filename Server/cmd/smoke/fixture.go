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

// The fixture turns a bare server into an install an owner would recognise
// (an owner, an attachment, a backup), because the upgrade question is whether
// what was already there is preserved, which a cold boot cannot answer.

const (
	// fixtureUser and fixturePassword go through POST /admin/api/setup, which
	// enforces auth.ValidatePasswordStrength (8-72 bytes); a throwaway server
	// in a temporary directory, not a secret.
	fixtureUser     = "rehearsal-owner"
	fixturePassword = "rehearsal-passphrase" //nolint:gosec // throwaway account on a temp-dir server, deleted with it

	// fixturePayloadSize exceeds one filesystem block, so a truncated or
	// partial copy shows as a digest mismatch.
	fixturePayloadSize = 64 * 1024
	fixtureFilename    = "rehearsal-attachment.bin"

	// fixturePayloadDigest is sha256(fixturePayload()), pinned as a literal:
	// recomputing it would make every assertion agree with whatever
	// fixturePayload returns.
	fixturePayloadDigest = "de3f3404598736bd6abece44ed40b347febf99becf1a476f0d18fdc9a32a6166"

	// fixtureTimeout bounds every call, so a server that stopped answering
	// fails the phase instead of hanging the rehearsal.
	fixtureTimeout = 30 * time.Second
)

// credentialFiles are the on-disk secrets beside the database that are not in
// a backup: losing one is silent at boot and surfaces later as "every TOTP
// enrolment is invalid" or "push stopped". Slash form, as printed in failures.
var credentialFiles = []string{
	"data/totp.key",
	"data/erasure.key",
	"data/push_vapid.key",
}

// The generated certificate carries no SANs (Server/auth/tls.go), so no
// RootCAs pool can verify it; this client talks only to a server this harness
// launched on loopback.
var fixtureClient = &http.Client{
	Timeout: fixtureTimeout,
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402
	},
}

// fixture is what installFixture left behind: what a later phase needs to
// speak to the same install as the same owner.
type fixture struct {
	// token is the pre-upgrade session token, reused after the upgrade so
	// "authenticated downloads still work" is a real assertion.
	//
	// It is also how "the database survived" is asserted: data/chatserver.db is
	// not hashed (WAL churn and forward migrations rewrite it by design), but
	// this token authenticating after the swap proves the session row, user and
	// schema came out of the pre-upgrade database. A recreated database would
	// 401 every call captureState makes.
	token string
	// attachmentID is the /api/v1/files/{id} path segment and the file name
	// under data/uploads (Server/storage saves under the id verbatim).
	attachmentID string
	// backupName is the backup created before the upgrade, so the first capture
	// can be checked for it.
	backupName string
}

// installFixture populates a freshly booted server running the old version, so
// everything it creates is state the upgrade has to carry over.
func installFixture(baseURL, serverLog string) (fixture, error) {
	token, err := runSetup(baseURL, serverLog)
	if err != nil {
		return fixture{}, err
	}
	id, err := uploadAttachment(baseURL, token)
	if err != nil {
		return fixture{}, err
	}
	backup, err := createBackup(baseURL, token)
	if err != nil {
		return fixture{}, err
	}
	// Prove the attachment round-trips now, on the version that stored it:
	// compare() is only a delta, so a download already wrong before the upgrade
	// would pass.
	got, err := fetchAttachment(baseURL, token, id)
	if err != nil {
		return fixture{}, err
	}
	if got.digest != fixturePayloadDigest || got.length != fixturePayloadSize {
		return fixture{}, fmt.Errorf(
			"the fixture attachment does not round-trip: downloaded %s (%d bytes), uploaded %s (%d bytes)",
			got.digest, got.length, fixturePayloadDigest, fixturePayloadSize)
	}
	fmt.Printf("fixture: owner %q, attachment %s, backup %s\n", fixtureUser, id, backup)
	return fixture{token: token, attachmentID: id, backupName: backup}, nil
}

// createBackup takes the backup the rollback recipe tells owners to take and
// returns its name. The list is read back and must contain it: otherwise a 200
// that produced no file would leave the first capture with no backups and
// "every backup survived" would hold vacuously.
func createBackup(baseURL, token string) (string, error) {
	var created struct {
		Path string `json:"path"`
	}
	if err := request(http.MethodPost, baseURL+"/admin/api/backup", token, "", nil, http.StatusOK, &created); err != nil {
		return "", fmt.Errorf("creating a database backup: %w", err)
	}
	if created.Path == "" {
		return "", errors.New("the backup endpoint returned 200 with no name")
	}
	names, err := listBackups(baseURL, token)
	if err != nil {
		return "", err
	}
	if !slices.Contains(names, created.Path) {
		return "", fmt.Errorf("backup %s was reported as created but is not in the backup list %v", created.Path, names)
	}
	return created.Path, nil
}

// runSetup creates the owner account through the first-run wizard, with the
// setup token found in the server's start-up output.
func runSetup(baseURL, serverLog string) (string, error) {
	// Wizard fields that live in config.yaml (port, tls_mode, tls_domain,
	// upload_max_size_mb, voice_quality, voice_auto_download) are omitted:
	// setting one restarts the server and rewrites the file whose hash the
	// rehearsal compares.
	body, err := json.Marshal(map[string]any{
		"username":    fixtureUser,
		"password":    fixturePassword,
		"setup_token": setupTokenIn(serverLog),
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

// multipartUpload builds the fixture attachment request body and content type.
// The drill phases need the same bytes as a request whose non-2xx status is
// the assertion (phase D expects 507), which request() would report as a
// failure; sharing it stops the two uploads drifting apart.
func multipartUpload() ([]byte, string, error) {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, err := mw.CreateFormFile("file", fixtureFilename)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(fixturePayload()); err != nil {
		return nil, "", err
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return body.Bytes(), mw.FormDataContentType(), nil
}

// uploadAttachment stores the fixed payload and returns the attachment id.
func uploadAttachment(baseURL, token string) (string, error) {
	body, contentType, err := multipartUpload()
	if err != nil {
		return "", err
	}
	var resp struct {
		ID string `json:"id"`
	}
	if err := request(http.MethodPost, baseURL+"/api/v1/uploads", token, contentType,
		bytes.NewReader(body), http.StatusCreated, &resp); err != nil {
		return "", fmt.Errorf("uploading the fixture attachment: %w", err)
	}
	if resp.ID == "" {
		return "", errors.New("upload returned 201 with no attachment id")
	}
	return resp.ID, nil
}

// fixturePayload is a fixed pattern, not random bytes, so pre- and post-upgrade
// digests differ only if the upgrade lost or mangled the file.
func fixturePayload() []byte {
	b := make([]byte, fixturePayloadSize)
	for i := range b {
		b[i] = byte(i * 7 % 251)
	}
	return b
}

// request issues one call and decodes a JSON response into out (nil to
// discard it). A non-2xx is reported with the server's own error body instead
// of surfacing later as a decode failure.
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
		// Cap the echoed body so an HTML error page does not bury the CI
		// annotation.
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

// download is the attachment fetched back through the API: a file that
// survived on disk but can no longer be served is still a broken install.
type download struct {
	id     string
	digest string
	length int
}

// state is one capture of everything the upgrade promises to preserve: data,
// attachments, configuration, credentials and backups, plus the download that
// proves the pre-upgrade session still works. Digests rather than contents, so
// a failure prints a name and two hashes.
type state struct {
	config string // SHA-256 of config.yaml
	// keys maps a credentialFiles entry to its SHA-256. A missing file has no
	// entry: "was there and is gone" and "never there" mean opposite things
	// about an upgrade (see compare).
	keys map[string]string
	// uploads maps a path relative to data/uploads (slash form) to its
	// SHA-256, so a lost file is named rather than counted.
	uploads  map[string]string
	backups  []string // names only: size and date do not survive a copy unchanged
	download download
	version  string // as reported by the running server
}

// captureState reads the install at dir (config.yaml at its root, data/
// beneath) and interrogates the server serving it. attachmentID comes from the
// fixture on the old version, so the question is whether the attachment
// uploaded before is still downloadable, not whether some attachment is.
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

// anchor checks the first capture against what installFixture created.
// compare() is only a delta, so two equally wrong captures (an empty backup
// list, uploads read from the wrong directory, an already-broken download)
// would make "nothing was lost" true over nothing; anchoring gives the delta
// something to be a delta of.
func (f fixture) anchor(s state) error {
	problems := make([]error, 0, 4)
	// The credential branch of compare() can go vacuous without a trace: it
	// iterates before.keys, so an empty map compares nothing. That is
	// reachable: OWNCORD_TOTP_KEY set on a runner makes
	// loadOrGenerateKeyFile (Server/auth/totp_encrypt.go) take the env branch
	// and never write data/totp.key, and start() hands the server the
	// harness's environment.
	if len(s.keys) == 0 {
		problems = append(problems, fmt.Errorf(
			"the pre-upgrade capture found none of %v: the credential assertion would hold over nothing",
			credentialFiles))
	}
	if !slices.Contains(s.backups, f.backupName) {
		problems = append(problems, fmt.Errorf(
			"the pre-upgrade capture does not list backup %s, only %v", f.backupName, s.backups))
	}
	switch digest, ok := s.uploads[f.attachmentID]; {
	case !ok:
		// Server/storage saves under the attachment id verbatim, so a miss
		// means captureState was pointed somewhere that is not the install.
		problems = append(problems, fmt.Errorf(
			"the pre-upgrade capture has no data/uploads/%s (it found %d file(s)): is it reading the install directory?",
			f.attachmentID, len(s.uploads)))
	case digest != fixturePayloadDigest:
		problems = append(problems, fmt.Errorf(
			"data/uploads/%s is %s on disk, want the uploaded %s", f.attachmentID, digest, fixturePayloadDigest))
	}
	if s.download.digest != fixturePayloadDigest || s.download.length != fixturePayloadSize {
		problems = append(problems, fmt.Errorf(
			"the pre-upgrade download of %s is %s (%d bytes), want %s (%d bytes)",
			f.attachmentID, s.download.digest, s.download.length, fixturePayloadDigest, fixturePayloadSize))
	}
	return errors.Join(problems...)
}

// hashUploads digests every file under root, keyed by its path relative to
// root. A missing directory yields an empty map so compare names each missing
// upload instead of failing with one opaque error.
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
// body is hashed rather than kept: a digest plus a length names every way it
// could come back wrong.
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
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return download{}, fmt.Errorf("downloading attachment %s: got %s, want 200: %s", id, resp.Status, bytes.TrimSpace(detail))
	}
	// Bounded one byte over the payload so an over-long body still reads as a
	// length mismatch without buffering whatever a wrong endpoint streams.
	data, err := io.ReadAll(io.LimitReader(resp.Body, fixturePayloadSize+1))
	if err != nil {
		return download{}, fmt.Errorf("downloading attachment %s: %w", id, err)
	}
	return download{id: id, digest: fmt.Sprintf("%x", sha256.Sum256(data)), length: len(data)}, nil
}

// reportedVersion asks the only endpoint that reports the running version on
// both alpha.4 and HEAD, so "the upgrade happened" is an assertion.
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
// byte for byte, naming whatever did not. It does not assert the reverse: an
// item present only in after is new and printed as informational.
//
// alpha.4 has no Server/auth/erasure_key.go or push_vapid_key.go, so HEAD
// legitimately creates data/erasure.key, data/push_vapid.key and
// data/erasure/markers.sqlite on first boot; byte-equality would fail a newer
// server for doing what it should. A lost or mutated item still fails.
//
// The version is not compared: the upgrade phase expects it to differ and the
// rollback phase to match, so the caller asserts it.
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
	// Digest and length only: the id is an input, and including it would
	// print a mismatched id as though the bytes had changed.
	if before.download.digest != after.download.digest || before.download.length != after.download.length {
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

// lostOrChanged reports every entry of before that after has lost or altered,
// sorted so a divergence prints the same on every run.
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

// additions is the other half of compare's asymmetry: what the newer version
// created that the older one never had. Informational, "" when none.
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
	return "added since the pre-upgrade capture: " + strings.Join(added, ", ")
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

// getClient fetches one path from the running server with the loopback client.
func getClient(path string) (status int, contentType, body string, err error) {
	req, err := http.NewRequest(http.MethodGet, defaultBaseURL+path, nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return 0, "", "", err
	}
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return 0, "", "", fmt.Errorf("GET %s: %w", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxClientBody))
	if err != nil {
		return 0, "", "", fmt.Errorf("reading GET %s: %w", path, err)
	}
	return resp.StatusCode, resp.Header.Get("Content-Type"), string(data), nil
}
