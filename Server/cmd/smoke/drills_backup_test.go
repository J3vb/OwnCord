package main

import (
	"archive/zip"
	"encoding/base32"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestTOTPCode_RFC6238Vectors holds the drill's own generator to the RFC's SHA-1 vectors (the RFC lists eight
// digits; the server uses the last six).
func TestTOTPCode_RFC6238Vectors(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	vectors := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}
	for _, v := range vectors {
		got, err := totpCode(secret, time.Unix(v.unix, 0))
		if err != nil {
			t.Fatalf("totpCode at %d: %v", v.unix, err)
		}
		if got != v.want {
			t.Errorf("totpCode at %d = %s, want %s", v.unix, got, v.want)
		}
	}
}

func TestNextFreshTOTPStep(t *testing.T) {
	const last = int64(1000)
	stepStart := time.Unix(last*totpPeriodSeconds, 0)
	tests := []struct {
		name string
		now  time.Time
		want time.Duration
	}{
		{"at the start of the used step", stepStart, totpPeriodSeconds * time.Second},
		{"inside the used step", stepStart.Add(12 * time.Second), 18 * time.Second},
		{"at the start of the next step", stepStart.Add(totpPeriodSeconds * time.Second), 0},
		{"inside the next step", stepStart.Add(40 * time.Second), 0},
		{"well after", stepStart.Add(time.Hour), 0},
	}
	for _, tt := range tests {
		if got := nextFreshTOTPStep(last, tt.now); got != tt.want {
			t.Errorf("%s: waits %s, want %s", tt.name, got, tt.want)
		}
	}
}

func TestSecretFromURI(t *testing.T) {
	got, err := secretFromURI("otpauth://totp/OwnCord:me?secret=ABC234&issuer=OwnCord")
	if err != nil || got != "ABC234" {
		t.Fatalf("secretFromURI = %q, %v, want ABC234", got, err)
	}
	if _, err := secretFromURI("otpauth://totp/OwnCord:me?issuer=OwnCord"); err == nil {
		t.Fatal("a URI with no secret was accepted")
	}
}

// writeZip builds an archive from name to content; a name ending in a slash is a directory entry.
func writeZip(t *testing.T, entries map[string]string) string {
	t.Helper()
	zipPath := filepath.Join(t.TempDir(), "archive.zip")
	f, err := os.Create(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	w := zip.NewWriter(f)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		fw, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write([]byte(entries[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return zipPath
}

func coreEntries() map[string]string {
	return map[string]string{
		"data/chatserver.db":      "db",
		"data/totp.key":           "totp",
		"data/erasure.key":        "erasure",
		"data/uploads/abc":        "upload",
		"data/erasure/markers.db": "markers",
		"config.yaml":             "config",
	}
}

func TestUnpackArchive_PutsDataAndConfigBack(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "restored")
	if err := unpackArchive(writeZip(t, coreEntries()), dest, nil); err != nil {
		t.Fatalf("unpackArchive: %v", err)
	}
	for name, want := range coreEntries() {
		got, err := os.ReadFile(filepath.Join(dest, filepath.FromSlash(name)))
		if err != nil || string(got) != want {
			t.Errorf("%s = %q, %v, want %q", name, got, err, want)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	for _, name := range []string{"data/totp.key", "config.yaml", "data", "data/uploads"} {
		info, err := os.Stat(filepath.Join(dest, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm&0o077 != 0 {
			t.Errorf("%s has mode %o, want owner-only", name, perm)
		}
	}
}

func TestUnpackArchive_HidesStrippedEntry(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "restored")
	if err := unpackArchive(writeZip(t, coreEntries()), dest, stripTOTPKey); err != nil {
		t.Fatalf("unpackArchive: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dest, "data", "totp.key")); !os.IsNotExist(err) {
		t.Errorf("data/totp.key is there after the strip, stat error %v", err)
	}
	for name := range coreEntries() {
		if name == "data/totp.key" {
			continue
		}
		if _, err := os.Stat(filepath.Join(dest, filepath.FromSlash(name))); err != nil {
			t.Errorf("%s was dropped with the key: %v", name, err)
		}
	}
}

func TestUnpackArchive_RefusesUnsafeNames(t *testing.T) {
	for _, name := range []string{"../x", "/abs/x", "data/../../x", `data\..\x`} {
		root := t.TempDir()
		dest := filepath.Join(root, "inner", "restored")
		entries := coreEntries()
		entries[name] = "evil"
		err := unpackArchive(writeZip(t, entries), dest, nil)
		if err == nil || !strings.Contains(err.Error(), "outside the install") {
			t.Errorf("%q: unpackArchive = %v, want a refusal naming the entry", name, err)
		}
		var written []string
		_ = filepath.WalkDir(root, func(p string, _ os.DirEntry, _ error) error {
			written = append(written, p)
			return nil
		})
		if len(written) != 1 {
			t.Errorf("%q: something was written: %v", name, written)
		}
	}
}

func TestUnpackArchive_NamesMissingCoreFile(t *testing.T) {
	for _, missing := range archiveCoreFiles {
		entries := coreEntries()
		delete(entries, missing)
		err := unpackArchive(writeZip(t, entries), filepath.Join(t.TempDir(), "restored"), nil)
		if err == nil || !strings.Contains(err.Error(), missing) {
			t.Errorf("without %s: unpackArchive = %v, want an error naming it", missing, err)
		}
	}
}

func TestRestoredConfigReachesOldInstall(t *testing.T) {
	old := "/srv/owncord-drill/source"
	tests := []struct {
		name  string
		files map[string]string
		want  []string
	}{
		{"relative paths", map[string]string{"config.yaml": "data_dir: data\ncert: data/cert.pem\n"}, nil},
		{"no overrides file", map[string]string{"config.yaml": "port: 8443\n"}, nil},
		{"the yaml names it", map[string]string{"config.yaml": "data_dir: " + old + "/data\n"}, []string{"config.yaml"}},
		{"the overrides name it", map[string]string{
			"config.yaml":                "port: 8443\n",
			"data/config-overrides.json": `{"backup_dir": "` + old + `/backups"}`,
		}, []string{"data/config-overrides.json"}},
	}
	for _, tt := range tests {
		root := t.TempDir()
		for name, body := range tt.files {
			full := filepath.Join(root, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		got, err := configFilesNaming(root, filepath.FromSlash(old))
		if err != nil || !slices.Equal(got, tt.want) {
			t.Errorf("%s: configFilesNaming = %v, %v, want %v", tt.name, got, err, tt.want)
		}
	}
}

func TestPhaseBRefusesInheritedKeyEnv(t *testing.T) {
	for _, name := range keyEnvNames {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "00")
			d := &drill{}
			// bin is empty: reaching a boot would fail differently, and the refusal must come first.
			err := d.phaseB()
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("phaseB = %v, want a refusal naming %s", err, name)
			}
		})
	}
}

func TestNegativeLegVerdict(t *testing.T) {
	tests := []struct {
		name                                  string
		bootRefused, signedIn, sawDecryptLine bool
		wantErr                               string
	}{
		{"the sign-in still worked", false, true, false, "proves nothing"},
		{"the boot was refused", true, false, false, "did not boot"},
		{"verify refused with the decryption line", false, false, true, ""},
		{"verify refused without the line", false, false, false, "no \"TOTP secret decryption failed\" line"},
	}
	for _, tt := range tests {
		err := classifyNegativeLeg(tt.bootRefused, tt.signedIn, tt.sawDecryptLine)
		switch {
		case tt.wantErr == "" && err != nil:
			t.Errorf("%s: %v, want a pass", tt.name, err)
		case tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)):
			t.Errorf("%s: %v, want a failure naming %q", tt.name, err, tt.wantErr)
		}
	}
}

func TestFirstFullArchive(t *testing.T) {
	entries := []backupListEntry{{Name: "a.db", Kind: "database"}, {Name: "scheduled_1.zip", Kind: "full"}}
	if name, ok := firstFullArchive(entries); !ok || name != "scheduled_1.zip" {
		t.Errorf("firstFullArchive = %q, %t", name, ok)
	}
	if _, ok := firstFullArchive(entries[:1]); ok {
		t.Error("a database backup was taken for a full archive")
	}
}
