package admin_test

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db/audittest"
)

// confirmHeader names the sensitive keys a PATCH deliberately changes; the
// panel sends it after the owner types the confirmation.
const confirmHeader = "X-OwnCord-Confirm"

// newSensitiveFixture is newConfigOverridesFixture with a real config.yaml at
// ConfigPath (so config.Preview sees the file the next boot would read) and an
// admin perimeter that admits httptest's default client, 192.0.2.1.
func newSensitiveFixture(t *testing.T, adminCIDRs string, overrides string) configOverridesFixture {
	t.Helper()
	t.Setenv("OWNCORD_CONTAINER", "0")
	t.Cleanup(admin.ResetRestartState)
	database := openAdminTestDB(t)
	dataDir := t.TempDir()
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	yaml := "server:\n  data_dir: \"" + filepath.ToSlash(dataDir) + "\"\n  admin_allowed_cidrs: " + adminCIDRs + "\n"
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		t.Fatalf("write config.yaml: %v", err)
	}
	if overrides != "" {
		if err := os.WriteFile(config.OverridesPath(dataDir), []byte(overrides), 0o600); err != nil {
			t.Fatalf("write overrides: %v", err)
		}
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	cfg.GIF.APIKey = cfgOvGIFKey
	cfg.GitHub.Token = cfgOvGitHubToken
	cfg.Voice.LiveKitAPISecret = cfgOvLKSecret
	cfg.Upload.StorageDir = filepath.Join(dataDir, "uploads")
	cfg.Database.Path = filepath.Join(dataDir, "chatserver.db")
	restarts := make(chan string, 4)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{ConfigPath: cfgPath, RunningCfg: cfg, Restart: func(r string) { restarts <- r }})
	return configOverridesFixture{handler: handler, database: database, dataDir: dataDir, cfg: cfg, restarts: restarts}
}

// patchConfig PATCHes /config/settings, confirming the given keys, from
// httptest's default peer 192.0.2.1 (plus an optional X-Forwarded-For).
func patchConfig(t *testing.T, h http.Handler, token string, body map[string]any, confirm []string, xff string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/config/settings", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if len(confirm) > 0 {
		req.Header.Set(confirmHeader, strings.Join(confirm, ","))
	}
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func savedOverrides(t *testing.T, dataDir string) map[string]any {
	t.Helper()
	saved, err := config.ReadOverrides(config.OverridesPath(dataDir))
	if err != nil {
		t.Fatalf("ReadOverrides: %v", err)
	}
	return saved
}

type sensitiveRow struct {
	Key                  string `json:"key"`
	Type                 string `json:"type"`
	Value                any    `json:"value"`
	Override             any    `json:"override"`
	Configured           *bool  `json:"configured"`
	OverrideSet          *bool  `json:"override_set"`
	RequiresConfirmation bool   `json:"requires_confirmation"`
	AllowEmpty           bool   `json:"allow_empty"`
}

