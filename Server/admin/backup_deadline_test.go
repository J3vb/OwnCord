package admin_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

// slowAdminServer serves h on a real http.Server whose WriteTimeout is far
// shorter than the work the hold simulates, as the production 30 s one is
// shorter than a big database's backup.
func slowAdminServer(t *testing.T, h http.Handler, writeTimeout time.Duration) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(h)
	srv.Config.WriteTimeout = writeTimeout
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

func postWithToken(t *testing.T, url, token string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v (the connection was cut before the response)", url, err)
	}
	defer res.Body.Close() //nolint:errcheck
	var sb strings.Builder
	buf := make([]byte, 512)
	for {
		n, rerr := res.Body.Read(buf)
		sb.Write(buf[:n])
		if rerr != nil {
			break
		}
	}
	return res.StatusCode, sb.String()
}

// A manual backup that takes longer than the server's WriteTimeout still
// answers 200 to the admin who asked for it.
func TestManualBackup_OutlivesWriteTimeout(t *testing.T) {
	f := newBackupsPermFixture(t)
	admin.SetBackupHoldForTest(f.api, func() { time.Sleep(700 * time.Millisecond) })
	srv := slowAdminServer(t, f.api, 300*time.Millisecond)

	status, body := postWithToken(t, srv.URL+"/backup", f.owner)
	if status != http.StatusOK {
		t.Fatalf("POST /backup = %d, want 200; body: %s", status, body)
	}
	var got struct{ Path string }
	if err := json.Unmarshal([]byte(body), &got); err != nil || got.Path == "" {
		t.Fatalf("response %q has no backup path: %v", body, err)
	}
}

// A restore whose work outlasts the WriteTimeout still gets its response
// before the restart.
func TestRestore_OutlivesWriteTimeout(t *testing.T) {
	f := newFileRestoreFixture(t)
	api, ok := f.handler.(*admin.AdminAPI)
	if !ok {
		t.Fatalf("handler is %T, want *admin.AdminAPI", f.handler)
	}
	admin.SetBackupHoldForTest(api, func() { time.Sleep(700 * time.Millisecond) })
	_, restoreHook := admin.StubRestart()
	defer restoreHook()
	srv := slowAdminServer(t, f.handler, 300*time.Millisecond)

	status, body := postWithToken(t, srv.URL+"/backups/"+f.backupName+"/restore", f.token)
	if status != http.StatusOK {
		t.Fatalf("POST restore = %d, want 200; body: %s", status, body)
	}
	if _, err := os.Stat(f.dbPath + ".restore-pending.json"); err != nil {
		t.Errorf("restore response arrived but no marker was staged: %v", err)
	}
}
