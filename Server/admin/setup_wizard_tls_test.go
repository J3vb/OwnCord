package admin_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
)

// wizardTLSHandler is wizardHandler with the running config's certificate
// paths set, so a manual-mode choice has a pair to judge.
func wizardTLSHandler(t *testing.T, certFile, keyFile string) (http.Handler, func() int64, string) {
	t.Helper()
	t.Cleanup(admin.ResetRestartState)
	t.Setenv("OWNCORD_CONTAINER", "0")
	database := openAdminTestDB(t)
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	running := wizardRunningCfg()
	running.TLS = config.TLSConfig{Mode: "off", CertFile: certFile, KeyFile: keyFile}
	handler := admin.NewAdminAPI(database, "1.0.0", nil, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{ConfigPath: cfgPath, RunningCfg: running, Restart: func(string) {}})
	users := func() int64 {
		n, err := database.UserCount(context.Background())
		if err != nil {
			t.Fatalf("UserCount: %v", err)
		}
		return n
	}
	return handler, users, cfgPath
}

func postWizard(t *testing.T, handler http.Handler, wizard map[string]any) (int, string) {
	t.Helper()
	rr := doRequest(t, handler, "POST", "/setup", "", map[string]any{
		"username": "owner", "password": "SecurePass123!", "wizard": wizard,
	})
	return rr.Code, rr.Body.String()
}

// A TLS choice the next boot cannot serve is refused before the owner
// account or config.yaml is written, as the panel refuses the same change.
func TestSetupWizard_RefusesTLSTheNextBootCannotServe(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]map[string]any{
		"manual without a pair": {"tls_mode": "manual"},
		"acme on port 80":       {"tls_mode": "acme", "tls_domain": "chat.example.com", "port": 80},
	}
	for name, wizard := range cases {
		t.Run(name, func(t *testing.T) {
			handler, users, cfgPath := wizardTLSHandler(t, filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"))
			code, body := postWizard(t, handler, wizard)
			if code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", code, body)
			}
			if !strings.Contains(body, "tls_mode") {
				t.Errorf("refusal %q does not name tls_mode", body)
			}
			if n := users(); n != 0 {
				t.Errorf("user count = %d, want 0", n)
			}
			if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
				t.Error("config file written despite the refusal")
			}
		})
	}
}

func TestSetupWizard_ManualTLSWithAValidPairIsSaved(t *testing.T) {
	dir := t.TempDir()
	cert, key := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := auth.GenerateSelfSigned(cert, key); err != nil {
		t.Fatalf("GenerateSelfSigned: %v", err)
	}
	handler, users, cfgPath := wizardTLSHandler(t, cert, key)
	if code, body := postWizard(t, handler, map[string]any{"tls_mode": "manual"}); code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", code, body)
	}
	if n := users(); n != 1 {
		t.Errorf("user count = %d, want 1", n)
	}
	raw, err := os.ReadFile(cfgPath) //nolint:gosec // G304: the test's own temp file
	if err != nil || !strings.Contains(string(raw), "manual") {
		t.Errorf("config.yaml = %q (%v), want tls mode manual", raw, err)
	}
}
