package admin_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

type bundlePreview struct {
	ID       string `json:"preview_id"`
	SHA256   string `json:"sha256"`
	ByteSize int    `json:"byte_size"`
	Items    []struct {
		Name     string `json:"name"`
		ByteSize int    `json:"byte_size"`
		SHA256   string `json:"sha256"`
	} `json:"items"`
	Redactions json.RawMessage `json:"redactions"`
}

func supportTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.MigrateFS(database, migrations.FS); err != nil {
		t.Fatal(err)
	}
	return database
}

func previewBundle(t *testing.T, handler http.Handler, token string) bundlePreview {
	t.Helper()
	w := doRequest(t, handler, http.MethodPost, "/support-bundles/preview", token, map[string]any{})
	if w.Code != http.StatusOK {
		t.Fatalf("preview: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("preview must not be cached")
	}
	var out bundlePreview
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func bundleHash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

func bundleContainsSecret(data []byte, secrets []string) bool {
	for _, secret := range secrets {
		if bytes.Contains(data, []byte(secret)) {
			return true
		}
	}
	return false
}

func TestSupportBundle_FrozenReviewedBytesExcludePlantedSecrets(t *testing.T) {
	database := supportTestDB(t)
	token := createAdminUser(t, database)
	secrets := []string{"planted-password-material", "planted-session-token", "planted-api-token", "planted-totp-secret", "planted-recovery-code", "planted-github-token", "planted-livekit-secret", "planted-otlp-credential", "planted-message-content", "planted-avatar-path", "planted-client-address", "planted-environment-totp-key", "private-person", "private-device", "private-room", "private-token-label"}
	uid, err := database.CreateUser(context.Background(), "private-person", secrets[0], 4)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateSession(context.Background(), uid, secrets[1], "private-device", secrets[10]); err != nil {
		t.Fatal(err)
	}
	if _, err := database.CreateAPIToken(context.Background(), uid, secrets[2], "private-token-label", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQLDb().Exec("UPDATE users SET totp_secret = ?, avatar = ? WHERE id = ?", secrets[3], secrets[9], uid); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQLDb().Exec("INSERT INTO totp_recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)", uid, secrets[4], time.Now().UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQLDb().Exec("INSERT INTO channels(name,type) VALUES('private-room','text')"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.SQLDb().Exec("INSERT INTO messages(channel_id,user_id,content) VALUES((SELECT MAX(id) FROM channels),?,?)", uid, secrets[8]); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OWNCORD_TOTP_KEY", secrets[11])
	logs := admin.NewRingBuffer(500)
	for i := range 250 {
		logs.Write(admin.LogEntry{Timestamp: time.Now().Add(time.Duration(i) * time.Millisecond).Format(time.RFC3339Nano), Level: "ERROR", Message: strings.Join(secrets, " "), Source: secrets[9], Attrs: strings.Join(secrets, " ")})
	}
	// Negative control: this scanner would detect the planted API token in a
	// log line if the exporter accidentally passed a raw message through.
	if !bundleContainsSecret([]byte("failed request token="+secrets[2]), secrets) {
		t.Fatal("secret scanner negative control did not detect the leak")
	}
	cfg := &config.Config{GitHub: config.GitHubConfig{Token: secrets[5]}, Voice: config.VoiceConfig{LiveKitAPISecret: secrets[6], LiveKitAPIKey: secrets[2]}, Telemetry: config.TelemetryConfig{OTLPEndpoint: "https://" + secrets[7] + "@private-host"}, Server: config.ServerConfig{Name: secrets[8], DataDir: secrets[9]}, Logging: config.LoggingConfig{Level: secrets[0]}}
	handler := admin.NewAdminAPI(database, "1.2.3", &mockHub{}, nil, logs, nil, nil, newTestServices(database), admin.SetupOptions{RunningCfg: cfg})
	p := previewBundle(t, handler, token)
	before, err := database.GetAuditLog(context.Background(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range before {
		if entry.Action == "support_bundle_create" {
			t.Fatal("preview recorded an export before consent")
		}
	}
	if len(p.Items) != 6 || len(p.Redactions) == 0 {
		t.Fatalf("missing manifest/items/report: %+v", p)
	}
	// Change every dynamic source after preview. Download must still match
	// the preview's exact archive and per-item digests.
	cfg.Server.Port = 9999
	logs.Write(admin.LogEntry{Timestamp: time.Now().Format(time.RFC3339Nano), Level: "WARN", Message: "database backup created"})
	if _, err := database.CreateUser(context.Background(), "after-preview", "hash", 4); err != nil {
		t.Fatal(err)
	}
	w := doRequest(t, handler, http.MethodPost, "/support-bundles/download", token, map[string]string{"preview_id": p.ID, "sha256": p.SHA256})
	if w.Code != http.StatusOK {
		t.Fatalf("download: %d %s", w.Code, w.Body.String())
	}
	if len(w.Body.Bytes()) != p.ByteSize || bundleHash(w.Body.Bytes()) != p.SHA256 {
		t.Fatal("download changed after preview")
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-SHA256") != p.SHA256 {
		t.Fatal("missing download privacy/integrity headers")
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range zr.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if bundleContainsSecret(data, secrets) || bytes.Contains(data, []byte(token)) {
			t.Fatalf("sensitive content in %s", file.Name)
		}
		found := false
		for _, item := range p.Items {
			if item.Name == file.Name {
				found = true
				if item.SHA256 != bundleHash(data) || item.ByteSize != len(data) {
					t.Fatalf("item mismatch %s", file.Name)
				}
			}
		}
		if !found {
			t.Fatalf("unreviewed item %s", file.Name)
		}
		if file.Name == "events.json" {
			var events []map[string]any
			if err := json.Unmarshal(data, &events); err != nil {
				t.Fatal(err)
			}
			if len(events) != 200 {
				t.Fatalf("events count: %d", len(events))
			}
		}
		if file.Name == "manifest.json" {
			var manifest bundlePreview
			if err := json.Unmarshal(data, &manifest); err != nil {
				t.Fatal(err)
			}
			var compact bytes.Buffer
			if err := json.Compact(&compact, manifest.Redactions); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(compact.Bytes(), p.Redactions) {
				t.Fatal("manifest redactions differ from preview")
			}
		}
	}
	audits, err := database.GetAuditLog(context.Background(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range audits {
		if entry.Action == "support_bundle_create" {
			count++
			for _, item := range p.Items {
				if !strings.Contains(entry.Detail, item.Name) {
					t.Fatalf("audit omitted reviewed item %s", item.Name)
				}
			}
			if entry.ActorID == 0 || !strings.Contains(entry.Detail, "manifest.json") || bundleContainsSecret([]byte(entry.Detail), secrets) || strings.Contains(entry.Detail, p.ID) {
				t.Fatalf("unsafe audit: %+v", entry)
			}
		}
	}
	if count != 1 {
		t.Fatalf("export audit count %d", count)
	}
	w = doRequest(t, handler, http.MethodPost, "/support-bundles/download", token, map[string]string{"preview_id": p.ID, "sha256": p.SHA256})
	if w.Code != http.StatusGone {
		t.Fatalf("replayed download accepted: %d", w.Code)
	}
}

func TestSupportBundle_AuthorizationSessionBindingAndForbiddenSelection(t *testing.T) {
	database := supportTestDB(t)
	token := createAdminUser(t, database)
	handler := admin.NewAdminAPI(database, "1.2.3", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	for _, role := range []int{3, 4} {
		other := createUserWithRole(t, database, "role-"+string(rune('a'+role)), role)
		w := doRequest(t, handler, http.MethodPost, "/support-bundles/preview", other, map[string]any{})
		if w.Code != http.StatusForbidden {
			t.Fatalf("role %d admitted: %d", role, w.Code)
		}
	}
	w := doRequest(t, handler, http.MethodPost, "/support-bundles/preview", "", map[string]any{})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous admitted: %d", w.Code)
	}
	for _, field := range []string{"items", "include_messages", "include_credentials", "include_addresses"} {
		w = doRequest(t, handler, http.MethodPost, "/support-bundles/preview", token, map[string]any{field: true})
		if w.Code != http.StatusBadRequest {
			t.Fatalf("forbidden %s accepted: %d", field, w.Code)
		}
	}
	owner, err := database.GetUserByUsername(context.Background(), "adminuser")
	if err != nil {
		t.Fatal(err)
	}
	apiToken := "planted-headless-owner-token"
	if _, err := database.CreateAPIToken(context.Background(), owner.ID, auth.HashToken(apiToken), "test", nil); err != nil {
		t.Fatal(err)
	}
	w = doRequest(t, handler, http.MethodPost, "/support-bundles/preview", apiToken, map[string]any{})
	if w.Code != http.StatusForbidden {
		t.Fatalf("API token admitted: %d", w.Code)
	}
	p := previewBundle(t, handler, token)
	second := "second-owner-session"
	if _, err := database.CreateSession(context.Background(), owner.ID, auth.HashToken(second), "test", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	for _, attempt := range []struct{ token, hash string }{{second, p.SHA256}, {token, "wrong-hash"}} {
		w = doRequest(t, handler, http.MethodPost, "/support-bundles/download", attempt.token, map[string]string{"preview_id": p.ID, "sha256": attempt.hash})
		if w.Code != http.StatusGone {
			t.Fatalf("different session/hash accepted: %d", w.Code)
		}
	}
	// Permission changes apply between preview and confirmation.
	if _, err := database.SQLDb().Exec("UPDATE users SET role_id=4 WHERE id=?", owner.ID); err != nil {
		t.Fatal(err)
	}
	w = doRequest(t, handler, http.MethodPost, "/support-bundles/download", token, map[string]string{"preview_id": p.ID, "sha256": p.SHA256})
	if w.Code != http.StatusForbidden {
		t.Fatalf("revoked administrator admitted: %d", w.Code)
	}
}

func TestSupportBundle_AuditFailurePreventsDownload(t *testing.T) {
	database := supportTestDB(t)
	token := createAdminUser(t, database)
	handler := admin.NewAdminAPI(database, "1.2.3", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	p := previewBundle(t, handler, token)
	if _, err := database.SQLDb().Exec(`CREATE TRIGGER refuse_support_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'support_bundle_create' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`); err != nil {
		t.Fatal(err)
	}
	w := doRequest(t, handler, http.MethodPost, "/support-bundles/download", token, map[string]string{"preview_id": p.ID, "sha256": p.SHA256})
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Content-Type") == "application/zip" {
		t.Fatalf("unrecorded export accepted: %d %s", w.Code, w.Body.String())
	}
}

func TestSupportBundle_AdministratorDoesNotNeedOwnerRole(t *testing.T) {
	database := supportTestDB(t)
	if _, err := database.SQLDb().Exec("UPDATE roles SET permissions=permissions | 1073741824 WHERE id=2"); err != nil {
		t.Fatal(err)
	}
	token := createUserWithRole(t, database, "diagnostic-admin", 2)
	handler := admin.NewAdminAPI(database, "1.2.3", &mockHub{}, nil, nil, nil, nil, newTestServices(database))
	p := previewBundle(t, handler, token)
	w := doRequest(t, handler, http.MethodPost, "/support-bundles/download", token, map[string]string{"preview_id": p.ID, "sha256": p.SHA256})
	if w.Code != http.StatusOK {
		t.Fatalf("administrator refused: %d %s", w.Code, w.Body.String())
	}
}
