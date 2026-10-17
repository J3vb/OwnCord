package main

import (
	"bytes"
	"crypto/sha256"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// configFixture is a config.yaml plus the data directory and database path it
// names, all under one temp dir, so no test touches the working directory.
type configFixture struct {
	dir, cfgPath, dataDir, dbPath, overridesPath string
}

func newConfigFixture(t *testing.T) configFixture {
	t.Helper()
	dir := t.TempDir()
	f := configFixture{
		dir:     dir,
		cfgPath: filepath.Join(dir, "config.yaml"),
		dataDir: filepath.Join(dir, "data"),
		dbPath:  filepath.Join(dir, "data", "chatserver.db"),
	}
	f.overridesPath = config.OverridesPath(f.dataDir)
	if err := os.MkdirAll(f.dataDir, 0o750); err != nil {
		t.Fatal(err)
	}
	body := "server:\n  data_dir: " + filepath.ToSlash(f.dataDir) + "\ndatabase:\n  path: " + filepath.ToSlash(f.dbPath) + "\n"
	if err := os.WriteFile(f.cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f configFixture) seed(t *testing.T, values map[string]any) {
	t.Helper()
	if err := config.SaveOverrides(f.overridesPath, values); err != nil {
		t.Fatalf("seeding overrides: %v", err)
	}
}

func (f configFixture) run(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code = configCLI(&out, &errOut, f.cfgPath, args)
	return code, out.String(), errOut.String()
}

func (f configFixture) saved(t *testing.T) map[string]any {
	t.Helper()
	got, err := config.ReadOverrides(f.overridesPath)
	if err != nil {
		t.Fatalf("ReadOverrides: %v", err)
	}
	return got
}

func fileHash(t *testing.T, path string) [32]byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(raw)
}

func holdLock(t *testing.T, dbPath string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o750); err != nil {
		t.Fatal(err)
	}
	release, err := db.AcquireProcessLock(dbPath)
	if err != nil {
		t.Fatalf("AcquireProcessLock: %v", err)
	}
	t.Cleanup(release)
}

// lockoutKeys is every panel-editable key that needs the typed confirmation.
func lockoutKeys() []string {
	var out []string
	for _, key := range config.EditableKeys() {
		if config.RequiresConfirmation(key) {
			out = append(out, key)
		}
	}
	return out
}

func TestConfigCLI_ResetDefaultRemovesExactlyLockoutKeys(t *testing.T) {
	f := newConfigFixture(t)
	alt := filepath.Join(f.dir, "alt")
	if err := os.MkdirAll(alt, 0o750); err != nil {
		t.Fatal(err)
	}
	f.seed(t, map[string]any{
		"backup.dir":                 filepath.Join(alt, "backups"),
		"database.path":              f.dbPath,
		"plugins.directory":          filepath.Join(alt, "plugins"),
		"server.admin_allowed_cidrs": []string{"203.0.113.0/24"},
		"server.port":                9443,
		"server.restart_mode":        "supervised",
		"server.trusted_proxies":     []string{"203.0.113.9/32"},
		"tls.acme_cache_dir":         filepath.Join(alt, "acme"),
		"tls.cert_file":              filepath.Join(alt, "cert.pem"),
		"tls.domain":                 "chat.example.com",
		"tls.key_file":               filepath.Join(alt, "key.pem"),
		"tls.mode":                   "manual",
		"upload.storage_dir":         filepath.Join(alt, "uploads"),
		"voice.livekit_binary":       filepath.Join(alt, "livekit-server"),
		// Not lockout keys: tuning and a write-only secret.
		"upload.max_size_mb":       50,
		"voice.livekit_api_secret": strings.Repeat("k", 40),
	})
	want := lockoutKeys()
	if len(want) != 14 {
		t.Fatalf("lockout key set has %d keys, want 14: %v", len(want), want)
	}
	if got := f.saved(t); len(got) != len(want)+2 {
		t.Fatalf("seeded %d keys, want %d", len(got), len(want)+2)
	}

	code, stdout, stderr := f.run(t, "reset-overrides")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	left := f.saved(t)
	if len(left) != 2 || left["upload.max_size_mb"] != 50 || left["voice.livekit_api_secret"] == nil {
		t.Fatalf("tuning key and secret must stay, got keys %v", sortedKeys(left))
	}
	for _, key := range want {
		if _, ok := left[key]; ok {
			t.Errorf("%s still saved", key)
		}
		if !strings.Contains(stdout, "  "+key+"\n") {
			t.Errorf("stdout does not name removed key %s", key)
		}
	}
	if strings.Contains(stdout, "upload.max_size_mb") || strings.Contains(stdout, "voice.livekit_api_secret") {
		t.Error("stdout names a key that was not removed")
	}
	info, err := os.Stat(f.overridesPath)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("overrides mode = %o, want 600", info.Mode().Perm())
	}
}

