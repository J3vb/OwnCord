package archivebin

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fuzzCap = 1 << 16

// fuzzEntries turns fuzzed names into archive entries: one per line, '@'
// first makes a symlink and '/' last a folder.
func fuzzEntries(names string, body []byte) []entry {
	var out []entry
	for i, n := range strings.Split(names, "\n") {
		if i >= 16 || n == "" {
			continue
		}
		e := entry{name: n, body: body}
		if rest, ok := strings.CutPrefix(n, "@"); ok {
			e.name, e.link = rest, true
		} else if rest, ok := strings.CutSuffix(n, "/"); ok && rest != "" {
			e.name, e.dir = rest, true
		}
		out = append(out, e)
	}
	return out
}

// fuzzCheck runs one extraction in its own directory and checks what it left:
// on success exactly one regular file at dest whose hash is the one returned
// and whose size is inside the cap; on failure nothing at all. No other file
// ever appears in the directory.
func fuzzCheck(t *testing.T, run func(dest string) (string, error)) {
	t.Helper()
	dir := t.TempDir()
	dest := filepath.Join(dir, "out")
	sum, err := run(dest)
	entries, readErr := os.ReadDir(dir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if err != nil {
		if len(entries) != 0 {
			t.Fatalf("failed extraction (%v) left %d files behind", err, len(entries))
		}
		return
	}
	if len(entries) != 1 || entries[0].Name() != "out" {
		t.Fatalf("extraction left %v, want only out", entries)
	}
	info, statErr := os.Lstat(dest)
	if statErr != nil || !info.Mode().IsRegular() {
		t.Fatalf("dest is not a regular file: %v %v", info, statErr)
	}
	if info.Size() > fuzzCap {
		t.Fatalf("dest holds %d bytes, over the %d cap", info.Size(), fuzzCap)
	}
	got, _ := os.ReadFile(dest)
	if sumOf(got) != sum {
		t.Fatalf("returned hash %s is not the hash of the written file", sum)
	}
}

func fuzzErrOK(t *testing.T, err error) {
	t.Helper()
	if err != nil && errors.Is(err, fs.ErrExist) {
		t.Fatalf("a fresh dest reported fs.ErrExist: %v", err)
	}
}

// FuzzFromTarGz extracts from tar.gz archives built from fuzzed entry names
// and from raw fuzzed bytes.
func FuzzFromTarGz(f *testing.F) {
	f.Add("LICENSE\nbin", []byte("binary"), []byte(nil))
	f.Add("@bin\nbin", []byte("/etc/passwd"), []byte(nil))
	f.Add("../bin\nbin/\nx/bin", []byte("x"), []byte(nil))
	f.Add("bin", bytes.Repeat([]byte("z"), fuzzCap+1), []byte(nil))
	f.Add("", []byte(nil), []byte("\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"))
	f.Fuzz(func(t *testing.T, names string, body, raw []byte) {
		var archives [][]byte
		if a, err := buildTarGz(fuzzEntries(names, body)...); err == nil {
			archives = append(archives, a)
		}
		if len(raw) > 0 {
			archives = append(archives, raw)
		}
		for _, a := range archives {
			fuzzCheck(t, func(dest string) (string, error) {
				sum, err := FromTarGz(bytes.NewReader(a), dest, isBin, fuzzCap)
				fuzzErrOK(t, err)
				return sum, err
			})
		}
	})
}

// FuzzFromZip extracts from zips built from fuzzed entry names and from raw
// fuzzed bytes.
func FuzzFromZip(f *testing.F) {
	f.Add("LICENSE\nbin", []byte("binary"), []byte(nil))
	f.Add("@bin\nbin", []byte("/etc/passwd"), []byte(nil))
	f.Add("../bin\nbin/\nx/bin", []byte("x"), []byte(nil))
	f.Add("bin", bytes.Repeat([]byte("z"), fuzzCap+1), []byte(nil))
	f.Add("", []byte(nil), []byte("PK\x05\x06"+strings.Repeat("\x00", 18)))
	f.Fuzz(func(t *testing.T, names string, body, raw []byte) {
		var archives [][]byte
		if a, err := buildZip(fuzzEntries(names, body)...); err == nil {
			archives = append(archives, a)
		}
		if len(raw) > 0 {
			archives = append(archives, raw)
		}
		for _, a := range archives {
			fuzzCheck(t, func(dest string) (string, error) {
				sum, err := FromZip(bytes.NewReader(a), int64(len(a)), dest, isBin, fuzzCap)
				fuzzErrOK(t, err)
				return sum, err
			})
		}
	})
}
