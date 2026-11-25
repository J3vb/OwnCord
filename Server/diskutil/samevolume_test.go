package diskutil

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// fakeVolumes answers volumeProbe.id from a table of existing paths and their volume ids, as the operating
// system would; any path not in the table does not exist.
func fakeVolumes(ids map[string]string) func(string) (string, error) {
	return func(path string) (string, error) {
		if id, ok := ids[path]; ok {
			return id, nil
		}
		return "", fmt.Errorf("stat %s: %w", path, fs.ErrNotExist)
	}
}

func TestSameVolume_UnixDeviceIDs(t *testing.T) {
	p := volumeProbe{
		id: fakeVolumes(map[string]string{
			"/":                     "dev-1",
			"/srv/owncord/data":     "dev-1",
			"/mnt/backup":           "dev-7",
			"/srv/owncord":          "dev-1",
			"/srv":                  "dev-1",
			"/srv/owncord/data/bak": "dev-1",
		}),
		parent: filepath.Dir,
	}
	for _, tc := range []struct {
		name, a, b string
		want       bool
	}{
		{"same device", "/srv/owncord/data/bak", "/srv/owncord/data", true},
		{"another device", "/mnt/backup", "/srv/owncord/data", false},
		{"missing backup folder is judged by its parent", "/srv/owncord/data/backups-not-yet", "/srv/owncord/data", true},
		{"missing folder on another device", "/mnt/backup/new/deeper", "/srv/owncord/data", false},
	} {
		got, err := sameVolume(tc.a, tc.b, p)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got != tc.want {
			t.Errorf("%s: sameVolume(%s, %s) = %v, want %v", tc.name, tc.a, tc.b, got, tc.want)
		}
	}
}

// Windows paths: the id is the volume serial, so two drive letters on one volume agree and a path that does
// not exist yet is judged by its nearest existing parent. The parent step is the Windows one, so the case
// runs on any host.
func TestSameVolume_WindowsPaths(t *testing.T) {
	winParent := func(p string) string {
		i := strings.LastIndex(p, `\`)
		switch {
		case i < 0 || len(p) <= 3: // `C:\` is the root
			return p
		case i == 2:
			return p[:3]
		}
		return p[:i]
	}
	p := volumeProbe{
		id: fakeVolumes(map[string]string{
			`C:\`:               "serial-a",
			`C:\OwnCord\data`:   "serial-a",
			`D:\`:               "serial-b",
			`E:\mounted\folder`: "serial-a", // another letter, the same volume
			`E:\mounted`:        "serial-a",
		}),
		parent: winParent,
	}
	for _, tc := range []struct {
		name, a, b string
		want       bool
	}{
		{"same drive", `C:\OwnCord\backups`, `C:\OwnCord\data`, true},
		{"another drive", `D:\backups\owncord`, `C:\OwnCord\data`, false},
		{"another letter on the same volume", `E:\mounted\folder`, `C:\OwnCord\data`, true},
	} {
		got, err := sameVolume(tc.a, tc.b, p)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got != tc.want {
			t.Errorf("%s: sameVolume(%s, %s) = %v, want %v", tc.name, tc.a, tc.b, got, tc.want)
		}
	}
}

// A failure that is not "missing" is an unknown answer, never read as "different disks".
func TestSameVolume_ErrorIsUnknown(t *testing.T) {
	boom := errors.New("permission denied")
	p := volumeProbe{
		id:     func(string) (string, error) { return "", boom },
		parent: filepath.Dir,
	}
	if got, err := sameVolume("/a", "/b", p); err == nil || got || !errors.Is(err, boom) {
		t.Errorf("sameVolume = %v, %v; want false and the probe's error", got, err)
	}
	// Nothing exists all the way up: unknown too.
	p = volumeProbe{id: fakeVolumes(nil), parent: filepath.Dir}
	if _, err := sameVolume("/a/b", "/c", p); err == nil {
		t.Error("sameVolume with no existing parent: no error")
	}
}

// The real probe, on one temp tree: two folders under it, one not made yet, share a volume.
func TestSameVolume_RealTempDir(t *testing.T) {
	root := t.TempDir()
	same, err := SameVolume(filepath.Join(root, "not", "made", "yet"), root)
	if errors.Is(err, ErrUnsupported) {
		t.Skip("no volume probe on this platform")
	}
	if err != nil {
		t.Fatalf("SameVolume: %v", err)
	}
	if !same {
		t.Error("a folder under a directory is on a different volume from it")
	}
}