// Resetting the admin allowlist returns to the default private ranges, never
// to an empty list that config.yaml did not ask for.
func TestConfigCLI_ResetAllowlistFallsBackToDefaultList(t *testing.T) {
	f := newConfigFixture(t)
	f.seed(t, map[string]any{"server.admin_allowed_cidrs": []string{"203.0.113.0/24"}})

	before, err := config.Preview(f.cfgPath, f.overridesPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(before.Server.AdminAllowedCIDRs, []string{"203.0.113.0/24"}) {
		t.Fatalf("seed not in effect: %v", before.Server.AdminAllowedCIDRs)
	}

	if code, _, stderr := f.run(t, "reset-overrides", "server.admin_allowed_cidrs"); code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	after, err := config.Preview(f.cfgPath, f.overridesPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	base, err := config.BaseConfig(f.cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Server.AdminAllowedCIDRs) == 0 {
		t.Fatal("allowlist is empty after reset")
	}
	if !slices.Equal(after.Server.AdminAllowedCIDRs, base.Server.AdminAllowedCIDRs) ||
		!slices.Contains(after.Server.AdminAllowedCIDRs, "127.0.0.0/8") ||
		!slices.Contains(after.Server.AdminAllowedCIDRs, "192.168.0.0/16") {
		t.Fatalf("allowlist after reset = %v, want the default private ranges", after.Server.AdminAllowedCIDRs)
	}
}

func TestConfigCLI_ResetNamedKeys(t *testing.T) {
	f := newConfigFixture(t)
	f.seed(t, map[string]any{
		"server.port":        9443,
		"upload.max_size_mb": 50,
		"voice.quality":      "high",
	})

	code, stdout, stderr := f.run(t, "reset-overrides", "upload.max_size_mb", "logging.level")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	if got := sortedKeys(f.saved(t)); !slices.Equal(got, []string{"server.port", "voice.quality"}) {
		t.Fatalf("saved keys = %v", got)
	}
	if !strings.Contains(stdout, "not saved in the overrides file: logging.level") {
		t.Errorf("stdout does not report the absent key: %s", stdout)
	}

	// A key the panel cannot edit, or an unknown one, is a usage error and the
	// file stays as it was.
	hash := fileHash(t, f.overridesPath)
	for _, bad := range []string{"server.data_dir", "no.such_key", "server.name"} {
		code, _, stderr := f.run(t, "reset-overrides", "voice.quality", bad)
		if code != 2 {
			t.Errorf("%s: exit %d, want 2 (stderr: %s)", bad, code, stderr)
		}
		if fileHash(t, f.overridesPath) != hash {
			t.Errorf("%s: overrides file changed", bad)
		}
	}
}

func TestConfigCLI_UsageErrorsExitTwo(t *testing.T) {
	f := newConfigFixture(t)
	f.seed(t, map[string]any{"server.port": 9443})
	hash := fileHash(t, f.overridesPath)
	for _, args := range [][]string{
		nil,
		{"unknown"},
		{"reset-overrides", "--bogus"},
		{"reset-overrides", "--all", "server.port"},
	} {
		if code, _, _ := f.run(t, args...); code != 2 {
			t.Errorf("args %v: exit %d, want 2", args, code)
		}
	}
	if fileHash(t, f.overridesPath) != hash {
		t.Error("overrides file changed on a usage error")
	}
}

func TestConfigCLI_ResetAllRemovesFile(t *testing.T) {
	f := newConfigFixture(t)
	f.seed(t, map[string]any{"server.port": 9443, "upload.max_size_mb": 50})

	code, stdout, stderr := f.run(t, "reset-overrides", "--all")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	if _, err := os.Stat(f.overridesPath); !os.IsNotExist(err) {
		t.Fatalf("overrides file still exists (stat err %v)", err)
	}
	for _, key := range []string{"server.port", "upload.max_size_mb"} {
		if !strings.Contains(stdout, key) {
			t.Errorf("stdout does not name %s", key)
		}
	}
}

func TestConfigCLI_ResetAllMovesUnparseableFileAside(t *testing.T) {
	f := newConfigFixture(t)
	body := []byte("{\"voice.livekit_api_secret\": \"" + strings.Repeat("z", 40) + "\", ")
	if err := os.WriteFile(f.overridesPath, body, 0o644); err != nil { //nolint:gosec // widened on purpose: the command must tighten it
		t.Fatal(err)
	}

	code, stdout, stderr := f.run(t, "reset-overrides", "--all")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	if _, err := os.Stat(f.overridesPath); !os.IsNotExist(err) {
		t.Fatalf("original file still in place (stat err %v)", err)
	}
	matches, err := filepath.Glob(f.overridesPath + ".unreadable-*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("aside files = %v (err %v), want exactly one", matches, err)
	}
	got, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, body) {
		t.Error("the renamed file does not keep its bytes")
	}
	info, err := os.Stat(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("aside mode = %o, want 600", info.Mode().Perm())
	}
	if !strings.Contains(stdout, filepath.Base(matches[0])) {
		t.Errorf("stdout does not name the aside file: %s", stdout)
	}
}

func TestConfigCLI_RefusesUnparseableWithoutAll(t *testing.T) {
	f := newConfigFixture(t)
	if err := os.WriteFile(f.overridesPath, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	hash := fileHash(t, f.overridesPath)

	for _, args := range [][]string{
		{"reset-overrides"},
		{"reset-overrides", "server.port"},
	} {
		code, _, stderr := f.run(t, args...)
		if code != 1 {
			t.Errorf("args %v: exit %d, want 1", args, code)
		}
		if !strings.Contains(stderr, "--all") {
			t.Errorf("args %v: message does not point at --all: %s", args, stderr)
		}
	}
	if fileHash(t, f.overridesPath) != hash {
		t.Error("unparseable file was modified")
	}
}

func TestConfigCLI_RefusesWhileProcessLockHeld(t *testing.T) {
	f := newConfigFixture(t)
	f.seed(t, map[string]any{"server.port": 9443, "upload.max_size_mb": 50})
	hash := fileHash(t, f.overridesPath)
	holdLock(t, f.dbPath)

	for _, args := range [][]string{
		{"reset-overrides"},
		{"reset-overrides", "upload.max_size_mb"},
		{"reset-overrides", "--all"},
	} {
		code, _, stderr := f.run(t, args...)
		if code != 1 {
			t.Errorf("args %v: exit %d, want 1", args, code)
		}
		if !strings.Contains(stderr, "stop the server first") {
			t.Errorf("args %v: stderr = %q", args, stderr)
		}
		if fileHash(t, f.overridesPath) != hash {
			t.Errorf("args %v: overrides file changed while the lock was held", args)
		}
	}
}

func TestConfigCLI_LocksOverriddenDatabasePath(t *testing.T) {
	f := newConfigFixture(t)
	moved := filepath.Join(f.dir, "moved", "chatserver.db")
	f.seed(t, map[string]any{"database.path": moved, "upload.max_size_mb": 50})
	hash := fileHash(t, f.overridesPath)
	holdLock(t, moved)

	code, _, stderr := f.run(t, "reset-overrides")
	if code != 1 || !strings.Contains(stderr, "stop the server first") {
		t.Fatalf("exit %d, stderr %q; want a refusal on the overridden path", code, stderr)
	}
	if fileHash(t, f.overridesPath) != hash {
		t.Error("overrides file changed")
	}
}

func TestConfigCLI_OutputNeverCarriesValues(t *testing.T) {
	const secret = "sekret-value-0123456789-abcdefghijklmnop"
	const cidr = "203.0.113.77/32"
	f := newConfigFixture(t)
	seedAll := func() {
		f.seed(t, map[string]any{
			"voice.livekit_api_secret":   secret,
			"server.admin_allowed_cidrs": []string{cidr},
			"server.trusted_proxies":     []string{cidr},
			"upload.max_size_mb":         50,
		})
	}

	for _, args := range [][]string{
		{"reset-overrides"},
		{"reset-overrides", "voice.livekit_api_secret", "upload.max_size_mb"},
		{"reset-overrides", "--all"},
	} {
		seedAll()
		code, stdout, stderr := f.run(t, args...)
		if code != 0 {
			t.Fatalf("args %v: exit %d, stderr: %s", args, code, stderr)
		}
		// Paths are printed and the temp directory name is random digits, so
		// it is cut out before looking for the numeric value.
		out := strings.ReplaceAll(stdout+stderr, f.dir, "")
		out = strings.ReplaceAll(out, filepath.ToSlash(f.dir), "")
		for _, leaked := range []string{secret, cidr, "50"} {
			if strings.Contains(out, leaked) {
				t.Errorf("args %v: output carries a value (%q)", args, leaked)
			}
		}
		_ = os.Remove(f.overridesPath)
	}

	// The unreadable-file paths must not echo the file either.
	body := []byte("{\"voice.livekit_api_secret\": \"" + secret + "\" oops")
	if err := os.WriteFile(f.overridesPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	_, stdout, stderr := f.run(t, "reset-overrides")
	if strings.Contains(stdout+stderr, secret) {
		t.Error("refusal output carries the file content")
	}
	_, stdout, stderr = f.run(t, "reset-overrides", "--all")
	if strings.Contains(stdout+stderr, secret) {
		t.Error("--all output carries the file content")
	}
}

func TestConfigCLI_DoesNotCreateConfigYAML(t *testing.T) {
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OWNCORD_SERVER_DATA_DIR", dataDir)
	t.Setenv("OWNCORD_DATABASE_PATH", filepath.Join(dataDir, "chatserver.db"))
	cfgPath := filepath.Join(dir, "config.yaml")

	run := func(args ...string) int {
		var out, errOut bytes.Buffer
		return configCLI(&out, &errOut, cfgPath, args)
	}
	if code := run("reset-overrides"); code != 0 {
		t.Fatalf("no overrides file: exit %d", code)
	}
	if err := config.SaveOverrides(config.OverridesPath(dataDir), map[string]any{"server.port": 9443}); err != nil {
		t.Fatal(err)
	}
	if code := run("reset-overrides"); code != 0 {
		t.Fatalf("with overrides file: exit %d", code)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Fatalf("config.yaml was created (stat err %v)", err)
	}
}

func TestConfigCLI_HonoursDataDirEnv(t *testing.T) {
	f := newConfigFixture(t)
	f.seed(t, map[string]any{"server.port": 9443})
	envDir := filepath.Join(f.dir, "env-data")
	if err := os.MkdirAll(envDir, 0o750); err != nil {
		t.Fatal(err)
	}
	envOverrides := config.OverridesPath(envDir)
	if err := config.SaveOverrides(envOverrides, map[string]any{"server.port": 9444}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OWNCORD_SERVER_DATA_DIR", envDir)
	t.Setenv("OWNCORD_DATABASE_PATH", filepath.Join(envDir, "chatserver.db"))

	if code, _, stderr := f.run(t, "reset-overrides"); code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	got, err := config.ReadOverrides(envOverrides)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("the env data_dir file still holds %v", got)
	}
	if left := f.saved(t); left["server.port"] != 9443 {
		t.Errorf("the config.yaml data_dir file was touched: %v", left)
	}
}

func TestConfigCLI_MissingDatabaseDirectoryCountsAsNoHolder(t *testing.T) {
	f := newConfigFixture(t)
	gone := filepath.Join(f.dir, "vanished", "deeper", "chatserver.db")
	f.seed(t, map[string]any{"database.path": gone, "server.port": 9443})

	code, _, stderr := f.run(t, "reset-overrides")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	if left := f.saved(t); len(left) != 0 {
		t.Fatalf("keys still saved: %v", sortedKeys(left))
	}
}

// A running server holds the lock at the path it booted with (the base path);
// a panel save of a new database.path only takes effect at the next restart.
func TestConfigCLI_SameDatabaseNamedTwoWaysLocksOnce(t *testing.T) {
	f := newConfigFixture(t)
	t.Chdir(f.dir)
	f.seed(t, map[string]any{"database.path": filepath.Join("data", "chatserver.db"), "server.port": 9443})

	code, _, stderr := f.run(t, "reset-overrides")
	if code != 0 {
		t.Fatalf("exit %d, stderr: %s", code, stderr)
	}
	if left := f.saved(t); len(left) != 0 {
		t.Fatalf("keys still saved: %v", sortedKeys(left))
	}
}

func TestConfigCLI_RefusesWhenLockCannotBeTaken(t *testing.T) {
	f := newConfigFixture(t)
	if err := os.Mkdir(f.dbPath+".lock", 0o750); err != nil {
		t.Fatal(err)
	}
	f.seed(t, map[string]any{"server.port": 9443})
	before := fileHash(t, f.overridesPath)

	code, _, stderr := f.run(t, "reset-overrides")
	if code != 1 {
		t.Fatalf("exit %d, want 1; stderr: %s", code, stderr)
	}
	if fileHash(t, f.overridesPath) != before {
		t.Fatal("overrides file changed although the lock was not taken")
	}
}

func TestConfigCLI_RefusesWhileBasePathLockHeldAndPathMoved(t *testing.T) {
	f := newConfigFixture(t)
	moved := filepath.Join(f.dir, "moved", "chatserver.db")
	f.seed(t, map[string]any{"database.path": moved, "server.port": 9443})
	hash := fileHash(t, f.overridesPath)
	holdLock(t, f.dbPath)

	code, _, stderr := f.run(t, "reset-overrides")
	if code != 1 || !strings.Contains(stderr, "stop the server first") {
		t.Fatalf("exit %d, stderr %q; want a refusal on the base path", code, stderr)
	}
	if fileHash(t, f.overridesPath) != hash {
		t.Error("overrides file changed while the base path lock was held")
	}
}

func TestConfigCLI_AsideNameNeverOverwrites(t *testing.T) {
	f := newConfigFixture(t)
	for i := range 3 {
		body := []byte("not json " + strings.Repeat("x", i+1))
		if err := os.WriteFile(f.overridesPath, body, 0o600); err != nil {
			t.Fatal(err)
		}
		if code, _, stderr := f.run(t, "reset-overrides", "--all"); code != 0 {
			t.Fatalf("run %d: exit %d, stderr: %s", i, code, stderr)
		}
	}
	matches, err := filepath.Glob(f.overridesPath + ".unreadable-*")
	if err != nil || len(matches) != 3 {
		t.Fatalf("aside files = %v (err %v), want 3 distinct", matches, err)
	}
}

func TestConfigCLI_HelpPrintsUsageAndNamesCheckedPath(t *testing.T) {
	f := newConfigFixture(t)
	if code, _, stderr := f.run(t, "reset-overrides", "--help"); code != 0 || !strings.Contains(stderr, "usage: chatserver config reset-overrides") {
		t.Errorf("--help: exit %d, stderr %q", code, stderr)
	}
	code, stdout, _ := f.run(t, "reset-overrides")
	if code != 0 || !strings.Contains(stdout, f.overridesPath) {
		t.Errorf("exit %d, stdout %q; want the full overrides path", code, stdout)
	}
}