func sensitiveRows(t *testing.T, body []byte) map[string]sensitiveRow {
	t.Helper()
	var resp struct {
		Settings []sensitiveRow `json:"settings"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("unmarshal %s: %v", body, err)
	}
	rows := make(map[string]sensitiveRow, len(resp.Settings))
	for _, r := range resp.Settings {
		rows[r.Key] = r
	}
	return rows
}

func TestConfigOverridesSensitive_GetListsEverythingButDataDir(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)

	w := doRequest(t, f.handler, http.MethodGet, "/config/settings", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d; body: %s", w.Code, w.Body.String())
	}
	for _, secret := range []string{cfgOvGIFKey, cfgOvGitHubToken, cfgOvLKSecret} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("GET /config/settings leaked a secret value: %s", w.Body.String())
		}
	}
	rows := sensitiveRows(t, w.Body.Bytes())
	for _, key := range []string{"server.data_dir", "upload.blocked_extensions", "upload.allowed_extensions"} {
		if _, ok := rows[key]; ok {
			t.Errorf("GET lists %q, which is not an overrides-file key", key)
		}
	}
	for _, key := range []string{"server.port", "tls.mode", "server.admin_allowed_cidrs", "database.path", "voice.livekit_binary"} {
		if r, ok := rows[key]; !ok || !r.RequiresConfirmation {
			t.Errorf("row %q = %+v, %v; want present with requires_confirmation", key, r, ok)
		}
	}
	gif, ok := rows["gif.api_key"]
	if !ok {
		t.Fatal("GET has no gif.api_key row; secrets are write-only fields, not hidden ones")
	}
	if gif.Type != "secret" || gif.Value != nil || gif.Override != nil ||
		gif.Configured == nil || !*gif.Configured || gif.OverrideSet == nil || *gif.OverrideSet {
		t.Errorf("gif.api_key row = %+v, want type secret, null value/override, configured true, override_set false", gif)
	}
	if !gif.AllowEmpty {
		t.Error("gif.api_key row reports allow_empty false; the panel cannot offer Clear value")
	}
	for _, key := range []string{"voice.livekit_api_key", "voice.livekit_api_secret"} {
		if r := rows[key]; r.AllowEmpty {
			t.Errorf("%s row reports allow_empty true; the LiveKit credentials must keep a value", key)
		}
	}
	if r := rows["github.owner"]; r.Type != "string" || r.RequiresConfirmation {
		t.Errorf("github.owner row = %+v, want a plain string row (signed updates make it safe)", r)
	}
}

func TestConfigOverridesSensitive_SecretsAreWriteOnly(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	rec := audittest.Install(t, f.database)

	const newKey = "klipy-new-secret-value-321"
	w := patchConfig(t, f.handler, token, map[string]any{"gif.api_key": newKey}, nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH secret = %d; body: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), newKey) {
		t.Fatalf("PATCH response echoed the secret: %s", w.Body.String())
	}
	if r := sensitiveRows(t, w.Body.Bytes())["gif.api_key"]; r.OverrideSet == nil || !*r.OverrideSet || r.Override != nil {
		t.Errorf("gif.api_key row after PATCH = %+v, want override_set true and no override value", r)
	}
	if got := savedOverrides(t, f.dataDir)["gif.api_key"]; got != newKey {
		t.Errorf("overrides file gif.api_key = %#v, want the new key", got)
	}
	w = doRequest(t, f.handler, http.MethodGet, "/config/settings", token, nil)
	if strings.Contains(w.Body.String(), newKey) {
		t.Fatalf("GET echoed the saved secret: %s", w.Body.String())
	}

	// "" clears it (feature off); null drops the override (back to config.yaml).
	if w = patchConfig(t, f.handler, token, map[string]any{"gif.api_key": ""}, nil, ""); w.Code != http.StatusOK {
		t.Fatalf("PATCH clear = %d; body: %s", w.Code, w.Body.String())
	}
	if got, ok := savedOverrides(t, f.dataDir)["gif.api_key"]; !ok || got != "" {
		t.Errorf("after clear, overrides gif.api_key = %#v, %v; want \"\"", got, ok)
	}
	if w = patchConfig(t, f.handler, token, map[string]any{"gif.api_key": nil}, nil, ""); w.Code != http.StatusOK {
		t.Fatalf("PATCH reset = %d; body: %s", w.Code, w.Body.String())
	}
	if _, ok := savedOverrides(t, f.dataDir)["gif.api_key"]; ok {
		t.Error("gif.api_key still in the overrides file after a null PATCH")
	}

	rec.Wait(t, "config_override_change")
	audittest.AssertSafeDetails(t, rec.Entries(), newKey, token)
}

// The LiveKit credentials must have a value, so the panel drops their override
// by sending null (back to config.yaml) rather than the empty string its rule
// refuses.
func TestConfigOverridesSensitive_RemoveLiveKitSecretOverride(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, `{"voice.livekit_api_secret": "`+cfgOvLKSecret+`"}`)
	token := createAdminUser(t, f.database)

	if _, ok := savedOverrides(t, f.dataDir)["voice.livekit_api_secret"]; !ok {
		t.Fatal("fixture did not save the LiveKit secret override")
	}
	w := patchConfig(t, f.handler, token, map[string]any{"voice.livekit_api_secret": nil}, nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH null voice.livekit_api_secret = %d; body: %s", w.Code, w.Body.String())
	}
	if _, ok := savedOverrides(t, f.dataDir)["voice.livekit_api_secret"]; ok {
		t.Error("voice.livekit_api_secret still in the overrides file after a null PATCH")
	}
}

func TestConfigOverridesSensitive_SecretErrorDoesNotEchoValue(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)

	const tooShort = "short-secret-marker"
	w := patchConfig(t, f.handler, token, map[string]any{"voice.livekit_api_secret": tooShort}, nil, "")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "voice.livekit_api_secret") {
		t.Fatalf("PATCH short LiveKit secret = %d %s, want 400 naming the key", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), tooShort) {
		t.Errorf("400 body echoes the secret value: %s", w.Body.String())
	}
}

func TestConfigOverridesSensitive_ConfirmationRequired(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)

	body := map[string]any{"server.restart_mode": "spawn", "logging.level": "debug"}
	w := patchConfig(t, f.handler, token, body, nil, "")
	if w.Code != http.StatusPreconditionRequired || !strings.Contains(w.Body.String(), "CONFIRMATION_REQUIRED") ||
		!strings.Contains(w.Body.String(), "server.restart_mode") {
		t.Fatalf("unconfirmed PATCH = %d %s, want 428 CONFIRMATION_REQUIRED naming server.restart_mode", w.Code, w.Body.String())
	}
	// Confirming a different key does not count.
	if w = patchConfig(t, f.handler, token, body, []string{"server.port"}, ""); w.Code != http.StatusPreconditionRequired {
		t.Errorf("PATCH confirming the wrong key = %d, want 428", w.Code)
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("an unconfirmed PATCH wrote overrides")
	}
	if w = patchConfig(t, f.handler, token, body, []string{"server.restart_mode"}, ""); w.Code != http.StatusOK {
		t.Fatalf("confirmed PATCH = %d; body: %s", w.Code, w.Body.String())
	}
	if savedOverrides(t, f.dataDir)["server.restart_mode"] != "spawn" {
		t.Error("confirmed PATCH did not save server.restart_mode")
	}
}

func TestConfigOverridesSensitive_PerimeterLockoutGuard(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	proxyKey := []string{"server.trusted_proxies"}
	adminKey := make([]string, 1, 1+len(proxyKey))
	adminKey[0] = "server.admin_allowed_cidrs"

	// An allowlist that excludes the caller (192.0.2.1) is refused.
	w := patchConfig(t, f.handler, token, map[string]any{"server.admin_allowed_cidrs": []string{"10.0.0.0/8"}}, adminKey, "")
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "LOCKOUT") {
		t.Errorf("PATCH excluding own address = %d %s, want 409 LOCKOUT", w.Code, w.Body.String())
	}
	// Trusting the caller's peer as a proxy makes X-Forwarded-For the client
	// address, 203.0.113.9, which the allowlist does not admit.
	w = patchConfig(t, f.handler, token, map[string]any{"server.trusted_proxies": []string{"192.0.2.1/32"}}, proxyKey, "203.0.113.9")
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "LOCKOUT") {
		t.Errorf("PATCH proxies that re-attribute the caller = %d %s, want 409 LOCKOUT", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused perimeter PATCH wrote overrides")
	}

	// Lists that still admit the caller are saved; so is an empty allowlist
	// (perimeter off), which cannot lock anyone out.
	ok := map[string]any{
		"server.admin_allowed_cidrs": []string{"192.0.2.0/24", "127.0.0.0/8"},
		"server.trusted_proxies":     []string{"10.0.0.1/32"},
	}
	if w = patchConfig(t, f.handler, token, ok, append(adminKey, proxyKey...), ""); w.Code != http.StatusOK {
		t.Errorf("PATCH admitting the caller = %d; body: %s", w.Code, w.Body.String())
	}
	if w = patchConfig(t, f.handler, token, map[string]any{"server.admin_allowed_cidrs": []string{}}, adminKey, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH empty allowlist = %d; body: %s", w.Code, w.Body.String())
	}
}

// A reset falls back to config.yaml; the guard judges that fallback.
func TestConfigOverridesSensitive_PerimeterResetLockoutGuard(t *testing.T) {
	f := newSensitiveFixture(t, `["10.0.0.0/8"]`, `{"server.admin_allowed_cidrs": ["192.0.2.0/24"]}`)
	token := createAdminUser(t, f.database)

	w := patchConfig(t, f.handler, token, map[string]any{"server.admin_allowed_cidrs": nil}, []string{"server.admin_allowed_cidrs"}, "")
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "LOCKOUT") {
		t.Errorf("reset to a config.yaml allowlist excluding the caller = %d %s, want 409 LOCKOUT", w.Code, w.Body.String())
	}
	if _, ok := savedOverrides(t, f.dataDir)["server.admin_allowed_cidrs"]; !ok {
		t.Error("the refused reset removed the override anyway")
	}
}

func TestConfigOverridesSensitive_PortGuard(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	portKey := []string{"server.port"}

	busy, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer busy.Close() //nolint:errcheck
	busyPort := busy.Addr().(*net.TCPAddr).Port
	w := patchConfig(t, f.handler, token, map[string]any{"server.port": busyPort}, portKey, "")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "server.port") {
		t.Errorf("PATCH a port already in use = %d %s, want 400 naming server.port", w.Code, w.Body.String())
	}

	free, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	freePort := free.Addr().(*net.TCPAddr).Port
	_ = free.Close()
	if w = patchConfig(t, f.handler, token, map[string]any{"server.port": freePort}, portKey, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH a free port = %d; body: %s", w.Code, w.Body.String())
	}

	// In a container the published port mapping fixes the port; the panel
	// cannot move it, so it refuses instead of stranding the server.
	t.Setenv("OWNCORD_CONTAINER", "1")
	w = patchConfig(t, f.handler, token, map[string]any{"server.port": freePort + 1}, portKey, "")
	if w.Code != http.StatusBadRequest || !strings.Contains(strings.ToLower(w.Body.String()), "container") {
		t.Errorf("PATCH server.port in a container = %d %s, want 400 explaining the container", w.Code, w.Body.String())
	}
	if got := savedOverrides(t, f.dataDir)["server.port"]; got != freePort {
		t.Errorf("overrides server.port = %#v, want only the free-port save (%d)", got, freePort)
	}
}

func TestConfigOverridesSensitive_TLSGuard(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	tlsKeys := []string{"tls.mode", "tls.cert_file", "tls.key_file", "tls.domain"}

	missing := map[string]any{
		"tls.mode":      "manual",
		"tls.cert_file": filepath.Join(f.dataDir, "nope.pem"),
		"tls.key_file":  filepath.Join(f.dataDir, "nope.key"),
	}
	if w := patchConfig(t, f.handler, token, missing, tlsKeys, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH manual TLS with missing files = %d %s, want 400", w.Code, w.Body.String())
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"tls.mode": "acme", "tls.domain": ""}, tlsKeys, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "tls.domain") {
		t.Errorf("PATCH acme without a domain = %d %s, want 400 naming tls.domain", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused TLS PATCH wrote overrides")
	}

	cert, key := filepath.Join(f.dataDir, "c.pem"), filepath.Join(f.dataDir, "k.pem")
	if err := auth.GenerateSelfSigned(cert, key); err != nil {
		t.Fatalf("GenerateSelfSigned: %v", err)
	}
	good := map[string]any{"tls.mode": "manual", "tls.cert_file": cert, "tls.key_file": key}
	if w := patchConfig(t, f.handler, token, good, tlsKeys, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH manual TLS with a valid pair = %d; body: %s", w.Code, w.Body.String())
	}
}

// Switching to acme mode while the HTTPS listener stays on port 80 leaves no
// port for the HTTP-01 challenge, so the certificate can never be obtained.
// The running port is 80 here, so guardPort skips and only this guard can
// refuse the combination.
func TestConfigOverridesSensitive_AcmeRefusesPort80(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	f.cfg.Server.Port = 80
	keys := []string{"server.port", "tls.mode", "tls.domain"}
	body := map[string]any{"server.port": 80, "tls.mode": "acme", "tls.domain": "chat.example.com"}
	if w := patchConfig(t, f.handler, token, body, keys, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "server.port") {
		t.Errorf("PATCH acme with server.port 80 = %d %s, want 400 naming server.port", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused acme PATCH wrote overrides")
	}
}

// When self_signed may generate the pair, both the certificate and the key
// directories must exist and be writable: GenerateSelfSigned writes both files
// without creating their parents, so an unwritable key directory locks the
// server out on restart.
func TestConfigOverridesSensitive_SelfSignedKeyDirMustBeWritable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("writability semantics: needs a non-root Unix user")
	}
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	tlsKeys := []string{"tls.mode", "tls.cert_file", "tls.key_file"}

	certDir := filepath.Join(f.dataDir, "cert-dir")
	if err := os.Mkdir(certDir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{
		"tls.mode":      "self_signed",
		"tls.cert_file": filepath.Join(certDir, "cert.pem"),
		"tls.key_file":  filepath.Join(f.dataDir, "missing-key-dir", "key.pem"),
	}
	if w := patchConfig(t, f.handler, token, body, tlsKeys, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "tls.key_file") {
		t.Errorf("PATCH self_signed TLS with a missing key directory = %d %s, want 400 naming tls.key_file", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused self-signed PATCH wrote overrides")
	}
}

// A self-signed pair the boot cannot load or generate is a lock-out:
// GenerateSelfSigned writes the cert and key without creating parents, so a
// cert_file/key_file that name the same path (the key overwrites the cert) or
// a path that is not a regular file (writePEM fails) leaves startTLS unable to
// load a pair after restart.
func TestConfigOverridesSensitive_SelfSignedPairMustBeLoadable(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	tlsKeys := []string{"tls.mode", "tls.cert_file", "tls.key_file"}

	same := filepath.Join(f.dataDir, "same.pem")
	sameBody := map[string]any{"tls.mode": "self_signed", "tls.cert_file": same, "tls.key_file": same}
	if w := patchConfig(t, f.handler, token, sameBody, tlsKeys, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH self_signed with one path for both = %d %s, want 400", w.Code, w.Body.String())
	}

	dir := filepath.Join(f.dataDir, "cert-is-dir")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	dirBody := map[string]any{
		"tls.mode":      "self_signed",
		"tls.cert_file": dir,
		"tls.key_file":  filepath.Join(f.dataDir, "key.pem"),
	}
	if w := patchConfig(t, f.handler, token, dirBody, tlsKeys, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "tls.cert_file") {
		t.Errorf("PATCH self_signed with a directory cert_file = %d %s, want 400 naming tls.cert_file", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused self-signed PATCH wrote overrides")
	}
}

// writeExpiredSelfSigned writes a loadable self-signed pair whose validity
// window is already in the past, the shape a stale data_dir pair has.
func writeExpiredSelfSigned(t *testing.T, dir string) (string, string) {
	t.Helper()
	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Organization: []string{"OwnCord Server"}},
		NotBefore:             time.Now().Add(-2 * time.Hour),
		NotAfter:              time.Now().Add(-1 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &privKey.PublicKey, privKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(privKey)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	certFile := filepath.Join(dir, "expired-cert.pem")
	keyFile := filepath.Join(dir, "expired-key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}

// An existing self-signed pair whose leaf has expired is a lock-out: browsers
// refuse it, so the same check guardManualTLS makes must apply here.
func TestConfigOverridesSensitive_SelfSignedExpiredPairRejected(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	cert, key := writeExpiredSelfSigned(t, f.dataDir)
	tlsKeys := []string{"tls.mode", "tls.cert_file", "tls.key_file"}
	body := map[string]any{"tls.mode": "self_signed", "tls.cert_file": cert, "tls.key_file": key}
	if w := patchConfig(t, f.handler, token, body, tlsKeys, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "expired") {
		t.Errorf("PATCH self_signed with an expired pair = %d %s, want 400 naming expiry", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused self-signed PATCH wrote overrides")
	}
}

func TestConfigOverridesSensitive_DataPathGuards(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	dbKey := []string{"database.path"}

	// A database path must name an existing, intact OwnCord database: a
	// missing file would boot an empty server.
	if w := patchConfig(t, f.handler, token, map[string]any{"database.path": filepath.Join(f.dataDir, "new.db")}, dbKey, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH database.path to a missing file = %d %s, want 400", w.Code, w.Body.String())
	}
	junk := filepath.Join(f.dataDir, "junk.db")
	if err := os.WriteFile(junk, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"database.path": junk}, dbKey, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH database.path to a non-database = %d %s, want 400", w.Code, w.Body.String())
	}
	copyPath := filepath.Join(f.dataDir, "copy.db")
	if err := f.database.BackupToSafe(context.Background(), copyPath, f.dataDir); err != nil {
		t.Fatalf("BackupTo: %v", err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"database.path": copyPath}, dbKey, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH database.path to an intact copy = %d; body: %s", w.Code, w.Body.String())
	}

	// Moving uploads to an empty directory while the current one holds files
	// would 404 every attachment: copy first.
	storageKey := []string{"upload.storage_dir"}
	if err := os.MkdirAll(f.cfg.Upload.StorageDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.cfg.Upload.StorageDir, "a.bin"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	empty := t.TempDir()
	if w := patchConfig(t, f.handler, token, map[string]any{"upload.storage_dir": empty}, storageKey, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH upload.storage_dir to an empty dir = %d %s, want 400", w.Code, w.Body.String())
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"upload.storage_dir": filepath.Join(f.dataDir, "missing")}, storageKey, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH upload.storage_dir to a missing dir = %d %s, want 400", w.Code, w.Body.String())
	}

	// In a container only data_dir is a volume: a written path outside it
	// would vanish with the container.
	t.Setenv("OWNCORD_CONTAINER", "1")
	backupKey := []string{"backup.dir"}
	if w := patchConfig(t, f.handler, token, map[string]any{"backup.dir": t.TempDir()}, backupKey, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH backup.dir outside data_dir in a container = %d %s, want 400", w.Code, w.Body.String())
	}
	inside := filepath.Join(f.dataDir, "backups2")
	if err := os.MkdirAll(inside, 0o750); err != nil {
		t.Fatal(err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"backup.dir": inside}, backupKey, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH backup.dir inside data_dir in a container = %d; body: %s", w.Code, w.Body.String())
	}
}

// An existing tls.acme_cache_dir must be writable: autocert writes and renews
// the cache there, so a read-only directory passes the wrong test and then
// fails to renew after a restart.
func TestConfigOverridesSensitive_AcmeCacheDirMustBeWritable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("writability semantics: needs a non-root Unix user")
	}
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	key := []string{"tls.acme_cache_dir"}

	readOnly := filepath.Join(f.dataDir, "acme-readonly")
	if err := os.Mkdir(readOnly, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(readOnly, 0o700) })
	if w := patchConfig(t, f.handler, token, map[string]any{"tls.acme_cache_dir": readOnly}, key, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH an existing read-only tls.acme_cache_dir = %d %s, want 400", w.Code, w.Body.String())
	}

	writable := filepath.Join(f.dataDir, "acme-writable")
	if err := os.Mkdir(writable, 0o700); err != nil {
		t.Fatal(err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"tls.acme_cache_dir": writable}, key, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH a writable tls.acme_cache_dir = %d; body: %s", w.Code, w.Body.String())
	}

	missing := filepath.Join(f.dataDir, "acme-missing")
	if w := patchConfig(t, f.handler, token, map[string]any{"tls.acme_cache_dir": missing}, key, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH a missing tls.acme_cache_dir with a writable parent = %d; body: %s", w.Code, w.Body.String())
	}
}

// An existing tls.acme_cache_dir that is a regular file must be rejected: the
// path is not a directory, so autocert cannot write its cache there.
func TestConfigOverridesSensitive_AcmeCacheDirIsFile(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	file := filepath.Join(f.dataDir, "acme-file")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	key := []string{"tls.acme_cache_dir"}
	if w := patchConfig(t, f.handler, token, map[string]any{"tls.acme_cache_dir": file}, key, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH a tls.acme_cache_dir naming an existing file = %d %s, want 400", w.Code, w.Body.String())
	}
}

// voice.livekit_binary is executed. The panel accepts only a binary the
// server process could not have written itself, so a stolen owner session
// cannot plant one (an upload, a plugin dir) and then run it.
func TestConfigOverridesSensitive_LiveKitBinaryGuard(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("ownership semantics: needs a non-root Unix user")
	}
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	binKey := []string{"voice.livekit_binary"}

	own := filepath.Join(t.TempDir(), "livekit-server")
	if err := os.WriteFile(own, []byte("#!/bin/sh\n"), 0o755); err != nil { //nolint:gosec // test fixture
		t.Fatal(err)
	}
	if err := os.Chmod(own, 0o555); err != nil {
		t.Fatal(err)
	}
	w := patchConfig(t, f.handler, token, map[string]any{"voice.livekit_binary": own}, binKey, "")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "voice.livekit_binary") {
		t.Errorf("PATCH a binary the server user owns = %d %s, want 400 naming the key", w.Code, w.Body.String())
	}
	if w = patchConfig(t, f.handler, token, map[string]any{"voice.livekit_binary": "/nonexistent/livekit-server"}, binKey, ""); w.Code != http.StatusBadRequest {
		t.Errorf("PATCH a missing binary = %d %s, want 400", w.Code, w.Body.String())
	}
	if w = patchConfig(t, f.handler, token, map[string]any{"voice.livekit_binary": ""}, binKey, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH an empty livekit_binary (no companion) = %d; body: %s", w.Code, w.Body.String())
	}
	if got := savedOverrides(t, f.dataDir)["voice.livekit_binary"]; got != "" {
		t.Errorf("overrides voice.livekit_binary = %#v, want only the empty save", got)
	}
}

// Applying acme in one save and moving the listen port to 80 in a later save
// must still be refused: the second PATCH names only server.port, but the
// merged preview is acme + port 80, which leaves no port for the HTTP-01
// challenge. The refusal must name the acme conflict, not merely an
// unavailable port, so it holds whether or not the probe can bind :80.
func TestConfigOverridesSensitive_AcmeGuardRunsOnPortOnlyChange(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, `{"tls.mode": "acme", "tls.domain": "chat.example.com"}`)
	token := createAdminUser(t, f.database)

	w := patchConfig(t, f.handler, token, map[string]any{"server.port": 80}, []string{"server.port"}, "")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "acme") {
		t.Errorf("PATCH server.port=80 with acme overrides = %d %s, want 400 naming the acme conflict", w.Code, w.Body.String())
	}
	if _, ok := savedOverrides(t, f.dataDir)["server.port"]; ok {
		t.Error("a refused acme/port-80 PATCH wrote server.port")
	}
}

// When exactly one self-signed pair file exists, GenerateSelfSigned truncates
// it in place: an existing file the server cannot write (for example one left
// by a root-owned earlier run) would make the restart fail. The guard must
// prove the existing half is writable before accepting the pair.
func TestConfigOverridesSensitive_SelfSignedPartialPairMustBeTruncatable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("truncation semantics: needs a non-root Unix user")
	}
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	tlsKeys := []string{"tls.mode", "tls.cert_file", "tls.key_file"}

	cert := filepath.Join(f.dataDir, "partial-cert.pem")
	if err := os.WriteFile(cert, []byte("stale cert"), 0o444); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(cert, 0o444); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{
		"tls.mode":      "self_signed",
		"tls.cert_file": cert,
		"tls.key_file":  filepath.Join(f.dataDir, "partial-key.pem"),
	}
	if w := patchConfig(t, f.handler, token, body, tlsKeys, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "tls.cert_file") {
		t.Errorf("PATCH with an unwritable existing self-signed file = %d %s, want 400 naming tls.cert_file", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused self-signed PATCH wrote overrides")
	}
}

// In a container a self-signed pair outside data_dir would vanish with the
// container, and a missing half makes the next boot write the other path:
// both files must live under data_dir, like every other path the server writes.
func TestConfigOverridesSensitive_SelfSignedPairConfinedToDataDirInContainer(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	tlsKeys := []string{"tls.mode", "tls.cert_file", "tls.key_file"}
	t.Setenv("OWNCORD_CONTAINER", "1")

	outside := t.TempDir()
	for _, tc := range []struct{ key, cert, keyFile string }{
		{"tls.cert_file", filepath.Join(outside, "cert.pem"), filepath.Join(f.dataDir, "key.pem")},
		{"tls.key_file", filepath.Join(f.dataDir, "cert.pem"), filepath.Join(outside, "key.pem")},
	} {
		body := map[string]any{"tls.mode": "self_signed", "tls.cert_file": tc.cert, "tls.key_file": tc.keyFile}
		if w := patchConfig(t, f.handler, token, body, tlsKeys, ""); w.Code != http.StatusBadRequest ||
			!strings.Contains(w.Body.String(), tc.key) {
			t.Errorf("PATCH self_signed with %s outside data_dir in a container = %d %s, want 400 naming it", tc.key, w.Code, w.Body.String())
		}
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Fatal("a refused self-signed PATCH wrote overrides")
	}
	body := map[string]any{
		"tls.mode":      "self_signed",
		"tls.cert_file": filepath.Join(f.dataDir, "cert.pem"),
		"tls.key_file":  filepath.Join(f.dataDir, "key.pem"),
	}
	if w := patchConfig(t, f.handler, token, body, tlsKeys, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH self_signed inside data_dir in a container = %d; body: %s", w.Code, w.Body.String())
	}
}

// plugins.directory is where a plugin install renames aside and removes
// <directory>/<name>, so it must be a directory of its own: never
// data_dir, the uploads directory or the backups directory, nor one holding
// them, and in a container it must live under data_dir.
func TestConfigOverridesSensitive_PluginsDirGuard(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	pluginsKey := []string{"plugins.directory"}
	refused := func(dir, why string) {
		t.Helper()
		if w := patchConfig(t, f.handler, token, map[string]any{"plugins.directory": dir}, pluginsKey, ""); w.Code != http.StatusBadRequest ||
			!strings.Contains(w.Body.String(), "plugins.directory") {
			t.Errorf("PATCH plugins.directory %s = %d %s, want 400 naming plugins.directory", why, w.Code, w.Body.String())
		}
	}

	backupParent := t.TempDir()
	backup := filepath.Join(backupParent, "backups")
	if err := os.Mkdir(backup, 0o750); err != nil {
		t.Fatal(err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"backup.dir": backup}, []string{"backup.dir"}, ""); w.Code != http.StatusOK {
		t.Fatalf("PATCH backup.dir = %d; body: %s", w.Code, w.Body.String())
	}
	refused(backup, "equal to backup.dir")
	refused(backupParent, "containing backup.dir")
	refused(f.dataDir, "equal to data_dir")
	refused(filepath.Dir(f.dataDir), "containing data_dir")

	t.Setenv("OWNCORD_CONTAINER", "1")
	refused(t.TempDir(), "outside data_dir in a container")
	inside := filepath.Join(f.dataDir, "plugins2")
	if err := os.MkdirAll(inside, 0o750); err != nil {
		t.Fatal(err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"plugins.directory": inside}, pluginsKey, ""); w.Code != http.StatusOK {
		t.Errorf("PATCH plugins.directory inside data_dir in a container = %d; body: %s", w.Code, w.Body.String())
	}
}

// A symlink below data_dir does not make a path outside it count as inside:
// the boot would write through the link, out of the persistent volume.
func TestConfigOverridesSensitive_SelfSignedPairSymlinkOutOfDataDirInContainer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	t.Setenv("OWNCORD_CONTAINER", "1")
	link := filepath.Join(f.dataDir, "tls")
	if err := os.Symlink(t.TempDir(), link); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{
		"tls.mode":      "self_signed",
		"tls.cert_file": filepath.Join(link, "cert.pem"),
		"tls.key_file":  filepath.Join(f.dataDir, "key.pem"),
	}
	if w := patchConfig(t, f.handler, token, body, []string{"tls.mode", "tls.cert_file", "tls.key_file"}, ""); w.Code != http.StatusBadRequest ||
		!strings.Contains(w.Body.String(), "tls.cert_file") {
		t.Errorf("PATCH self_signed with tls.cert_file through a symlink out of data_dir = %d %s, want 400 naming tls.cert_file", w.Code, w.Body.String())
	}
}

// The plugins directory stays apart from the uploads directory whichever side
// a PATCH moves: moving upload.storage_dir under, or around, the current
// plugins directory is refused like the reverse.
func TestConfigOverridesSensitive_StorageDirMustNotOverlapPluginsDir(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	parent := t.TempDir()
	plugins := filepath.Join(parent, "plugins")
	inside := filepath.Join(plugins, "uploads")
	if err := os.MkdirAll(inside, 0o750); err != nil {
		t.Fatal(err)
	}
	// Non-empty, so the empty-target check does not answer first.
	if err := os.WriteFile(filepath.Join(inside, "a.bin"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if w := patchConfig(t, f.handler, token, map[string]any{"plugins.directory": plugins}, []string{"plugins.directory"}, ""); w.Code != http.StatusOK {
		t.Fatalf("PATCH plugins.directory = %d; body: %s", w.Code, w.Body.String())
	}
	for _, dir := range []string{inside, parent} {
		if w := patchConfig(t, f.handler, token, map[string]any{"upload.storage_dir": dir}, []string{"upload.storage_dir"}, ""); w.Code != http.StatusBadRequest ||
			!strings.Contains(w.Body.String(), "plugins.directory") {
			t.Errorf("PATCH upload.storage_dir %s overlapping plugins.directory = %d %s, want 400 naming plugins.directory", dir, w.Code, w.Body.String())
		}
	}
}
